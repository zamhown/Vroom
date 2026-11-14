using Vroom.Core.Domain;
using Vroom.Core.Jobs;
using Vroom.Core.Storage;

namespace Vroom.Core.Application;

internal sealed record ChangeEvent(long Sequence, System.Text.Json.Nodes.JsonNode? Data);

public sealed record ChangeBatch(IReadOnlyList<object> Events, long Cursor, JobPage? Jobs, long JobsVersion);

/// <summary>
/// One long-poll channel for both hosts. The client waits until catalog events or task state
/// change (or a timeout elapses) instead of polling several endpoints every second.
/// </summary>
public sealed class ChangeFeed : IDisposable
{
    private readonly CatalogDatabase database;
    private readonly JobCoordinator jobs;
    private long jobsVersion;
    private TaskCompletionSource signal = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public ChangeFeed(CatalogDatabase database, JobCoordinator jobs)
    {
        this.database = database;
        this.jobs = jobs;
        jobs.Changed += JobsChanged;
    }

    private void JobsChanged()
    {
        Interlocked.Increment(ref jobsVersion);
        Signal();
    }

    public void Signal() =>
        Interlocked
            .Exchange(ref signal, new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously))
            .TrySetResult();

    public async Task<ChangeBatch> WaitAsync(
        long cursor,
        long knownJobsVersion,
        TimeSpan timeout,
        CancellationToken ct = default
    )
    {
        var deadline = DateTimeOffset.UtcNow + timeout;
        while (true)
        {
            var wake = signal.Task;
            var latest = await database.ReadAsync(
                db => Convert.ToInt64(db.Scalar("SELECT COALESCE(MAX(sequence),0) FROM tag_events")),
                ct
            );
            var version = Interlocked.Read(ref jobsVersion);
            var remaining = deadline - DateTimeOffset.UtcNow;
            if (latest > cursor || version != knownJobsVersion || remaining <= TimeSpan.Zero)
            {
                var rows =
                    latest > cursor
                        ? await database.ReadAsync(
                            db =>
                                Tagging.TagEngine.ReadRows(
                                    db,
                                    "SELECT sequence,payload FROM tag_events WHERE sequence>@c ORDER BY sequence LIMIT 500",
                                    r => new ChangeEvent(
                                        r.GetInt64(0),
                                        System.Text.Json.Nodes.JsonNode.Parse(r.GetString(1))
                                    ),
                                    ("@c", cursor)
                                ),
                            ct
                        )
                        : [];
                IReadOnlyList<object> events = rows.Select(e => (object)new { sequence = e.Sequence, data = e.Data })
                    .ToArray();
                var next = rows.Count > 0 ? rows[^1].Sequence : cursor;
                return new(events, next, version != knownJobsVersion ? jobs.List(null, 0, 200) : null, version);
            }
            // Events are written inside catalog transactions; a short host-side tick notices them
            // without the client making a request per tick.
            await Task.WhenAny(wake, Task.Delay(TimeSpan.FromMilliseconds(500), ct), Task.Delay(remaining, ct));
            ct.ThrowIfCancellationRequested();
        }
    }

    public void Dispose() => jobs.Changed -= JobsChanged;
}
