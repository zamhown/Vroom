using Vroom.Core.Catalog;

namespace Vroom.Tests;

public sealed class AdjustableIntervalTests
{
    // Manual timestamps let the test advance minutes without wall-clock sleeps.
    private sealed class Clock : TimeProvider
    {
        private long ticks;
        public override long TimestampFrequency => TimeSpan.TicksPerSecond;

        public override long GetTimestamp() => ticks;

        public void Advance(TimeSpan elapsed) => ticks += elapsed.Ticks;
    }

    [Fact]
    public async Task ShorteningTheIntervalReleasesAnAlreadyElapsedWait()
    {
        var clock = new Clock();
        var interval = new AdjustableInterval(clock);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        var wait = interval.WaitAsync(TimeSpan.FromMinutes(30), timeout.Token);
        clock.Advance(TimeSpan.FromMinutes(5));
        interval.Change(TimeSpan.FromMinutes(3));
        await wait;
        Assert.True(wait.IsCompletedSuccessfully);
    }

    [Fact]
    public async Task LengtheningDoesNotTriggerAnEarlyScanAndLatestChangeWins()
    {
        var clock = new Clock();
        var interval = new AdjustableInterval(clock);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        interval.Change(TimeSpan.FromMinutes(1));
        interval.Change(TimeSpan.FromMinutes(30));
        clock.Advance(TimeSpan.FromMinutes(5));
        var wait = interval.WaitAsync(TimeSpan.FromMinutes(1), timeout.Token);
        Assert.False(wait.IsCompleted);
        clock.Advance(TimeSpan.FromMinutes(2));
        interval.Change(TimeSpan.FromMinutes(30));
        await Task.Yield();
        Assert.False(wait.IsCompleted);
        clock.Advance(TimeSpan.FromMinutes(29));
        interval.Change(TimeSpan.FromMinutes(30));
        await wait;
    }

    [Fact]
    public async Task ShutdownCancelsAnOutstandingWait()
    {
        var interval = new AdjustableInterval();
        using var stop = new CancellationTokenSource();
        var wait = interval.WaitAsync(TimeSpan.FromHours(1), stop.Token);
        stop.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => wait);
    }
}
