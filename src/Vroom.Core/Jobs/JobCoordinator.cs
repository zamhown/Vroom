using System.Collections.Concurrent;
using System.Text.Json;
using Vroom.Core.Application;
using Vroom.Core.Domain;
using Vroom.Core.Storage;

namespace Vroom.Core.Jobs;

/// <summary>Durable admission scheduler. Queued and checkpoint-paused jobs own no worker slots.</summary>
public sealed class JobCoordinator(CatalogDatabase database, LocalDiagnostics? diagnostics = null)
    : IDisposable,
        IAsyncDisposable
{
    private readonly ConcurrentDictionary<string, JobInfo> records = new();
    private readonly ConcurrentDictionary<string, JobControl> controls = new();
    private readonly ConcurrentDictionary<string, JobHandler> handlers = new();
    private readonly SemaphoreSlim mutationGate = new(1, 1);
    private readonly SemaphoreSlim initializationGate = new(1, 1);
    private readonly SemaphoreSlim wake = new(0, 1);
    private readonly CancellationTokenSource lifetime = new();
    private bool initialized;
    private volatile bool shuttingDown;
    private FileStream? instanceLease;
    private readonly object shutdownGate = new();
    private Task? shutdown,
        dispatcher;
    public SchedulerPolicy Policy { get; private set; } = new();
    public event Action? Changed;
    public IReadOnlyList<JobInfo> Jobs => records.Values.OrderByDescending(j => j.Started).ToArray();

    public void Register(
        string kind,
        Func<JobContext, JsonElement, Task<object?>> execute,
        bool canPause = false,
        bool canStop = true,
        bool canRetry = false,
        bool usesWorker = true,
        string workerClass = "default",
        bool restartOnPause = false
    )
    {
        if (!handlers.TryAdd(kind, new(execute, canPause, canStop, canRetry, usesWorker, workerClass, restartOnPause)))
            throw new InvalidOperationException("host.JobCoordinator.taskTypeIsAlreadyRegistered").Localize(
                "host.JobCoordinator.taskTypeIsAlreadyRegistered",
                kind
            );
        Signal();
    }

    public async Task InitializeAsync()
    {
        await initializationGate.WaitAsync();
        try
        {
            if (initialized)
                return;
            if (shuttingDown)
                throw new InvalidOperationException("host.JobCoordinator.theAppIsShuttingDown");
            Directory.CreateDirectory(database.DataDirectory);
            try
            {
                instanceLease = new(
                    Path.Combine(database.DataDirectory, "tasks.lock"),
                    FileMode.OpenOrCreate,
                    FileAccess.ReadWrite,
                    FileShare.None
                );
            }
            catch (IOException ex)
            {
                throw new InvalidOperationException("host.JobCoordinator.anotherClientIsUsingThisCatalogClose", ex);
            }
            var saved = await database.RunAsync(db =>
            {
                if (db.Scalar("SELECT value FROM settings WHERE key='jobs.scheduler'") is string policy)
                    Policy = CatalogRepository.Deserialize<SchedulerPolicy>(policy);
                using var cmd = db.Command("SELECT payload FROM background_jobs ORDER BY updated");
                using var reader = cmd.ExecuteReader();
                var list = new List<JobInfo>();
                while (reader.Read())
                    list.Add(CatalogRepository.Deserialize<JobInfo>(reader.GetString(0)));
                return list;
            });
            foreach (var job in saved)
            {
                // Unstarted queued work survives shutdown. Interrupted execution requires an explicit retry.
                var restored = job.State is JobState.Running or JobState.Cancelling or JobState.Pausing
                    ? job with
                    {
                        State = JobState.Interrupted,
                        Detail = "host.JobCoordinator.thisTaskWasUnfinishedWhenTheApp",
                        Updated = DateTimeOffset.UtcNow,
                    }
                    : job;
                records[job.Id] = restored;
                Track(restored);
                if (restored != job)
                    await PersistAsync(restored, true);
            }
            initialized = true;
            dispatcher = Task.Run(DispatchLoopAsync);
        }
        catch
        {
            instanceLease?.Dispose();
            instanceLease = null;
            throw;
        }
        finally
        {
            initializationGate.Release();
        }
    }

    private static readonly AsyncLocal<string?> CurrentJob = new();

    public async Task<string> StartAsync(
        string kind,
        Vroom.Core.Application.UiMessage name,
        object? payload = null,
        string? resourceKey = null,
        JobSchedule? schedule = null,
        string? id = null
    )
    {
        await InitializeAsync();
        schedule ??= new();
        ValidateSchedule(schedule);
        if (!handlers.TryGetValue(kind, out var handler))
            throw new ArgumentException("host.JobCoordinator.unregisteredTaskType");
        await mutationGate.WaitAsync();
        try
        {
            if (shuttingDown)
                throw new InvalidOperationException("host.JobCoordinator.theAppIsShuttingDown");
            if (id is not null && records.TryGetValue(id, out var existing))
            {
                if (existing.Kind != kind || existing.Payload != CatalogRepository.Serialize(payload ?? new { }))
                    throw new InvalidOperationException("host.JobCoordinator.thisTaskIdempotencyKeyHasAlreadyBeen");
                return id;
            }
            EnsureResource(resourceKey);
            var job = new JobInfo(
                id ?? Guid.NewGuid().ToString("N"),
                name.Id,
                JobState.Queued,
                0,
                "host.JobCoordinator.waitingForScheduling",
                DateTimeOffset.UtcNow
            )
            {
                NameArgs = name.Args,
                Origin = TaskOrigin.Current.Value,
                ParentId = CurrentJob.Value,
                Kind = kind,
                Payload = CatalogRepository.Serialize(payload ?? new { }),
                ResourceKey = resourceKey,
                CanPause = handler.CanPause,
                CanStop = handler.CanStop,
                CanRetry = handler.CanRetry,
                WorkerClass = handler.WorkerClass,
                Priority = schedule.Priority,
                NotBefore = schedule.NotBefore,
            };
            await SaveAsync(job, true);
            return job.Id;
        }
        finally
        {
            mutationGate.Release();
            Signal();
            Notify();
        }
    }

    public async Task ConfigureAsync(SchedulerPolicy policy)
    {
        if (policy.MaxWorkers is < 1 or > 16 || policy.MaxEncoders < 1 || policy.MaxEncoders > policy.MaxWorkers)
            throw new ArgumentException("host.JobCoordinator.workerConcurrencyMustBe116Encoder");
        await InitializeAsync();
        await mutationGate.WaitAsync();
        try
        {
            await database.RunAsync(db =>
                db.Execute(
                    "INSERT INTO settings VALUES('jobs.scheduler',@value) ON CONFLICT(key) DO UPDATE SET value=@value",
                    ("@value", CatalogRepository.Serialize(policy))
                )
            );
            Policy = policy;
        }
        finally
        {
            mutationGate.Release();
            Signal();
            Notify();
        }
    }

    public async Task ScheduleAsync(string id, JobSchedule schedule)
    {
        ValidateSchedule(schedule);
        await mutationGate.WaitAsync();
        try
        {
            var job = Get(id);
            if (job.State is not (JobState.Queued or JobState.Paused))
                throw new InvalidOperationException("host.JobCoordinator.onlyQueuedOrPausedTasksCanBe");
            await SaveAsync(job with { Priority = schedule.Priority, NotBefore = schedule.NotBefore }, true);
        }
        finally
        {
            mutationGate.Release();
            Signal();
            Notify();
        }
    }

    private static void ValidateSchedule(JobSchedule schedule)
    {
        if (schedule.Priority is < -10 or > 10)
            throw new ArgumentException("host.JobCoordinator.priorityMustBeBetween10And10");
    }

    private void EnsureResource(string? key, string? except = null)
    {
        if (key is null)
            return;
        if (
            (activeResources.TryGetValue(key, out var owner) && owner != except)
            || controls.Keys.Any(id => id != except && records.TryGetValue(id, out var job) && job.ResourceKey == key)
        )
            throw new InvalidOperationException("host.JobCoordinator.anActiveTaskAlreadyUsesThisResource");
    }

    private async Task DispatchLoopAsync()
    {
        try
        {
            while (!lifetime.IsCancellationRequested)
            {
                await mutationGate.WaitAsync(lifetime.Token);
                try
                {
                    foreach (
                        var job in records
                            .Values.Where(j =>
                                j.State == JobState.Queued
                                && (j.NotBefore is null || j.NotBefore <= DateTimeOffset.UtcNow)
                            )
                            .OrderByDescending(j => j.Priority)
                            .ThenBy(j => j.Started)
                            .ThenBy(j => j.Id)
                    )
                    {
                        if (shuttingDown)
                            break;
                        if (!handlers.TryGetValue(job.Kind, out var handler))
                            continue;
                        // Interactive playback is deliberately exempt from background queue admission.
                        if (
                            handler.UsesWorker
                            && (
                                Policy.Paused
                                || controls.Values.Count(c => c.HasSlot && c.UsesWorker) >= Policy.MaxWorkers
                                || handler.WorkerClass == "encoding"
                                    && controls.Values.Count(c => c.HasSlot && c.WorkerClass == "encoding")
                                        >= Policy.MaxEncoders
                            )
                        )
                            continue;
                        if (controls.TryGetValue(job.Id, out var waiting))
                        {
                            if (!waiting.WaitingForSlot)
                                continue;
                            waiting.HasSlot = true;
                            waiting.WaitingForSlot = false;
                            await SaveAsync(
                                job with
                                {
                                    State = JobState.Running,
                                    Detail = "host.JobCoordinator.resuming",
                                },
                                true
                            );
                            waiting.Resume();
                        }
                        else
                        {
                            var control = new JobControl(handler.UsesWorker, handler.WorkerClass) { HasSlot = true };
                            controls[job.Id] = control;
                            await SaveAsync(
                                job with
                                {
                                    State = JobState.Running,
                                    ExecutionStarted = DateTimeOffset.UtcNow,
                                    Detail = "host.JobCoordinator.running",
                                },
                                true
                            );
                            control.Execution = Task.Run(() => ExecuteAsync(job.Id, control, handler));
                        }
                        Notify();
                    }
                }
                finally
                {
                    mutationGate.Release();
                }
                await wake.WaitAsync(500, lifetime.Token);
            }
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
    }

    private async Task ExecuteAsync(string id, JobControl control, JobHandler handler)
    {
        var previousOrigin = TaskOrigin.Current.Value;
        TaskOrigin.Current.Value = records[id].Origin;
        // Tasks started from this handler record it as their parent.
        CurrentJob.Value = id;
        try
        {
            var context = new JobContext(this, id, control.Cancellation.Token);
            await context.CheckpointAsync();
            using var payload = JsonDocument.Parse(records[id].Payload);
            var result = await handler.Execute(context, payload.RootElement);
            await FinishAsync(id, () => Task.FromResult(result));
        }
        catch (OperationCanceledException) when (control.Cancellation.IsCancellationRequested)
        {
            await UpdateAsync(
                id,
                j =>
                    j.State == JobState.Completed
                        ? j
                        : j with
                        {
                            State =
                                control.UserStopped ? JobState.Cancelled
                                : control.PauseRequested && !shuttingDown ? JobState.Paused
                                : JobState.Interrupted,
                            Detail =
                                control.UserStopped ? "host.JobCoordinator.stoppedCompletedResultsAreKept"
                                : control.PauseRequested && !shuttingDown
                                    ? "host.JobCoordinator.pausedResumingRestartsEncodingOfTheCurrent"
                                : "host.JobCoordinator.appClosedTaskHistoryWasSaved",
                            Finished = DateTimeOffset.UtcNow,
                        }
            );
        }
        catch (JobResultFailure ex)
        {
            await UpdateAsync(
                id,
                j =>
                    j with
                    {
                        State = JobState.Failed,
                        Detail = ex.Message,
                        ResultJson = CatalogRepository.Serialize(ex.Result),
                        Error = ex.Message,
                        Finished = DateTimeOffset.UtcNow,
                    }
            );
        }
        catch (Exception ex)
        {
            diagnostics?.Error("job." + id, ex, TaskOrigin.Current.Value?.TabId);
            await UpdateAsync(
                id,
                j =>
                    j.State == JobState.Completed
                        ? j
                        : j with
                        {
                            State = JobState.Failed,
                            Detail = "host.JobCoordinator.executionFailed",
                            Error = Vroom.Core.Application.ErrorIds.MessageId(ex) ?? ex.Message,
                            ErrorArgs = Vroom.Core.Application.HostMessages.Arguments(ex),
                            Finished = DateTimeOffset.UtcNow,
                        }
            );
        }
        finally
        {
            TaskOrigin.Current.Value = previousOrigin;
            CurrentJob.Value = null;
            await mutationGate.WaitAsync();
            try
            {
                controls.TryRemove(id, out _);
                control.Cancellation.Dispose();
            }
            finally
            {
                mutationGate.Release();
                Signal();
            }
        }
    }

    public async Task PauseAsync(string id)
    {
        await mutationGate.WaitAsync();
        try
        {
            var job = Get(id);
            if (!job.CanPause || job.State is not (JobState.Running or JobState.Queued))
                throw new InvalidOperationException("host.JobCoordinator.thisTaskCannotBePausedRightNow");
            if (!controls.TryGetValue(id, out var control))
                await SaveAsync(
                    job with
                    {
                        State = JobState.Paused,
                        Detail = "host.JobCoordinator.pausedInQueue",
                    },
                    true
                );
            else if (!control.HasSlot)
            {
                // A checkpoint-paused execution can be queued for readmission without running.
                // It cannot acknowledge another pause until admitted, so pause it here.
                control.WaitingForSlot = false;
                control.RequestPause();
                await SaveAsync(
                    job with
                    {
                        State = JobState.Paused,
                        Detail = "host.JobCoordinator.pausedInQueue",
                    },
                    true
                );
            }
            else
            {
                control.RequestPause();
                await SaveAsync(
                    job with
                    {
                        State = JobState.Pausing,
                        Detail = "host.JobCoordinator.waitingForTheCurrentOperationToFinish",
                    },
                    true
                );
                if (handlers[job.Kind].RestartOnPause)
                {
                    control.PauseRequested = true;
                    control.Cancellation.Cancel();
                }
            }
        }
        finally
        {
            mutationGate.Release();
            Signal();
            Notify();
        }
    }

    public async Task ResumeAsync(string id, int? expectedFailedAttempt = null)
    {
        // A terminal notification may arrive just before the old execution releases its resources.
        if (
            controls.TryGetValue(id, out var old)
            && old.Cancellation.IsCancellationRequested
            && old.Execution is { } execution
        )
            await execution;
        await mutationGate.WaitAsync();
        try
        {
            if (shuttingDown)
                throw new InvalidOperationException("host.JobCoordinator.theAppIsShuttingDown");
            var job = Get(id);
            // Automatic network recovery must not undo a concurrent user stop/retry.
            if (expectedFailedAttempt is { } expected && (job.State != JobState.Failed || job.Attempt != expected))
                return;
            if (
                job.State
                is not (
                    JobState.Paused
                    or JobState.Pausing
                    or JobState.Interrupted
                    or JobState.Failed
                    or JobState.Cancelled
                )
            )
                throw new InvalidOperationException("host.JobCoordinator.thisTaskCannotBeResumedRightNow");
            if (controls.TryGetValue(id, out var control))
            {
                if (job.State is not (JobState.Paused or JobState.Pausing))
                    throw new InvalidOperationException("host.JobCoordinator.waitForTheCurrentOperationToFinish");
                if (control.HasSlot)
                {
                    await SaveAsync(
                        job with
                        {
                            State = JobState.Running,
                            Detail = "host.JobCoordinator.resuming",
                        },
                        true
                    );
                    control.Resume();
                }
                else
                {
                    control.WaitingForSlot = true;
                    await SaveAsync(
                        job with
                        {
                            State = JobState.Queued,
                            Detail = "host.JobCoordinator.waitingForExecutionResources",
                        },
                        true
                    );
                }
            }
            else
            {
                if (
                    !handlers.ContainsKey(job.Kind)
                    || !job.CanRetry && !(job.State == JobState.Paused && job.ExecutionStarted is null)
                )
                    throw new InvalidOperationException("host.JobCoordinator.thisTaskCannotBeReplayedStartIt");
                EnsureResource(job.ResourceKey, id);
                await SaveAsync(
                    job with
                    {
                        State = JobState.Queued,
                        Completed = 0,
                        Total = null,
                        Attempt = job.ExecutionStarted is null ? job.Attempt : job.Attempt + 1,
                        Detail = "host.JobCoordinator.retryingResumableStepsExistingDataIsKept",
                        Error = null,
                        Finished = null,
                        Telemetry = null,
                    },
                    true
                );
            }
        }
        finally
        {
            mutationGate.Release();
            Signal();
            Notify();
        }
    }

    public async Task StopAsync(string id)
    {
        // Cancellation must not wait for progress persistence behind the task's own writer transaction.
        var visible = Get(id);
        if (visible.CanStop && !IsTerminal(visible.State) && controls.TryGetValue(id, out var running))
        {
            running.TryCancel(userStopped: true);
        }
        await mutationGate.WaitAsync();
        try
        {
            var job = Get(id);
            if (IsTerminal(job.State) && !IsTerminal(visible.State))
                return;
            if (!job.CanStop || IsTerminal(job.State))
                throw new InvalidOperationException("host.JobCoordinator.thisTaskCannotBeStoppedRightNow");
            if (controls.TryGetValue(id, out var control))
            {
                if (!control.TryCancel(userStopped: true))
                    return;
                await SaveAsync(
                    job with
                    {
                        State = JobState.Cancelling,
                        Detail = "host.JobCoordinator.stoppingAfterTheCurrentIOOperation",
                    },
                    true
                );
            }
            else
                await SaveAsync(
                    job with
                    {
                        State = JobState.Cancelled,
                        Detail = "host.JobCoordinator.stopped",
                        Finished = DateTimeOffset.UtcNow,
                    },
                    true
                );
        }
        finally
        {
            mutationGate.Release();
            Signal();
            Notify();
        }
    }

    internal async Task CheckpointAsync(string id, CancellationToken ct, bool acknowledge = true)
    {
        ct.ThrowIfCancellationRequested();
        Task? pause = null;
        await mutationGate.WaitAsync(ct);
        try
        {
            if (controls.TryGetValue(id, out var control) && control.PauseTask is { } pending)
            {
                pause = pending;
                if (acknowledge && Get(id).State != JobState.Cancelling)
                {
                    control.HasSlot = false;
                    await SaveAsync(
                        Get(id) with
                        {
                            State = JobState.Paused,
                            Detail = "host.JobCoordinator.pausedResumingContinuesFromTheNextStep",
                        },
                        true
                    );
                }
            }
        }
        finally
        {
            mutationGate.Release();
            Signal();
        }
        if (pause is not null)
        {
            Notify();
            await pause.WaitAsync(ct);
        }
        ct.ThrowIfCancellationRequested();
    }

    internal void ReportTransactionProgress(string id, int completed, Vroom.Core.Application.UiMessage detail)
    {
        while (records.TryGetValue(id, out var previous) && previous.State == JobState.Running)
        {
            if (
                records.TryUpdate(
                    id,
                    previous with
                    {
                        Completed = completed,
                        Total = null,
                        Detail = detail.Id,
                        DetailArgs = detail.Args,
                        Updated = DateTimeOffset.UtcNow,
                    },
                    previous
                )
            )
            {
                Notify();
                return;
            }
        }
    }

    internal Task ReportAsync(
        string id,
        int completed,
        int? total,
        Vroom.Core.Application.UiMessage detail,
        JobTelemetry? telemetry = null
    ) =>
        UpdateAsync(
            id,
            j =>
                IsTerminal(j.State)
                    ? j
                    : j with
                    {
                        Completed = Math.Max(0, completed),
                        Total = total,
                        Detail = detail.Id,
                        DetailArgs = detail.Args,
                        Telemetry = telemetry ?? j.Telemetry,
                    }
        );

    internal Task PublishResultAsync(string id, object result) =>
        UpdateAsync(id, j => j with { ResultJson = CatalogRepository.Serialize(result) });

    internal Task SaveCheckpointAsync(string id, object checkpoint) =>
        UpdateAsync(id, j => j with { CheckpointJson = CatalogRepository.Serialize(checkpoint) });

    // File publication and final state share the control gate: stop cannot race a successful commit.
    internal async Task FinishAsync(string id, Func<Task<object?>> commit)
    {
        await mutationGate.WaitAsync();
        try
        {
            var job = Get(id);
            if (job.State == JobState.Completed)
                return;
            controls[id].BeginCommit();
            var result = await commit();
            await SaveAsync(
                job with
                {
                    State = JobState.Completed,
                    Completed = job.Total ?? job.Completed,
                    Detail = "host.JobCoordinator.completed",
                    Finished = DateTimeOffset.UtcNow,
                    ResultJson = CatalogRepository.Serialize(result),
                },
                true
            );
        }
        finally
        {
            mutationGate.Release();
            Notify();
        }
    }

    internal void BeginCommit(string id) => controls[id].BeginCommit();

    public JobInfo Get(string id) =>
        records.TryGetValue(id, out var job) ? job : throw new KeyNotFoundException("host.JobCoordinator.taskNotFound");

    public JobPage List(string? filter = null, int offset = 0, int limit = 50)
    {
        var all = Jobs;
        var filtered = all.Where(j =>
                filter switch
                {
                    "active" => IsActive(j.State),
                    "failed" => j.State is JobState.Failed or JobState.Interrupted,
                    "done" => j.State is JobState.Completed or JobState.Cancelled,
                    _ => true,
                }
            )
            .ToArray();
        return new(
            filtered.Skip(Math.Max(0, offset)).Take(Math.Clamp(limit, 1, 200)).ToArray(),
            filtered.Length,
            all.Count(j => IsActive(j.State)),
            all.Count(j => j.State is JobState.Paused or JobState.Pausing),
            all.Count(j => j.State is JobState.Failed or JobState.Interrupted)
        );
    }

    /// <summary>Removes finished task records (and their state history) older than the retention window.</summary>
    public async Task<int> PruneAsync(TimeSpan retention, CancellationToken ct = default)
    {
        await InitializeAsync();
        var cutoff = DateTimeOffset.UtcNow - retention;
        await mutationGate.WaitAsync(ct);
        try
        {
            var expired = records
                .Values.Where(j =>
                    IsTerminal(j.State) && (j.Finished ?? j.Updated) < cutoff && !controls.ContainsKey(j.Id)
                )
                .Select(j => j.Id)
                .ToArray();
            if (expired.Length == 0)
                return 0;
            await database.RunAsync(
                db =>
                {
                    using var transaction = db.BeginTransaction();
                    foreach (var id in expired)
                    {
                        db.Execute("DELETE FROM job_events WHERE job_id=@id", ("@id", id));
                        db.Execute("DELETE FROM background_jobs WHERE id=@id", ("@id", id));
                    }
                    transaction.Commit();
                },
                ct
            );
            foreach (var id in expired)
                records.TryRemove(id, out _);
            return expired.Length;
        }
        finally
        {
            mutationGate.Release();
            Notify();
        }
    }

    public async Task<JobInfo> WaitAsync(string id, CancellationToken ct = default)
    {
        while (true)
        {
            if (IsTerminal(Get(id).State))
            {
                if (controls.TryGetValue(id, out var control) && control.Execution is { } execution)
                    await execution.WaitAsync(ct);
                return Get(id);
            }
            await Task.Delay(40, ct);
        }
    }

    public Task<IReadOnlyList<object>> EventsAsync(string id) =>
        database.RunAsync<IReadOnlyList<object>>(db =>
        {
            using var cmd = db.Command(
                "SELECT time,state,detail FROM job_events WHERE job_id=@id ORDER BY id",
                ("@id", id)
            );
            using var reader = cmd.ExecuteReader();
            var result = new List<object>();
            while (reader.Read())
                result.Add(
                    new
                    {
                        time = reader.GetString(0),
                        state = reader.GetValue(1) is long ordinal
                            ? JobStateConverter.Name((JobState)ordinal)
                            : reader.GetString(1),
                        detail = reader.GetString(2),
                    }
                );
            return result;
        });

    private async Task UpdateAsync(string id, Func<JobInfo, JobInfo> update)
    {
        await mutationGate.WaitAsync();
        try
        {
            var old = records[id];
            var next = update(old);
            if (next != old)
                await SaveAsync(next, next.State != old.State);
        }
        finally
        {
            mutationGate.Release();
        }
        Notify();
    }

    private async Task SaveAsync(JobInfo job, bool logEvent)
    {
        job = job with { Updated = DateTimeOffset.UtcNow };
        await PersistAsync(job, logEvent);
        records[job.Id] = job;
        Track(job);
    }

    // Active jobs indexed by resource key, so admission checks do not scan the whole history.
    private readonly ConcurrentDictionary<string, string> activeResources = new(StringComparer.Ordinal);

    private void Track(JobInfo job)
    {
        if (job.ResourceKey is not { } key)
            return;
        if (IsActive(job.State))
            activeResources[key] = job.Id;
        else
            activeResources.TryRemove(new KeyValuePair<string, string>(key, job.Id));
    }

    /// <summary>The active job that owns a resource key, if any.</summary>
    public JobInfo? ActiveByResource(string key) =>
        activeResources.TryGetValue(key, out var id) && records.TryGetValue(id, out var job) && IsActive(job.State)
            ? job
            : null;

    private Task PersistAsync(JobInfo job, bool logEvent) =>
        database.RunAsync(db =>
        {
            using var transaction = db.BeginTransaction();
            db.Execute(
                "INSERT INTO background_jobs VALUES(@id,@state,@kind,@updated,@payload) ON CONFLICT(id) DO UPDATE SET state=@state,updated=@updated,payload=@payload",
                ("@id", job.Id),
                ("@state", JobStateConverter.Name(job.State)),
                ("@kind", job.Kind),
                ("@updated", job.Updated.ToString("O")),
                ("@payload", CatalogRepository.Serialize(job))
            );
            if (logEvent)
                db.Execute(
                    "INSERT INTO job_events(job_id,time,state,detail) VALUES(@id,@time,@state,@detail)",
                    ("@id", job.Id),
                    ("@time", job.Updated.ToString("O")),
                    ("@state", JobStateConverter.Name(job.State)),
                    ("@detail", job.Detail)
                );
            transaction.Commit();
        });

    private void Signal()
    {
        try
        {
            wake.Release();
        }
        catch (SemaphoreFullException) { }
    }

    private void Notify()
    {
        foreach (Action callback in Changed?.GetInvocationList() ?? [])
            try
            {
                callback();
            }
            catch { }
    }

    public static bool IsActive(JobState state) =>
        state is JobState.Queued or JobState.Running or JobState.Pausing or JobState.Paused or JobState.Cancelling;

    public static bool IsTerminal(JobState state) =>
        state is JobState.Completed or JobState.Cancelled or JobState.Failed or JobState.Interrupted;

    public void Dispose()
    {
        lock (shutdownGate)
            shutdown ??= ShutdownAsync();
    }

    public async ValueTask DisposeAsync()
    {
        Dispose();
        await shutdown!;
    }

    private async Task ShutdownAsync()
    {
        shuttingDown = true;
        await initializationGate.WaitAsync();
        initializationGate.Release();
        lifetime.Cancel();
        if (dispatcher is not null)
            await dispatcher;
        Task[] executions;
        await mutationGate.WaitAsync();
        try
        {
            executions = controls.Values.Select(c => c.Execution ?? Task.CompletedTask).ToArray();
            foreach (var control in controls.Values)
                control.TryCancel();
        }
        finally
        {
            mutationGate.Release();
        }
        await Task.WhenAll(executions);
        instanceLease?.Dispose();
        instanceLease = null;
    }

    private sealed record JobHandler(
        Func<JobContext, JsonElement, Task<object?>> Execute,
        bool CanPause,
        bool CanStop,
        bool CanRetry,
        bool UsesWorker,
        string WorkerClass,
        bool RestartOnPause
    );

    private sealed class JobControl(bool usesWorker, string workerClass)
    {
        public bool UsesWorker { get; } = usesWorker;
        public string WorkerClass { get; } = workerClass;
        public bool HasSlot { get; set; }
        public bool WaitingForSlot { get; set; }
        private TaskCompletionSource? pause;
        public CancellationTokenSource Cancellation { get; } = new();
        public Task? Execution { get; set; }
        public volatile bool CommitStarted;
        private readonly object commitGate = new();

        public void BeginCommit()
        {
            lock (commitGate)
            {
                if (CommitStarted)
                    return;
                Cancellation.Token.ThrowIfCancellationRequested();
                CommitStarted = true;
            }
        }

        public bool TryCancel(bool userStopped = false)
        {
            lock (commitGate)
            {
                if (CommitStarted)
                    return false;
                UserStopped |= userStopped;
                try
                {
                    Cancellation.Cancel();
                    Resume();
                }
                catch (ObjectDisposedException) { }
                return true;
            }
        }

        public bool UserStopped { get; set; }
        public bool PauseRequested { get; set; }
        public Task? PauseTask => pause?.Task;

        public void RequestPause() => pause ??= new(TaskCreationOptions.RunContinuationsAsynchronously);

        public void Resume()
        {
            pause?.TrySetResult();
            pause = null;
        }
    }
}

public sealed class JobResultFailure(string messageId, object result) : Exception(messageId)
{
    public object Result { get; } = result;
}

public sealed class JobContext(JobCoordinator jobs, string id, CancellationToken cancellationToken)
{
    public string Id => id;
    public CancellationToken CancellationToken => cancellationToken;
    public string? CheckpointJson => jobs.Get(id).CheckpointJson;

    public Task CheckpointAsync() => jobs.CheckpointAsync(id, cancellationToken);

    public Task WaitForPermissionAsync() => jobs.CheckpointAsync(id, cancellationToken, false);

    public Task ReportAsync(
        int completed,
        int? total,
        Vroom.Core.Application.UiMessage detail,
        JobTelemetry? telemetry = null
    ) => jobs.ReportAsync(id, completed, total, detail, telemetry);

    public void ReportTransactionProgress(int completed, Vroom.Core.Application.UiMessage detail) =>
        jobs.ReportTransactionProgress(id, completed, detail);

    public void BeginCommit() => jobs.BeginCommit(id);

    public Task PublishResultAsync(object result) => jobs.PublishResultAsync(id, result);

    public Task SaveCheckpointAsync(object checkpoint) => jobs.SaveCheckpointAsync(id, checkpoint);

    public Task FinishAsync(Func<Task<object?>> commit) => jobs.FinishAsync(id, commit);
}

public sealed class InlineProgress<T>(Action<T> callback) : IProgress<T>
{
    public void Report(T value) => callback(value);
}
