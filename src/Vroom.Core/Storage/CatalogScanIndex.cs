using Vroom.Core.Domain;

namespace Vroom.Core.Storage;

/// <summary>What a scan needs to know about an indexed file to decide whether it changed.</summary>
public sealed record IndexedFile(
    string FilmId,
    string PartId,
    string FileId,
    string Path,
    long Size,
    DateTimeOffset Modified,
    bool HasFingerprint,
    bool Missing
);

public sealed partial class CatalogRepository
{
    /// <summary>All files of a library keyed by their platform path key (a read snapshot, no write lock).</summary>
    public Task<IReadOnlyDictionary<string, IndexedFile>> LibraryIndexAsync(
        string libraryId,
        CancellationToken ct = default
    ) =>
        database.ReadAsync<IReadOnlyDictionary<string, IndexedFile>>(
            db =>
            {
                var index = new Dictionary<string, IndexedFile>(StringComparer.Ordinal);
                using var command = db.Command(
                    "SELECT v.film_id,p.id,m.id,m.path,m.path_key,m.payload FROM media_file_projection m JOIN media_parts p ON p.file_id=m.id JOIN media_versions v ON v.id=p.version_id WHERE m.library_id=@lib",
                    ("@lib", libraryId)
                );
                using var reader = command.ExecuteReader();
                while (reader.Read())
                {
                    var file = Deserialize<MediaFile>(reader.GetString(5));
                    index.TryAdd(
                        reader.GetString(4),
                        new(
                            reader.GetString(0),
                            reader.GetString(1),
                            reader.GetString(2),
                            reader.GetString(3),
                            file.Size,
                            file.Modified,
                            file.ContentFingerprint is not null,
                            file.MissingSince is not null
                        )
                    );
                }
                return index;
            },
            ct
        );

    public static string PathKeyOf(string path) => PathKey(path);

    /// <summary>Stores sampled fingerprints for files that have not changed since they were read.</summary>
    public Task SetFingerprintsAsync(
        IReadOnlyList<(string FileId, long Size, DateTimeOffset Modified, string Fingerprint)> values,
        CancellationToken ct = default
    ) =>
        values.Count == 0
            ? Task.CompletedTask
            : database.RunAsync(
                db =>
                {
                    using var tx = db.BeginTransaction();
                    foreach (var value in values)
                    {
                        if (
                            db.Scalar("SELECT payload FROM media_file_projection WHERE id=@id", ("@id", value.FileId))
                            is not string json
                        )
                            continue;
                        var current = Deserialize<MediaFile>(json);
                        if (current.Size == value.Size && current.Modified == value.Modified)
                            SaveMediaFile(db, current with { ContentFingerprint = value.Fingerprint });
                    }
                    tx.Commit();
                },
                ct
            );

    /// <summary>Marks files as missing (or present again). Missing files keep their annotations and history.</summary>
    public Task SetMissingAsync(IReadOnlyCollection<string> fileIds, bool missing, CancellationToken ct = default) =>
        fileIds.Count == 0
            ? Task.CompletedTask
            : database.RunAsync(
                db =>
                {
                    using var tx = db.BeginTransaction();
                    var now = DateTimeOffset.UtcNow.ToString("O");
                    foreach (var id in fileIds)
                        db.Execute(
                            missing
                                ? "UPDATE media_files SET payload=json_set(payload,'$.missingSince',@now) WHERE id=@id AND json_extract(payload,'$.missingSince') IS NULL"
                                : "UPDATE media_files SET payload=json_remove(payload,'$.missingSince') WHERE id=@id",
                            ("@id", id),
                            ("@now", now)
                        );
                    tx.Commit();
                },
                ct
            );
}
