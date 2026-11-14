using Vroom.Core.Domain;
using Vroom.Core.Jobs;
using Vroom.Core.Storage;

namespace Vroom.Tests;

public sealed class JobCoordinatorTests : IAsyncLifetime
{
    private readonly string path = Path.Combine(Path.GetTempPath(), "vroom-jobs", Guid.NewGuid().ToString("N"));
    private CatalogDatabase database = null!;

    public Task InitializeAsync()
    {
        database = new(path);
        return Task.CompletedTask;
    }

    public Task DisposeAsync()
    {
        database.Dispose();
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        Directory.Delete(path, true);
        return Task.CompletedTask;
    }

    [Fact]
    public async Task StopSignalsCancellationWhileTheJobOwnsTheDatabaseWriter()
    {
        await using var jobs = new JobCoordinator(database);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        jobs.Register(
            "transaction",
            async (ctx, _) =>
            {
                await database.RunAsync(db =>
                {
                    using var tx = db.BeginTransaction();
                    ctx.ReportTransactionProgress(10, "projecting");
                    entered.SetResult();
                    if (!ctx.CancellationToken.WaitHandle.WaitOne(TimeSpan.FromSeconds(8)))
                        throw new TimeoutException();
                    ctx.CancellationToken.ThrowIfCancellationRequested();
                });
                return null;
            }
        );
        var id = await jobs.StartAsync("transaction", "transaction");
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(10, jobs.Get(id).Completed);
        await jobs.StopAsync(id).WaitAsync(TimeSpan.FromSeconds(3));
        Assert.Equal(JobState.Cancelled, (await jobs.WaitAsync(id)).State);
    }

    [Fact]
    public async Task FailedJobRetainsReviewableSourceOutcomes()
    {
        await using var jobs = new JobCoordinator(database);
        jobs.Register(
            "source-review",
            (_, _) =>
                throw new JobResultFailure(
                    "host.SourceAccess.failed",
                    new { sources = new[] { new { sourceId = "unfamiliar.source", status = "rate-limited" } } }
                ),
            canRetry: true
        );
        var id = await jobs.StartAsync("source-review", "host.SourceAccess.failed");
        var job = await jobs.WaitAsync(id);
        Assert.Equal(JobState.Failed, job.State);
        Assert.Contains("rate-limited", job.ResultJson);
        Assert.Equal("host.SourceAccess.failed", job.Error);
    }

    [Fact]
    public async Task JobsAndResultsSurviveRestartWithoutOneHundredItemCap()
    {
        await using (var jobs = new JobCoordinator(database))
        {
            jobs.Register(
                "test",
                (_, args) => Task.FromResult<object?>(new { value = args.GetProperty("value").GetInt32() }),
                canRetry: true
            );
            var ids = new List<string>();
            for (var i = 0; i < 110; i++)
                ids.Add(await jobs.StartAsync("test", "task " + i, new { value = i }));
            foreach (var id in ids)
                Assert.Equal(JobState.Completed, (await jobs.WaitAsync(id)).State);
        }
        await using var restored = new JobCoordinator(database);
        await restored.InitializeAsync();
        Assert.Equal(110, restored.Jobs.Count);
        Assert.Equal(110, restored.List(limit: 20).Total);
        Assert.Equal(20, restored.List(limit: 20).Items.Count);
        Assert.All(restored.Jobs, j => Assert.Contains("value", j.ResultJson));
    }

    [Fact]
    public async Task PauseAcknowledgesAtCheckpointAndResumeKeepsProgress()
    {
        await using var jobs = new JobCoordinator(database);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        jobs.Register(
            "steps",
            async (ctx, _) =>
            {
                await ctx.ReportAsync(1, 2, "first");
                entered.SetResult();
                await release.Task.WaitAsync(ctx.CancellationToken);
                await ctx.CheckpointAsync();
                await ctx.ReportAsync(2, 2, "second");
                return true;
            },
            canPause: true,
            canRetry: true
        );
        var id = await jobs.StartAsync("steps", "steps");
        await entered.Task;
        await jobs.PauseAsync(id);
        Assert.Equal(JobState.Pausing, jobs.Get(id).State);
        release.SetResult();
        await Until(() => jobs.Get(id).State == JobState.Paused);
        Assert.Equal(1, jobs.Get(id).Completed);
        await jobs.ResumeAsync(id);
        Assert.Equal(JobState.Completed, (await jobs.WaitAsync(id)).State);
        Assert.Equal(2, jobs.Get(id).Completed);
        Assert.True((await jobs.EventsAsync(id)).Count >= 5);
    }

    [Fact]
    public async Task StoppingPausedTaskDoesNotRunNextStep()
    {
        await using var jobs = new JobCoordinator(database);
        var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var proceed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var ran = false;
        jobs.Register(
            "steps",
            async (ctx, _) =>
            {
                reached.SetResult();
                await proceed.Task.WaitAsync(ctx.CancellationToken);
                await ctx.CheckpointAsync();
                ran = true;
                return true;
            },
            canPause: true
        );
        var id = await jobs.StartAsync("steps", "test");
        await reached.Task;
        await jobs.PauseAsync(id);
        proceed.SetResult();
        await Until(() => jobs.Get(id).State == JobState.Paused);
        await jobs.StopAsync(id);
        Assert.Equal(JobState.Cancelled, (await jobs.WaitAsync(id)).State);
        Assert.False(ran);
    }

    [Fact]
    public async Task InterruptedJobCanBeRecoveredWithSameIdentityAndNewAttempt()
    {
        string id;
        await using (var jobs = new JobCoordinator(database))
        {
            jobs.Register(
                "recover",
                async (ctx, _) =>
                {
                    await ctx.ReportAsync(3, 10, "partial");
                    await Task.Delay(Timeout.Infinite, ctx.CancellationToken);
                    return null;
                },
                canRetry: true
            );
            id = await jobs.StartAsync("recover", "recover", new { path = "catalog" });
            await Until(() => jobs.Get(id).Completed == 3);
        }
        await using var recovered = new JobCoordinator(database);
        recovered.Register(
            "recover",
            (_, args) => Task.FromResult<object?>(args.GetProperty("path").GetString()),
            canRetry: true
        );
        await recovered.InitializeAsync();
        Assert.Equal(JobState.Interrupted, recovered.Get(id).State);
        Assert.Equal(3, recovered.Get(id).Completed);
        await recovered.ResumeAsync(id);
        var result = await recovered.WaitAsync(id);
        Assert.Equal(JobState.Completed, result.State);
        Assert.Equal(2, result.Attempt);
        Assert.Contains("catalog", result.ResultJson);
    }

    [Fact]
    public async Task SecondInstanceCannotInterruptAnOwnersRunningJobs()
    {
        await using var owner = new JobCoordinator(database);
        owner.Register(
            "wait",
            async (ctx, _) =>
            {
                await Task.Delay(Timeout.Infinite, ctx.CancellationToken);
                return null;
            }
        );
        var id = await owner.StartAsync("wait", "running");
        await Until(() => owner.Get(id).State == JobState.Running);
        await using var other = new JobCoordinator(database);
        await Assert.ThrowsAsync<InvalidOperationException>(() => other.InitializeAsync());
        Assert.Equal(JobState.Running, owner.Get(id).State);
        await owner.StopAsync(id);
        await owner.WaitAsync(id);
    }

    [Fact]
    public async Task DuplicateActiveResourceAndUnsupportedPauseAreRejected()
    {
        await using var jobs = new JobCoordinator(database);
        jobs.Register(
            "blocking",
            async (ctx, _) =>
            {
                await Task.Delay(Timeout.Infinite, ctx.CancellationToken);
                return null;
            }
        );
        var id = await jobs.StartAsync("blocking", "test", resourceKey: "scan:library");
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            jobs.StartAsync("blocking", "test", resourceKey: "scan:library")
        );
        await Assert.ThrowsAsync<InvalidOperationException>(() => jobs.PauseAsync(id));
        await jobs.StopAsync(id);
        Assert.Equal(JobState.Cancelled, (await jobs.WaitAsync(id)).State);
        await Assert.ThrowsAsync<InvalidOperationException>(() => jobs.ResumeAsync(id));
    }

    [Fact]
    public async Task StopAfterAtomicCommitStartsKeepsSuccessfulResult()
    {
        await using var jobs = new JobCoordinator(database);
        var committing = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        jobs.Register(
            "commit",
            async (ctx, _) =>
            {
                ctx.BeginCommit();
                committing.SetResult();
                await release.Task;
                ctx.CancellationToken.ThrowIfCancellationRequested();
                return "published";
            }
        );
        var id = await jobs.StartAsync("commit", "commit");
        await committing.Task;
        await jobs.StopAsync(id);
        release.SetResult();
        var result = await jobs.WaitAsync(id);
        Assert.Equal(JobState.Completed, result.State);
        Assert.Contains("published", result.ResultJson);
    }

    private static async Task Until(Func<bool> condition)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (!condition())
            await Task.Delay(10, timeout.Token);
    }
}
