using System.Threading.Channels;

namespace Vroom.Core.Catalog;

// Recalculate from the last cycle, rather than delaying another whole period after an edit.
internal sealed class AdjustableInterval(TimeProvider? clock = null)
{
    private readonly TimeProvider clock = clock ?? TimeProvider.System;
    private readonly Channel<TimeSpan> changes = Channel.CreateBounded<TimeSpan>(
        new BoundedChannelOptions(1) { FullMode = BoundedChannelFullMode.DropOldest, SingleReader = true }
    );

    internal void Change(TimeSpan interval) => changes.Writer.TryWrite(interval);

    internal async Task WaitAsync(TimeSpan interval, CancellationToken ct)
    {
        var start = clock.GetTimestamp();
        while (true)
        {
            ct.ThrowIfCancellationRequested();
            while (changes.Reader.TryRead(out var next))
                interval = next;
            var remaining = interval - clock.GetElapsedTime(start);
            if (remaining <= TimeSpan.Zero)
                return;
            using var cycle = CancellationTokenSource.CreateLinkedTokenSource(ct);
            var delay = Task.Delay(remaining, clock, cycle.Token);
            var changed = changes.Reader.WaitToReadAsync(cycle.Token).AsTask();
            await Task.WhenAny(delay, changed);
            cycle.Cancel();
            if (delay.IsCompletedSuccessfully)
                return;
        }
    }
}
