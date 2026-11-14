namespace Vroom.Core.Tagging;

/// <summary>Outbox delivery is independent of pages and resumes after process restart.</summary>
public sealed class TagEventPump(TagEngine engine) : IAsyncDisposable
{
    private readonly CancellationTokenSource lifetime = new();
    private Task? running;

    public void Start() =>
        running ??= Task.Run(async () =>
        {
            using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(750));
            try
            {
                do
                {
                    try
                    {
                        await engine.ResumeEventsAsync(lifetime.Token);
                    }
                    catch (Exception e) when (e is not OperationCanceledException)
                    {
                        await engine.Repository.AuditAsync("events.delivery-failed", e.Message, lifetime.Token);
                    }
                } while (await timer.WaitForNextTickAsync(lifetime.Token));
            }
            catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        });

    public async ValueTask DisposeAsync()
    {
        lifetime.Cancel();
        if (running is not null)
            await running;
        lifetime.Dispose();
    }
}
