using Vroom.Core.Domain;
using Vroom.Core.Jobs;
using Vroom.Core.Storage;
using Vroom.Core.Tagging;

namespace Vroom.Core.Media;

/// <summary>
/// Captures sampled content fingerprints (see <see cref="ContentFingerprint"/>) and verifies relinks.
/// Capture is cheap and happens inline when files are discovered; only relink verification is a task.
/// </summary>
public sealed class MediaIdentity
{
    private readonly CatalogRepository repository;
    private readonly TagEngine tagging;
    private readonly JobCoordinator jobs;

    public MediaIdentity(CatalogRepository repository, TagEngine tagging, JobCoordinator jobs)
    {
        this.repository = repository;
        this.tagging = tagging;
        this.jobs = jobs;
        jobs.Register(
            "media.fingerprint",
            async (context, args) =>
            {
                var fileId = args.GetProperty("fileId").GetString()!;
                var fingerprint = await CaptureAsync(
                    args.GetProperty("filmId").GetString()!,
                    fileId,
                    context.CancellationToken
                );
                return new { fileId, fingerprint };
            },
            canRetry: true
        );
        jobs.Register(
            "media.relink.preview",
            async (context, args) =>
            {
                var filmId = args.GetProperty("filmId").GetString()!;
                var fileId = args.GetProperty("fileId").GetString()!;
                var revision = args.GetProperty("revision").GetInt64();
                var file = await repository.ResourceFileAsync(filmId, fileId, context.CancellationToken);
                // If the old location is still available, verify it now. Otherwise only a
                // fingerprint captured before the move can establish content identity.
                if (file.ContentFingerprint is null)
                {
                    if (!File.Exists(file.Path))
                        throw new InvalidOperationException("host.MediaIdentity.fingerprintMissing");
                    var original = await ContentFingerprint.ComputeAsync(file.Path, context.CancellationToken);
                    if (original.Size != file.Size || original.Modified != file.Modified)
                        throw new InvalidOperationException("host.MediaStructure.fileChanged");
                    file = file with { ContentFingerprint = original.Fingerprint };
                }
                var target = await ContentFingerprint.ComputeAsync(
                    args.GetProperty("path").GetString()!,
                    context.CancellationToken
                );
                if (file.ContentFingerprint != target.Fingerprint || file.Size != target.Size)
                    throw new InvalidOperationException("host.MediaIdentity.contentMismatch");
                return await tagging.PreviewRelinkAsync(filmId, revision, file, target, context.CancellationToken);
            },
            canRetry: true
        );
        jobs.Register(
            "media.relink.commit",
            async (context, args) =>
            {
                var token = args.GetProperty("previewToken").GetString()!;
                var target = await tagging.RelinkTargetAsync(token, context.CancellationToken);
                if (target is not null)
                {
                    var actual = await ContentFingerprint.ComputeAsync(target.Path, context.CancellationToken);
                    if (actual != target)
                        throw new InvalidOperationException("host.MediaStructure.fileChanged");
                }
                context.BeginCommit();
                return await tagging.CommitRelinkAsync(token, CancellationToken.None);
            },
            canRetry: true
        );
    }

    /// <summary>Reads the sampled fingerprint and stores it when the file is unchanged since it was indexed.</summary>
    public async Task<string> CaptureAsync(string filmId, string fileId, CancellationToken ct = default)
    {
        var file = await repository.ResourceFileAsync(filmId, fileId, ct);
        var fingerprint = await ContentFingerprint.ComputeAsync(file.Path, ct);
        await repository.Database.RunAsync(
            db =>
            {
                var current = CatalogRepository.Deserialize<MediaFile>(
                    db.Scalar("SELECT payload FROM media_file_projection WHERE id=@id", ("@id", file.Id)) as string
                        ?? throw new InvalidOperationException("host.MediaStructure.fileChanged")
                );
                if (
                    current.Path != fingerprint.Path
                    || current.Size != fingerprint.Size
                    || current.Modified != fingerprint.Modified
                )
                    throw new InvalidOperationException("host.MediaStructure.fileChanged");
                CatalogRepository.SaveMediaFile(db, current with { ContentFingerprint = fingerprint.Fingerprint });
            },
            ct
        );
        return fingerprint.Fingerprint;
    }

    /// <summary>Captures missing fingerprints for the given files; failures stay visible as missing identity.</summary>
    public async Task<int> CaptureMissingAsync(MediaStructure structure, CancellationToken ct = default)
    {
        var captured = 0;
        foreach (
            var file in structure
                .Versions.SelectMany(v => v.Parts.Select(p => p.File))
                .Concat(structure.ResourceSets.SelectMany(s => s.Files))
                .DistinctBy(f => f.Id)
                .Where(f => f.ContentFingerprint is null)
        )
        {
            try
            {
                await CaptureAsync(structure.FilmId, file.Id, ct);
                captured++;
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException or InvalidOperationException) { }
        }
        return captured;
    }

    public Task<string> IdentifyAsync(string filmId, string fileId) =>
        jobs.StartAsync(
            "media.fingerprint",
            "host.MediaIdentity.identifying",
            new { filmId, fileId },
            "identity:" + fileId
        );

    public Task<string> PreviewAsync(string filmId, string fileId, long revision, string path) =>
        jobs.StartAsync(
            "media.relink.preview",
            "host.MediaIdentity.verifying",
            new
            {
                filmId,
                fileId,
                revision,
                path,
            },
            "relink:" + fileId
        );

    public Task<string> CommitAsync(string previewToken) =>
        jobs.StartAsync(
            "media.relink.commit",
            "host.MediaIdentity.relinking",
            new { previewToken },
            "relink-commit:" + previewToken
        );
}
