using Vroom.Core.Domain;
using Vroom.Core.Jobs;
using Vroom.Core.Storage;

namespace Vroom.Tests;

public sealed class JobSchedulingTests : IAsyncLifetime
{
    private readonly string directory = Path.Combine(
        Path.GetTempPath(),
        "vroom-scheduler",
        Guid.NewGuid().ToString("N")
    );
    private CatalogDatabase database = null!;

    public Task InitializeAsync()
    {
        database = new(directory);
        return Task.CompletedTask;
    }

    public Task DisposeAsync()
    {
        database.Dispose();
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        Directory.Delete(directory, true);
        return Task.CompletedTask;
    }

    [Fact]
    public async Task EncoderAdmissionDoesNotBlockOtherWorkAndPriorityIsDurable()
    {
        await using var jobs = new JobCoordinator(database);
        await jobs.ConfigureAsync(new(2, 1, true));
        var order = new List<string>();
        var entered = new TaskCompletionSource();
        var release = new TaskCompletionSource();
        jobs.Register(
            "encode",
            async (ctx, args) =>
            {
                lock (order)
                    order.Add(args.GetString()!);
                entered.TrySetResult();
                await release.Task.WaitAsync(ctx.CancellationToken);
                return true;
            },
            workerClass: "encoding"
        );
        jobs.Register("quick", (_, _) => Task.FromResult<object?>(true));
        var low = await jobs.StartAsync("encode", "low", "low", schedule: new(-2));
        var high = await jobs.StartAsync("encode", "high", "high", schedule: new(8));
        var quick = await jobs.StartAsync("quick", "quick");
        await jobs.ConfigureAsync(new(2, 1));
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal("high", Assert.Single(order));
        Assert.Equal(JobState.Queued, jobs.Get(low).State);
        Assert.Equal(JobState.Completed, (await jobs.WaitAsync(quick)).State);
        release.SetResult();
        await jobs.WaitAsync(high);
        await jobs.WaitAsync(low);
        Assert.Equal(new[] { "high", "low" }, order);
    }

    [Fact]
    public async Task CheckpointPauseReleasesOnlyWorkerAndRejoinsAdmissionOnResume()
    {
        await using var jobs = new JobCoordinator(database);
        await jobs.ConfigureAsync(new(1, 1));
        var entered = new TaskCompletionSource();
        var release = new TaskCompletionSource();
        jobs.Register(
            "steps",
            async (ctx, _) =>
            {
                entered.SetResult();
                await release.Task.WaitAsync(ctx.CancellationToken);
                await ctx.CheckpointAsync();
                return true;
            },
            canPause: true
        );
        jobs.Register("quick", (_, _) => Task.FromResult<object?>(true));
        var first = await jobs.StartAsync("steps", "steps");
        await entered.Task;
        await jobs.PauseAsync(first);
        release.SetResult();
        await Until(() => jobs.Get(first).State == JobState.Paused);
        var second = await jobs.StartAsync("quick", "quick");
        Assert.Equal(JobState.Completed, (await jobs.WaitAsync(second)).State);
        await jobs.ConfigureAsync(new(1, 1, true));
        await jobs.ResumeAsync(first);
        Assert.Equal(JobState.Queued, jobs.Get(first).State);
        await jobs.PauseAsync(first);
        Assert.Equal(JobState.Paused, jobs.Get(first).State);
        await jobs.ConfigureAsync(new(1, 1));
        var barrier = await jobs.StartAsync("quick", "readmission barrier");
        Assert.Equal(JobState.Completed, (await jobs.WaitAsync(barrier)).State);
        Assert.Equal(JobState.Paused, jobs.Get(first).State);
        await jobs.ResumeAsync(first);
        Assert.Equal(JobState.Completed, (await jobs.WaitAsync(first)).State);
    }

    [Fact]
    public async Task QueuedAndPausedSchedulesSurviveRestartAndFutureJobsCanBeCancelled()
    {
        string queued,
            paused;
        await using (var jobs = new JobCoordinator(database))
        {
            jobs.Register("quick", (_, _) => Task.FromResult<object?>(true), canPause: true, canRetry: true);
            await jobs.ConfigureAsync(new(1, 1, true));
            queued = await jobs.StartAsync("quick", "queued", schedule: new(5, DateTimeOffset.UtcNow.AddHours(1)));
            paused = await jobs.StartAsync("quick", "paused");
            await jobs.PauseAsync(paused);
        }
        await using var restored = new JobCoordinator(database);
        restored.Register("quick", (_, _) => Task.FromResult<object?>(true), canPause: true, canRetry: true);
        await restored.InitializeAsync();
        Assert.True(restored.Policy.Paused);
        Assert.Equal(5, restored.Get(queued).Priority);
        Assert.Equal(JobState.Queued, restored.Get(queued).State);
        Assert.Equal(JobState.Paused, restored.Get(paused).State);
        await restored.ConfigureAsync(new(1, 1));
        await restored.StopAsync(queued);
        await restored.ResumeAsync(paused);
        Assert.Equal(JobState.Cancelled, (await restored.WaitAsync(queued)).State);
        Assert.Equal(JobState.Completed, (await restored.WaitAsync(paused)).State);
    }

    [Fact]
    public async Task AtomicFinishCannotBeRelabelledCancelledAndCheckpointSurvivesRetry()
    {
        await using var jobs = new JobCoordinator(database);
        var attempt = 0;
        jobs.Register(
            "finish",
            async (ctx, _) =>
            {
                if (++attempt == 1)
                {
                    await ctx.SaveCheckpointAsync(new { prepared = true });
                    throw new IOException("transient");
                }
                Assert.Contains("prepared", ctx.CheckpointJson);
                await ctx.FinishAsync(() => Task.FromResult<object?>(new { committed = true }));
                return null;
            },
            canRetry: true
        );
        var id = await jobs.StartAsync("finish", "finish");
        Assert.Equal(JobState.Failed, (await jobs.WaitAsync(id)).State);
        await jobs.ResumeAsync(id);
        var done = await jobs.WaitAsync(id);
        Assert.Equal(JobState.Completed, done.State);
        Assert.Contains("committed", done.ResultJson);
        await Assert.ThrowsAsync<InvalidOperationException>(() => jobs.StopAsync(id));
    }

    [Fact]
    public async Task RestartPauseRetainsIdentityAndCannotRaceASecondExecution()
    {
        await using var jobs = new JobCoordinator(database);
        var attempts = 0;
        var active = 0;
        var overlap = false;
        jobs.Register(
            "encoding",
            async (ctx, _) =>
            {
                if (Interlocked.Increment(ref active) != 1)
                    overlap = true;
                try
                {
                    if (Interlocked.Increment(ref attempts) == 1)
                        await Task.Delay(Timeout.Infinite, ctx.CancellationToken);
                    return true;
                }
                finally
                {
                    Interlocked.Decrement(ref active);
                }
            },
            canPause: true,
            canRetry: true,
            workerClass: "encoding",
            restartOnPause: true
        );
        var id = await jobs.StartAsync("encoding", "encoding");
        await Until(() => attempts == 1);
        await jobs.PauseAsync(id);
        await Until(() => jobs.Get(id).State == JobState.Paused);
        await jobs.ResumeAsync(id);
        Assert.Equal(JobState.Completed, (await jobs.WaitAsync(id)).State);
        Assert.Equal(2, jobs.Get(id).Attempt);
        Assert.False(overlap);
    }

    private static async Task Until(Func<bool> condition)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (!condition())
            await Task.Delay(10, timeout.Token);
    }
}
