using System.Text.Json;
using Vroom.Core.Application;
using Vroom.Core.Domain;
using Vroom.Core.Jobs;
using Vroom.Core.Storage;
using Vroom.Core.Tagging;

namespace Vroom.Core.Network;

public sealed class NetworkRecovery(
    NetworkService network,
    CatalogRepository repository,
    JobCoordinator jobs,
    TagSources sources,
    LocalDiagnostics diagnostics
) : IDisposable, IAsyncDisposable
{
    private readonly CancellationTokenSource stop = new();
    private readonly SemaphoreSlim pulse = new(0, 1);
    private Task? worker;

    public void Start()
    {
        if (worker is not null)
            return;
        network.Changed += Wake;
        worker = RunAsync();
    }

    private void Wake()
    {
        if (pulse.CurrentCount == 0)
            try
            {
                pulse.Release();
            }
            catch (SemaphoreFullException) { }
    }

    internal static bool CanRecover(JobInfo job)
    {
        if (
            job.State != JobState.Failed
            || !job.CanRetry
            || job.Kind is not ("metadata.enrich" or "sources.subscription")
            || job.ResultJson is null
        )
            return false;
        try
        {
            using var result = JsonDocument.Parse(job.ResultJson);
            if (!result.RootElement.TryGetProperty("sources", out var outcomes))
                return false;
            var failed = outcomes
                .EnumerateArray()
                .Where(s => s.TryGetProperty("error", out var e) && e.ValueKind == JsonValueKind.String)
                .ToArray();
            return failed.Length > 0
                && failed.All(s =>
                    s.GetProperty("status").GetString() is "connection-failed" or "timeout" or "browser-disconnected"
                );
        }
        catch (Exception e) when (e is JsonException or InvalidOperationException or KeyNotFoundException)
        {
            return false;
        }
    }

    private async Task RunAsync()
    {
        while (!stop.IsCancellationRequested)
        {
            try
            {
                if ((await repository.SettingsAsync(stop.Token)).OnlineMetadata)
                {
                    var state = await network.CheckAsync(stop.Token);
                    if (state.State == "offline")
                        await RememberAsync(true, stop.Token);
                    else if (state.State == "online" && await WasOfflineAsync(stop.Token))
                    {
                        if (network.Options.RetryOnReconnect)
                            await RetryAsync(stop.Token);
                        await RememberAsync(false, stop.Token);
                    }
                }
            }
            catch (OperationCanceledException) when (stop.IsCancellationRequested)
            {
                break;
            }
            catch (Exception e)
            {
                diagnostics.Error("network.recovery", e);
            }
            try
            {
                await pulse.WaitAsync(TimeSpan.FromSeconds(network.Status.State == "offline" ? 30 : 300), stop.Token);
            }
            catch (OperationCanceledException) when (stop.IsCancellationRequested)
            {
                break;
            }
        }
    }

    private Task<bool> WasOfflineAsync(CancellationToken ct) =>
        repository.Database.ReadAsync(
            db => db.Scalar("SELECT value FROM settings WHERE key='network.wasOffline'") as string == "true",
            ct
        );

    private Task RememberAsync(bool value, CancellationToken ct) =>
        repository.Database.RunAsync(
            db =>
                db.Execute(
                    "INSERT INTO settings VALUES('network.wasOffline',@v) ON CONFLICT(key) DO UPDATE SET value=@v",
                    ("@v", value ? "true" : "false")
                ),
            ct
        );

    internal async Task<int> RetryAsync(CancellationToken ct)
    {
        var pending = new List<JobInfo>();
        for (var offset = 0; ; offset += 200)
        {
            var page = jobs.List(null, offset, 200);
            pending.AddRange(page.Items);
            if (offset + 200 >= page.Total)
                break;
        }
        // Freeze identities and attempts before changing any task state. Multiple old
        // attempts for the same resource must not all be scheduled on reconnect.
        var targets = pending
            .OrderByDescending(j => j.Started)
            .GroupBy(j => j.ResourceKey ?? j.Id)
            .Select(g => g.First())
            .Where(CanRecover)
            .ToArray();
        await sources.ResetConnectionFailuresAsync(ct);
        var count = 0;
        foreach (var job in targets)
        {
            ct.ThrowIfCancellationRequested();
            if (!(await repository.SettingsAsync(ct)).OnlineMetadata)
                break;
            try
            {
                await jobs.ResumeAsync(job.Id, job.Attempt);
                if (jobs.Get(job.Id).Attempt > job.Attempt)
                    count++;
            }
            catch (InvalidOperationException e)
            {
                diagnostics.Error("network.retry", e, job.Origin?.TabId);
            }
        }
        return count;
    }

    public void Dispose()
    {
        network.Changed -= Wake;
        stop.Cancel();
    }

    public async ValueTask DisposeAsync()
    {
        Dispose();
        if (worker is not null)
            await worker;
    }
}
