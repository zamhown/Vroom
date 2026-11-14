using System.Net;
using System.Text.Json.Nodes;
using Vroom.Core.Application;
using Vroom.Core.Domain;
using Vroom.Core.Jobs;
using Vroom.Core.Network;
using Vroom.Core.Storage;
using Vroom.Core.Tagging;

namespace Vroom.Tests;

public sealed class NetworkTests : IAsyncLifetime
{
    [Fact]
    public async Task ReconnectionResumesOnlyTheLatestFailedAttemptAndLeavesUserStoppedAndRateLimitedTasksAlone()
    {
        await repository.PatchSettingsAsync(new() { ["onlineMetadata"] = true });
        var engine = new TagEngine(repository);
        await engine.InitializeAsync();
        using var sources = new TagSources(engine);
        using var diagnostics = new LocalDiagnostics(directory);
        await using var jobs = new JobCoordinator(db);
        var attempts = new System.Collections.Concurrent.ConcurrentDictionary<string, int>();
        jobs.Register(
            "metadata.enrich",
            async (ctx, args) =>
            {
                var name = args.GetProperty("name").GetString()!;
                var attempt = attempts.AddOrUpdate(name, 1, (_, value) => value + 1);
                if (name == "stopped")
                    await Task.Delay(Timeout.Infinite, ctx.CancellationToken);
                if (attempt == 1)
                    throw new JobResultFailure(
                        "host.SourceAccess.failed",
                        new
                        {
                            sources = new[]
                            {
                                new
                                {
                                    status = name == "limited" ? "rate-limited" : "connection-failed",
                                    error = "fixture",
                                },
                            },
                        }
                    );
                return new { recovered = true };
            },
            canRetry: true
        );
        async Task<string> Failed(string name, string resource)
        {
            var id = await jobs.StartAsync("metadata.enrich", "fixture", new { name }, resource);
            Assert.Equal(JobState.Failed, (await jobs.WaitAsync(id)).State);
            return id;
        }
        var old = await Failed("old", "same-resource");
        var latest = await Failed("latest", "same-resource");
        var limited = await Failed("limited", "limited");
        var stopped = await jobs.StartAsync("metadata.enrich", "fixture", new { name = "stopped" }, "stopped");
        await jobs.StopAsync(stopped);
        Assert.Equal(JobState.Cancelled, (await jobs.WaitAsync(stopped)).State);
        var online = false;
        using var network = new NetworkService(repository, (_, _) => Task.FromResult(online));
        await network.InitializeAsync();
        await using var recovery = new NetworkRecovery(network, repository, jobs, sources, diagnostics);
        recovery.Start();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (
            await db.ReadAsync(c => c.Scalar("SELECT value FROM settings WHERE key='network.wasOffline'") as string)
            != "true"
        )
            await Task.Delay(10, timeout.Token);
        online = true;
        await repository.PatchSettingsAsync(new() { ["network"] = new JsonObject { ["mode"] = "direct" } });
        while (jobs.Get(latest).State != JobState.Completed)
            await Task.Delay(10, timeout.Token);
        Assert.Equal(2, jobs.Get(latest).Attempt);
        Assert.Equal(1, jobs.Get(old).Attempt);
        Assert.Equal(JobState.Failed, jobs.Get(old).State);
        Assert.Equal(1, jobs.Get(limited).Attempt);
        Assert.Equal(JobState.Failed, jobs.Get(limited).State);
        Assert.Equal(JobState.Cancelled, jobs.Get(stopped).State);
    }

    private readonly string directory = Path.Combine(
        Path.GetTempPath(),
        "vroom-network-tests",
        Guid.NewGuid().ToString("N")
    );
    private CatalogDatabase db = null!;
    private CatalogRepository repository = null!;

    public async Task InitializeAsync()
    {
        db = new(directory);
        repository = new(db);
        await repository.InitializeAsync();
    }

    public Task DisposeAsync()
    {
        db.Dispose();
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        Directory.Delete(directory, true);
        return Task.CompletedTask;
    }

    [Fact]
    public async Task InvalidSettingsNeverReplaceThePersistedRoute()
    {
        await repository.PatchSettingsAsync(
            new()
            {
                ["network"] = new JsonObject
                {
                    ["mode"] = "custom",
                    ["proxyUrl"] = "socks5://127.0.0.1:9988",
                    ["retryOnReconnect"] = true,
                },
            }
        );
        var previous = await repository.SettingsAsync();
        foreach (
            var address in new[]
            {
                "file:///tmp/proxy",
                "http://user:secret@proxy.example:8080",
                "http://proxy.example/path",
                "",
            }
        )
            await Assert.ThrowsAsync<ArgumentException>(() =>
                repository.PatchSettingsAsync(
                    new()
                    {
                        ["network"] = new JsonObject { ["mode"] = "custom", ["proxyUrl"] = address },
                    }
                )
            );
        await Assert.ThrowsAsync<ArgumentException>(() =>
            repository.PatchSettingsAsync(
                new()
                {
                    ["network"] = new JsonObject { ["mode"] = "direct", ["misspelled"] = true },
                }
            )
        );
        Assert.Equal(previous, await repository.SettingsAsync());
    }

    [Fact]
    public async Task SettingsChangeDoesNotReplaceAnInflightRouteOrPublishItsStaleResult()
    {
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var finish = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        IWebProxy? captured = null;
        using var network = new NetworkService(
            repository,
            async (route, ct) =>
            {
                captured = route;
                entered.SetResult();
                return await finish.Task.WaitAsync(ct);
            }
        );
        await repository.SaveSettingsAsync(new() { Network = new("custom", "http://127.0.0.1:9988") });
        await network.InitializeAsync();
        var check = network.CheckAsync();
        await entered.Task;
        await repository.PatchSettingsAsync(new() { ["network"] = new JsonObject { ["mode"] = "direct" } });
        Assert.Equal(9988, captured!.GetProxy(new("https://public.example"))!.Port);
        Assert.True(network.CaptureProxy().IsBypassed(new("https://public.example")));
        finish.SetResult(true);
        Assert.Equal("unknown", (await check).State);
    }

    [Fact]
    public async Task CancellationDoesNotClaimAnOutage()
    {
        using var network = new NetworkService(
            repository,
            async (_, ct) =>
            {
                await Task.Delay(Timeout.Infinite, ct);
                return true;
            }
        );
        using var cancel = new CancellationTokenSource();
        var check = network.CheckAsync(cancel.Token);
        cancel.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => check);
        Assert.Equal("unknown", network.Status.State);
    }

    [Fact]
    public void RecoveryOnlyRetriesConnectionFailuresAndNeverUserStoppedTasks()
    {
        var failed = new JobInfo("test", "test", JobState.Failed, 0, "test", DateTimeOffset.UtcNow)
        {
            CanRetry = true,
            Kind = "metadata.enrich",
            ResultJson =
                """{"sources":[{"status":"connection-failed","error":"host.SourceAccess.connectionFailed"}]}""",
        };
        Assert.True(NetworkRecovery.CanRecover(failed));
        foreach (var state in new[] { JobState.Cancelled, JobState.Paused, JobState.Completed, JobState.Interrupted })
            Assert.False(NetworkRecovery.CanRecover(failed with { State = state }));
        foreach (
            var failure in new[]
            {
                "rate-limited",
                "authentication-required",
                "identity-mismatch",
                "verification-required",
                "browser-unavailable",
            }
        )
            Assert.False(
                NetworkRecovery.CanRecover(
                    failed with
                    {
                        ResultJson = $$"""{"sources":[{"status":"{{failure}}","error":"error"}]}""",
                    }
                )
            );
        Assert.False(
            NetworkRecovery.CanRecover(
                failed with
                {
                    ResultJson =
                        """{"sources":[{"status":"timeout","error":"error"},{"status":"rate-limited","error":"error"}]}""",
                }
            )
        );
    }
}
