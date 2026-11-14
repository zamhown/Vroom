using System.Text.Json;
using Microsoft.Data.Sqlite;
using Vroom.Core.Application;
using Vroom.Core.Domain;
using Vroom.Core.Jobs;
using Vroom.Core.Media;
using Vroom.Core.Storage;
using Vroom.Core.Tagging;

namespace Vroom.Core.Catalog;

public sealed record MediaWork(string FilmId, string PartId, string Kind);

/// <summary>
/// Durable follow-up work for discovered media (probing and metadata enrichment). Items are
/// queued in <c>media_work</c> and drained by one <c>media.process</c> task per library, so a
/// scan of thousands of files produces one visible task instead of one task per file.
/// </summary>
public sealed class MediaPipeline
{
    public const string Probe = "probe";
    public const string Enrich = "enrich";
    private const int MaxAttempts = 3;
    private readonly CatalogRepository repository;
    private readonly FfmpegService ffmpeg;
    private readonly JobCoordinator jobs;
    private readonly TagEngine tagging;
    private readonly TagSources sources;

    public MediaPipeline(
        CatalogRepository repository,
        FfmpegService ffmpeg,
        JobCoordinator jobs,
        TagEngine tagging,
        TagSources sources
    )
    {
        this.repository = repository;
        this.ffmpeg = ffmpeg;
        this.jobs = jobs;
        this.tagging = tagging;
        this.sources = sources;
        sources.RegisterBulkJobs(jobs);
        jobs.Register(
            "media.probe",
            async (context, args) =>
            {
                await context.ReportAsync(0, 1, "host.BackgroundOperations.readingMediaCodecsAndDuration");
                var probe = await ProbeAsync(
                    Id(args),
                    args.TryGetProperty("partId", out var part) ? part.GetString() : null,
                    context.CancellationToken
                );
                await context.ReportAsync(1, 1, "host.BackgroundOperations.mediaInformationUpdated");
                return probe;
            },
            canRetry: true
        );
        jobs.Register(
            "media.prepare",
            async (context, args) =>
            {
                var ids = args.GetProperty("ids").EnumerateArray().Select(v => v.GetString()!).ToArray();
                var completed = 0;
                var failures = new List<object>();
                foreach (var id in ids)
                {
                    await context.CheckpointAsync();
                    try
                    {
                        var film = await repository.GetMediaAsync(id, context.CancellationToken);
                        if (film.ProbeState != "ready")
                            await ProbeAsync(id, null, context.CancellationToken);
                    }
                    catch (Exception ex) when (ex is not OperationCanceledException)
                    {
                        failures.Add(new { id, error = ex.Message });
                    }
                    await context.ReportAsync(
                        ++completed,
                        ids.Length,
                        "host.BackgroundOperations.readingMediaCodecsAndDuration"
                    );
                }
                return new { count = ids.Length, failures };
            },
            canPause: true,
            canRetry: true
        );
        jobs.Register(
            "metadata.enrich",
            async (context, args) =>
            {
                await context.ReportAsync(0, 1, "host.BackgroundOperations.checkingLocalNfoFilesAndEnabledMetadata");
                var result = await sources.EnrichSubjectAsync(
                    args.TryGetProperty("subjectKind", out var subjectKind) ? subjectKind.GetString()! : "film",
                    Id(args),
                    context.CancellationToken,
                    message =>
                        context.ReportAsync(
                            0,
                            1,
                            message,
                            new JobTelemetry(
                                message.Id == "host.SourceAccess.waitingVerification"
                                    ? "source-verification"
                                    : "source-fetch"
                            )
                        )
                );
                if (result.HasFailures && !result.Found)
                    throw new JobResultFailure("host.SourceAccess.failed", result);
                await context.ReportAsync(
                    1,
                    1,
                    result.HasFailures ? "host.SourceAccess.partial"
                        : result.Found ? "host.BackgroundOperations.metadataEnriched"
                        : "host.BackgroundOperations.noMatchingMetadata"
                );
                return result;
            },
            canRetry: true
        );
        jobs.Register(
            "media.process",
            async (context, args) => await ProcessAsync(args.GetProperty("libraryId").GetString()!, context),
            canPause: true,
            canRetry: true
        );
    }

    /// <summary>Queues work and starts (or keeps) the library's processing task.</summary>
    public async Task<string?> EnqueueAsync(
        Library library,
        IReadOnlyCollection<MediaWork> items,
        CancellationToken ct = default
    )
    {
        if (items.Count > 0)
            await repository.Database.RunAsync(
                db =>
                {
                    using var tx = db.BeginTransaction();
                    var now = DateTimeOffset.UtcNow.ToString("O");
                    foreach (var item in items)
                        db.Execute(
                            "INSERT INTO media_work(film_id,part_id,kind,library_id,state,attempts,error,updated) VALUES(@film,@part,@kind,@lib,'pending',0,NULL,@now) ON CONFLICT(film_id,part_id,kind) DO UPDATE SET state='pending',attempts=0,error=NULL,updated=@now",
                            ("@film", item.FilmId),
                            ("@part", item.PartId),
                            ("@kind", item.Kind),
                            ("@lib", library.Id),
                            ("@now", now)
                        );
                    tx.Commit();
                },
                ct
            );
        return await StartAsync(library, ct);
    }

    /// <summary>Starts the processing task when the library has queued work and no task is running.</summary>
    public async Task<string?> StartAsync(Library library, CancellationToken ct = default)
    {
        var pending = await repository.Database.ReadAsync(
            db =>
                Convert.ToInt64(
                    db.Scalar(
                        "SELECT COUNT(*) FROM media_work WHERE library_id=@lib AND state='pending'",
                        ("@lib", library.Id)
                    )
                ),
            ct
        );
        if (pending == 0)
            return null;
        var key = "process:" + library.Id;
        if (jobs.ActiveByResource(key) is { } active)
            return active.Id;
        return await jobs.StartAsync(
            "media.process",
            UiMessage.Of("host.MediaPipeline.processing", library.Name),
            new { libraryId = library.Id },
            key
        );
    }

    public Task<MediaWorkSummary> SummaryAsync(string libraryId, CancellationToken ct = default) =>
        repository.Database.ReadAsync(
            db =>
            {
                long Count(string state) =>
                    Convert.ToInt64(
                        db.Scalar(
                            "SELECT COUNT(*) FROM media_work WHERE library_id=@lib AND state=@state",
                            ("@lib", libraryId),
                            ("@state", state)
                        )
                    );
                return new MediaWorkSummary(Count("pending"), Count("failed"));
            },
            ct
        );

    private async Task<object> ProcessAsync(string libraryId, JobContext context)
    {
        var ct = context.CancellationToken;
        // A retry gives failed items another bounded set of attempts.
        await repository.Database.RunAsync(
            db =>
                db.Execute(
                    "UPDATE media_work SET state='pending' WHERE library_id=@lib AND state='failed' AND attempts<@max",
                    ("@lib", libraryId),
                    ("@max", MaxAttempts)
                ),
            ct
        );
        var library = (await repository.LibrariesAsync(ct)).FirstOrDefault(l => l.Id == libraryId);
        int done = 0,
            failed = 0;
        while (true)
        {
            await context.CheckpointAsync();
            var (batch, remaining) = await repository.Database.ReadAsync(
                db =>
                    (
                        TagEngine.ReadRows(
                            db,
                            "SELECT film_id,part_id,kind FROM media_work WHERE library_id=@lib AND state='pending' ORDER BY CASE kind WHEN 'probe' THEN 0 ELSE 1 END,updated LIMIT 25",
                            r => new MediaWork(r.GetString(0), r.GetString(1), r.GetString(2)),
                            ("@lib", libraryId)
                        ),
                        Convert.ToInt32(
                            db.Scalar(
                                "SELECT COUNT(*) FROM media_work WHERE library_id=@lib AND state='pending'",
                                ("@lib", libraryId)
                            )
                        )
                    ),
                ct
            );
            if (batch.Count == 0)
                break;
            foreach (var item in batch)
            {
                await context.CheckpointAsync();
                await context.ReportAsync(
                    done + failed,
                    done + failed + remaining,
                    item.Kind == Probe
                        ? "host.BackgroundOperations.readingMediaCodecsAndDuration"
                        : "host.BackgroundOperations.checkingLocalNfoFilesAndEnabledMetadata"
                );
                remaining--;
                try
                {
                    if (item.Kind == Probe)
                        await ProbeAsync(item.FilmId, item.PartId, ct);
                    else if (library?.AutoEnrich != false)
                        await sources.EnrichSubjectAsync("film", item.FilmId, ct, automatic: true);
                    await Complete(item, null, ct);
                    done++;
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    await Complete(item, ex.Message, ct);
                    failed++;
                }
            }
        }
        await context.ReportAsync(done + failed, done + failed, "host.MediaPipeline.finished");
        if (failed > 0 && done == 0)
            throw new JobResultFailure("host.MediaPipeline.failed", new { done, failed });
        return new
        {
            libraryId,
            done,
            failed,
        };
    }

    private Task Complete(MediaWork item, string? error, CancellationToken ct) =>
        repository.Database.RunAsync(db => Finish(db, item, error), error is null ? ct : CancellationToken.None);

    private static void Finish(SqliteConnection db, MediaWork item, string? error)
    {
        if (error is null)
            db.Execute(
                "DELETE FROM media_work WHERE film_id=@film AND part_id=@part AND kind=@kind",
                ("@film", item.FilmId),
                ("@part", item.PartId),
                ("@kind", item.Kind)
            );
        else
            db.Execute(
                "UPDATE media_work SET state='failed',attempts=attempts+1,error=@error,updated=@now WHERE film_id=@film AND part_id=@part AND kind=@kind",
                ("@film", item.FilmId),
                ("@part", item.PartId),
                ("@kind", item.Kind),
                ("@error", error.Length > 2000 ? error[..2000] : error),
                ("@now", DateTimeOffset.UtcNow.ToString("O"))
            );
    }

    public async Task<ProbeResult> ProbeAsync(string id, string? partId, CancellationToken ct)
    {
        var film = await repository.GetMediaPartAsync(id, partId, ct);
        var revision = TagEngine.MediaRevision(film);
        await repository.UpdateMediaAsync(
            id,
            f => f with { ProbeState = "pending", ProbeError = null },
            ct,
            film.PartId
        );
        try
        {
            var probe = await ffmpeg.ProbeAsync(film.Path, ct);
            await repository.UpdateMediaAsync(
                id,
                f =>
                    TagEngine.MediaRevision(f) != revision
                        ? throw new TagException("STALE_MEDIA")
                        : f with
                        {
                            ProbeState = "ready",
                            ProbeError = null,
                            Duration = probe.Duration,
                            Width = probe.Width,
                            Height = probe.Height,
                            FrameRate = probe.FrameRate,
                            VideoCodec = probe.VideoCodec,
                            AudioCodec = probe.AudioCodec,
                        },
                ct,
                film.PartId
            );
            await tagging.RecordMediaEventAsync("media.probed", id, new() { ["partId"] = film.PartId }, ct: ct);
            return probe;
        }
        catch (Exception ex)
        {
            await repository.UpdateMediaAsync(
                id,
                f =>
                    TagEngine.MediaRevision(f) != revision
                        ? f
                        : f with
                        {
                            ProbeState = ex is OperationCanceledException ? "unknown" : "failed",
                            ProbeError = ex is OperationCanceledException ? null : ex.Message,
                        },
                CancellationToken.None,
                film.PartId
            );
            throw;
        }
    }

    private static string Id(JsonElement args) => args.GetProperty("id").GetString()!;
}

public sealed record MediaWorkSummary(long Pending, long Failed);
