using Vroom.Core.Jobs;

namespace Vroom.Core.Storage;

public sealed record MaintenanceReport(
    int Events,
    int Previews,
    int Generations,
    int CacheEntries,
    int Jobs,
    int AuditEntries,
    int Thumbnails,
    int ConfigMirrors,
    long DatabaseBytes
);

/// <summary>
/// Retention for append-only operational data. Annotation history, terms, candidates and user
/// configuration are never pruned; only logs, caches and superseded snapshots are bounded here.
/// </summary>
public sealed class CatalogMaintenance(CatalogDatabase database, JobCoordinator jobs) : IDisposable
{
    public static readonly TimeSpan EventRetention = TimeSpan.FromDays(7);
    public static readonly TimeSpan PreviewRetention = TimeSpan.FromDays(2);
    public static readonly TimeSpan JobRetention = TimeSpan.FromDays(30);
    public static readonly TimeSpan AuditRetention = TimeSpan.FromDays(180);
    public const int KeptGenerations = 20;
    public const long ThumbnailBudgetBytes = 512L * 1024 * 1024;
    private readonly CancellationTokenSource lifetime = new();
    private readonly SemaphoreSlim gate = new(1, 1);
    private Task? loop;

    public void Start() =>
        loop ??= Task.Run(async () =>
        {
            try
            {
                await Task.Delay(TimeSpan.FromMinutes(2), lifetime.Token);
                using var timer = new PeriodicTimer(TimeSpan.FromHours(12));
                do
                {
                    try
                    {
                        await RunAsync(lifetime.Token);
                    }
                    catch (Exception) when (!lifetime.IsCancellationRequested) { }
                } while (await timer.WaitForNextTickAsync(lifetime.Token));
            }
            catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        });

    public async Task<MaintenanceReport> RunAsync(CancellationToken ct = default)
    {
        await gate.WaitAsync(ct);
        try
        {
            var now = DateTimeOffset.UtcNow;
            var (events, previews, generations, cache, audit) = await database.RunAsync(
                db =>
                {
                    using var tx = db.BeginTransaction();
                    var eventCutoff = (now - EventRetention).ToString("O");
                    // Rule runs only deduplicate redelivery of events that still exist.
                    db.Execute(
                        "DELETE FROM tag_rule_runs WHERE event_id IN (SELECT event_id FROM tag_events WHERE processed=1 AND json_extract(payload,'$.occurredAt')<@cutoff)",
                        ("@cutoff", eventCutoff)
                    );
                    var events = db.Execute(
                        "DELETE FROM tag_events WHERE processed=1 AND json_extract(payload,'$.occurredAt')<@cutoff",
                        ("@cutoff", eventCutoff)
                    );
                    var previewCutoff = (now - PreviewRetention).ToString("O");
                    // Unfinished bulk previews back resumable tasks and are kept until they complete.
                    const string expired =
                        "SELECT id FROM tag_previews WHERE created<@cutoff AND (result IS NOT NULL OR kind<>'bulk') AND NOT EXISTS (SELECT 1 FROM tag_bulk_items WHERE preview_id=tag_previews.id AND state IN ('pending','failed','deferred'))";
                    db.Execute(
                        $"DELETE FROM tag_bulk_items WHERE preview_id IN ({expired})",
                        ("@cutoff", previewCutoff)
                    );
                    var previews = db.Execute(
                        $"DELETE FROM tag_previews WHERE id IN ({expired})",
                        ("@cutoff", previewCutoff)
                    );
                    var generations = db.Execute(
                        "DELETE FROM tag_generations WHERE generation <= (SELECT COALESCE(MAX(generation),0) FROM tag_generations) - @kept",
                        ("@kept", KeptGenerations)
                    );
                    var cache = db.Execute(
                        "DELETE FROM tag_source_cache WHERE expires<@now",
                        ("@now", now.ToString("O"))
                    );
                    var audit = db.Execute(
                        "DELETE FROM audit WHERE time<@cutoff",
                        ("@cutoff", (now - AuditRetention).ToString("O"))
                    );
                    tx.Commit();
                    return (events, previews, generations, cache, audit);
                },
                ct
            );
            var prunedJobs = await jobs.PruneAsync(JobRetention, ct);
            var thumbnails = TrimDirectory(Path.Combine(database.DataDirectory, "thumbnails"), ThumbnailBudgetBytes);
            var mirrors = TrimMirrors(Path.Combine(database.DataDirectory, "config", "user", "revisions"));
            await database.RunAsync(db => db.Execute("PRAGMA optimize; PRAGMA wal_checkpoint(TRUNCATE);"), ct);
            return new(events, previews, generations, cache, prunedJobs, audit, thumbnails, mirrors, DatabaseBytes());
        }
        finally
        {
            gate.Release();
        }
    }

    public long DatabaseBytes() =>
        new[] { "", "-wal", "-shm" }
            .Select(suffix => new FileInfo(database.DatabasePath + suffix))
            .Where(f => f.Exists)
            .Sum(f => f.Length);

    // Least recently used files go first once the directory exceeds its budget.
    private static int TrimDirectory(string directory, long budget)
    {
        if (!Directory.Exists(directory))
            return 0;
        var files = new DirectoryInfo(directory)
            .EnumerateFiles()
            .OrderByDescending(f => f.LastAccessTimeUtc > f.LastWriteTimeUtc ? f.LastAccessTimeUtc : f.LastWriteTimeUtc)
            .ToArray();
        long total = 0;
        var removed = 0;
        foreach (var file in files)
        {
            total += file.Length;
            if (total <= budget)
                continue;
            try
            {
                file.Delete();
                removed++;
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
        return removed;
    }

    // Configuration mirrors are a readable copy of the user layer; keep the most recent ones.
    private static int TrimMirrors(string directory)
    {
        if (!Directory.Exists(directory))
            return 0;
        var removed = 0;
        foreach (
            var old in new DirectoryInfo(directory)
                .EnumerateDirectories()
                .Select(d => (Directory: d, Generation: long.TryParse(d.Name, out var g) ? g : -1))
                .Where(d => d.Generation >= 0)
                .OrderByDescending(d => d.Generation)
                .Skip(KeptGenerations)
        )
        {
            try
            {
                old.Directory.Delete(true);
                removed++;
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
        return removed;
    }

    public void Dispose()
    {
        lifetime.Cancel();
        gate.Dispose();
    }
}
