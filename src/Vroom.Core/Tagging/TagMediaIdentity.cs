using System.Text.Json.Nodes;
using Vroom.Core.Domain;
using Vroom.Core.Media;
using Vroom.Core.Storage;

namespace Vroom.Core.Tagging;

public sealed partial class TagEngine
{
    internal Task<FileFingerprint?> RelinkTargetAsync(string token, CancellationToken ct) =>
        repository.Database.ReadAsync(
            db =>
            {
                var (p, _, done) = Preview(db, token, "media-relink");
                return done is not null
                    ? null
                    : CatalogRepository.Deserialize<FileFingerprint>(p["target"]!.ToJsonString());
            },
            ct
        );

    internal async Task<JsonObject> PreviewRelinkAsync(
        string filmId,
        long revision,
        MediaFile original,
        FileFingerprint target,
        CancellationToken ct
    )
    {
        await InitializeAsync(ct);
        return await repository.Database.RunAsync(
            db =>
            {
                if (CatalogRepository.RequireFilm(db, filmId).StructureRevision != revision)
                    throw new TagException("STALE_MEDIA");
                var token = Guid.NewGuid().ToString("N");
                var preview = new JsonObject
                {
                    ["filmId"] = filmId,
                    ["revision"] = revision,
                    ["original"] = TagJson.Object(original),
                    ["target"] = TagJson.Object(target),
                };
                db.Execute(
                    "INSERT INTO tag_previews VALUES(@id,'media-relink',@generation,@payload,NULL,@now)",
                    ("@id", token),
                    ("@generation", Generation(db)),
                    ("@payload", preview.ToJsonString()),
                    ("@now", Now)
                );
                return new JsonObject
                {
                    ["previewToken"] = token,
                    ["filmId"] = filmId,
                    ["fileId"] = original.Id,
                    ["from"] = original.Path,
                    ["to"] = target.Path,
                    ["size"] = target.Size,
                };
            },
            ct
        );
    }

    public async Task<object> CommitRelinkAsync(string token, CancellationToken ct = default)
    {
        await InitializeAsync(ct);
        return await repository.Database.RunAsync(
            db =>
            {
                using var tx = db.BeginTransaction();
                var (p, g, done) = Preview(db, token, "media-relink");
                if (done is not null)
                    return JsonNode.Parse(done)!;
                if (g != Generation(db))
                    throw new TagException("STALE_GENERATION");
                var filmId = p.Text("filmId");
                var original = CatalogRepository.Deserialize<MediaFile>(p["original"]!.ToJsonString());
                var target = CatalogRepository.Deserialize<FileFingerprint>(p["target"]!.ToJsonString());
                if (CatalogRepository.RequireFilm(db, filmId).StructureRevision != p.Number("revision"))
                    throw new TagException("STALE_MEDIA");
                var current = CatalogRepository.Deserialize<MediaFile>(
                    db.Scalar("SELECT payload FROM media_file_projection WHERE id=@id", ("@id", original.Id)) as string
                        ?? throw new TagException("STALE_MEDIA")
                );
                if (
                    current.Path != original.Path
                    || current.Size != original.Size
                    || current.Modified != original.Modified
                )
                    throw new TagException("STALE_MEDIA");
                var info = new FileInfo(target.Path);
                if (
                    !info.Exists
                    || info.LinkTarget is not null
                    || info.Length != target.Size
                    || info.LastWriteTimeUtc != target.Modified.UtcDateTime
                    || FileIdentity.Read(target.Path) != target.FileSystemIdentity
                )
                    throw new TagException("STALE_MEDIA");
                var conflict = db.Scalar(
                    "SELECT id FROM media_files WHERE library_id=@lib AND path_key=@path AND id<>@id",
                    ("@lib", current.LibraryId),
                    ("@path", OperatingSystem.IsWindows() ? target.Path.ToUpperInvariant() : target.Path),
                    ("@id", current.Id)
                );
                if (conflict is not null)
                    throw new InvalidOperationException("host.MediaIdentity.alreadyRegistered");
                var parts = ReadRows(
                    db,
                    "SELECT payload FROM media_part_projection WHERE json_extract(payload,'$.fileId')=@id",
                    r => CatalogRepository.Deserialize<Film>(r.GetString(0)),
                    ("@id", original.Id)
                );
                CatalogRepository.SaveMediaFile(
                    db,
                    current with
                    {
                        Path = target.Path,
                        Modified = target.Modified,
                        Size = target.Size,
                        FileSystemIdentity = target.FileSystemIdentity,
                        ContentFingerprint = target.Fingerprint,
                    }
                );
                var c = Current(db);
                foreach (var before in parts)
                {
                    var after = CatalogRepository.RequirePart(db, before.Id, before.PartId!);
                    var stamp = MediaRevision(after);
                    if (stamp == MediaRevision(before))
                        continue;
                    foreach (
                        var record in Records(db, before.Id)
                            .Where(r =>
                                r["scope"].Text("kind") != "whole"
                                && r["scope"].Text("partId") == before.PartId
                                && r["scope"].Text("mediaRevision") == MediaRevision(before)
                            )
                    )
                    {
                        record["scope"]!["mediaRevision"] = stamp;
                        record["revision"] = record.Number("revision") + 1;
                        record["modified"] = Now;
                        var json = record.ToJsonString();
                        db.Execute(
                            "INSERT INTO tag_history VALUES(@id,@revision,@payload)",
                            ("@id", record.Text("id")),
                            ("@revision", (long)record.Number("revision")),
                            ("@payload", json)
                        );
                        db.Execute(
                            "UPDATE tag_heads SET revision=@revision,payload=@payload WHERE id=@id",
                            ("@id", record.Text("id")),
                            ("@revision", (long)record.Number("revision")),
                            ("@payload", json)
                        );
                        ProjectRecord(db, c, record);
                    }
                    db.Execute(
                        "UPDATE tag_candidates SET payload=json_set(payload,'$.mediaRevision',@stamp) WHERE subject_id=@film AND state='pending' AND json_extract(payload,'$.subjectKind')='film' AND json_extract(payload,'$.partId')=@part AND json_extract(payload,'$.mediaRevision')=@before",
                        ("@film", before.Id),
                        ("@part", before.PartId),
                        ("@stamp", stamp),
                        ("@before", MediaRevision(before))
                    );
                }
                db.Execute(
                    "UPDATE films SET revision=revision+1 WHERE id IN (SELECT v.film_id FROM media_parts p JOIN media_versions v ON v.id=p.version_id WHERE p.file_id=@file UNION SELECT s.film_id FROM resource_sets s JOIN resource_members r ON r.set_id=s.id WHERE r.file_id=@file)",
                    ("@file", current.Id)
                );
                var result = new JsonObject
                {
                    ["filmId"] = filmId,
                    ["fileId"] = current.Id,
                    ["path"] = target.Path,
                };
                ProjectDefaults(
                    db,
                    c,
                    ReadRows(
                        db,
                        "SELECT v.film_id FROM media_parts p JOIN media_versions v ON v.id=p.version_id WHERE p.file_id=@file",
                        r => r.GetString(0),
                        ("@file", current.Id)
                    )
                );
                Audit(db, "media.relink", p);
                db.Execute(
                    "UPDATE tag_previews SET result=@result WHERE id=@id",
                    ("@result", result.ToJsonString()),
                    ("@id", token)
                );
                ValidateTermGraph(db);
                tx.Commit();
                return result;
            },
            ct
        );
    }
}
