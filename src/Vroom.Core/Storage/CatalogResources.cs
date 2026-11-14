using Microsoft.Data.Sqlite;
using Vroom.Core.Domain;

namespace Vroom.Core.Storage;

public sealed partial class CatalogRepository
{
    private static List<T> ResourceRows<T>(
        SqliteConnection db,
        string sql,
        Func<SqliteDataReader, T> read,
        params (string Name, object? Value)[] args
    )
    {
        using var command = db.Command(sql, args);
        using var reader = command.ExecuteReader();
        var values = new List<T>();
        while (reader.Read())
            values.Add(read(reader));
        return values;
    }

    public Task<MediaStructure> ResourcesAsync(string filmId, CancellationToken ct = default) =>
        database.ReadAsync(db => ReadResources(db, filmId), ct);

    internal static MediaStructure ReadResources(SqliteConnection db, string filmId)
    {
        var film = RequireFilm(db, filmId);
        var versions = ResourceRows(
            db,
            "SELECT id,name,ordinal FROM media_versions WHERE film_id=@id ORDER BY ordinal",
            r => (Id: r.GetString(0), Name: r.GetString(1), Ordinal: r.GetInt32(2)),
            ("@id", filmId)
        );
        var parts = ResourceRows(
            db,
            "SELECT p.version_id,p.id,p.file_id,p.ordinal,p.position,m.payload FROM media_parts p JOIN media_versions v ON v.id=p.version_id JOIN media_file_projection m ON m.id=p.file_id WHERE v.film_id=@id ORDER BY p.ordinal",
            r =>
                (
                    Version: r.GetString(0),
                    Part: new MediaPart(
                        r.GetString(1),
                        r.GetString(2),
                        r.GetInt32(3),
                        r.GetDouble(4),
                        Deserialize<MediaFile>(r.GetString(5))
                    )
                ),
            ("@id", filmId)
        );
        var sets = ResourceRows(
            db,
            "SELECT id,name,version_id,part_id FROM resource_sets WHERE film_id=@id ORDER BY name,id",
            r =>
                (
                    Id: r.GetString(0),
                    Name: r.GetString(1),
                    Version: r.IsDBNull(2) ? null : r.GetString(2),
                    Part: r.IsDBNull(3) ? null : r.GetString(3)
                ),
            ("@id", filmId)
        );
        var files = ResourceRows(
            db,
            "SELECT r.set_id,m.payload FROM resource_members r JOIN resource_sets s ON s.id=r.set_id JOIN media_file_projection m ON m.id=r.file_id WHERE s.film_id=@id ORDER BY r.ordinal",
            r => (Set: r.GetString(0), File: Deserialize<MediaFile>(r.GetString(1))),
            ("@id", filmId)
        );
        var byVersion = parts.ToLookup(p => p.Version, p => p.Part);
        var bySet = files.ToLookup(p => p.Set, p => p.File);
        return new(
            filmId,
            film.StructureRevision,
            film.PartId,
            versions.Select(v => new MediaVersion(v.Id, v.Name, v.Ordinal, byVersion[v.Id].ToArray())).ToArray(),
            sets.Select(s => new ResourceSet(s.Id, s.Name, s.Version, s.Part, bySet[s.Id].ToArray())).ToArray()
        );
    }

    private static Film CheckStructure(SqliteConnection db, string id, long revision)
    {
        var film = RequireFilm(db, id);
        if (film.StructureRevision != revision)
            throw new InvalidOperationException("host.MediaStructure.stale");
        return film;
    }

    private static void Name(string value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > 200)
            throw new ArgumentException("host.MediaStructure.invalidName");
    }

    private static void Changed(SqliteConnection db, string filmId, string operation)
    {
        db.Execute("UPDATE films SET revision=revision+1 WHERE id=@id", ("@id", filmId));
        db.Execute(
            "INSERT INTO audit(time,tool,summary) VALUES(@time,@operation,@id)",
            ("@time", DateTimeOffset.UtcNow.ToString("O")),
            ("@operation", operation),
            ("@id", filmId)
        );
    }

    private async Task<MediaFile[]> InspectFilesAsync(string filmId, IReadOnlyList<string> paths, CancellationToken ct)
    {
        if (paths.Count is < 1 or > 1000 || paths.Distinct(PathComparer).Count() != paths.Count)
            throw new ArgumentException("host.MediaStructure.invalidFiles");
        var film = await GetMediaAsync(filmId, ct);
        return await Task.Run(
            () =>
                paths
                    .Select(path =>
                    {
                        ct.ThrowIfCancellationRequested();
                        if (!Path.IsPathFullyQualified(path))
                            throw new ArgumentException("host.MediaStructure.invalidFiles");
                        var item = new FileInfo(Path.GetFullPath(path));
                        if (!item.Exists || item.LinkTarget is not null)
                            throw new IOException("host.Journey.mediaOffline");
                        return new MediaFile
                        {
                            Id = Guid.NewGuid().ToString("N"),
                            LibraryId = film.LibraryId,
                            Path = item.FullName,
                            Size = item.Length,
                            Modified = item.LastWriteTimeUtc,
                            FileSystemIdentity = FileIdentity.Read(item.FullName),
                        };
                    })
                    .ToArray(),
            ct
        );
    }

    private static MediaFile RegisterResource(SqliteConnection db, MediaFile file)
    {
        var current = new FileInfo(file.Path);
        if (!current.Exists || current.Length != file.Size || current.LastWriteTimeUtc != file.Modified.UtcDateTime)
            throw new InvalidOperationException("host.MediaStructure.fileChanged");
        if (
            db.Scalar(
                "SELECT payload FROM media_file_projection WHERE library_id=@lib AND path_key=@path",
                ("@lib", file.LibraryId),
                ("@path", PathKey(file.Path))
            )
            is string json
        )
        {
            var existing = Deserialize<MediaFile>(json);
            if (existing.Size != file.Size || existing.Modified != file.Modified)
                throw new InvalidOperationException("host.MediaStructure.fileChanged");
            return existing;
        }
        SaveMediaFile(db, file);
        return file;
    }

    public async Task<MediaStructure> AddVersionAsync(
        string filmId,
        long revision,
        string name,
        IReadOnlyList<string> paths,
        CancellationToken ct = default
    )
    {
        CheckPartFiles(paths);
        Name(name);
        var files = await InspectFilesAsync(filmId, paths, ct);
        return await database.RunAsync(
            db =>
            {
                using var tx = db.BeginTransaction();
                var film = CheckStructure(db, filmId, revision);
                var id = Guid.NewGuid().ToString("N");
                var ordinal = Convert.ToInt32(
                    db.Scalar(
                        "SELECT COALESCE(MAX(ordinal),-1)+1 FROM media_versions WHERE film_id=@id",
                        ("@id", filmId)
                    )
                );
                db.Execute(
                    "INSERT INTO media_versions VALUES(@id,@film,@name,@ordinal)",
                    ("@id", id),
                    ("@film", filmId),
                    ("@name", name.Trim()),
                    ("@ordinal", ordinal)
                );
                string? first = null;
                for (var i = 0; i < files.Length; i++)
                {
                    var file = RegisterResource(db, files[i]);
                    var part = Guid.NewGuid().ToString("N");
                    first ??= part;
                    db.Execute(
                        "INSERT INTO media_parts VALUES(@id,@version,@file,@ordinal,0)",
                        ("@id", part),
                        ("@version", id),
                        ("@file", file.Id),
                        ("@ordinal", i)
                    );
                }
                if (film.PartId is null)
                    db.Execute(
                        "UPDATE films SET selected_part_id=@part WHERE id=@id",
                        ("@part", first),
                        ("@id", filmId)
                    );
                Changed(db, filmId, "media.version.add");
                var result = ReadResources(db, filmId);
                tx.Commit();
                return result;
            },
            ct
        );
    }

    public async Task<MediaStructure> AddResourceSetAsync(
        string filmId,
        long revision,
        string name,
        IReadOnlyList<string> paths,
        string? versionId = null,
        string? partId = null,
        CancellationToken ct = default
    )
    {
        Name(name);
        var files = await InspectFilesAsync(filmId, paths, ct);
        return await database.RunAsync(
            db =>
            {
                using var tx = db.BeginTransaction();
                CheckStructure(db, filmId, revision);
                var id = Guid.NewGuid().ToString("N");
                if (
                    versionId is not null
                    && db.Scalar("SELECT film_id FROM media_versions WHERE id=@id", ("@id", versionId)) as string
                        != filmId
                )
                    throw new ArgumentException("host.MediaStructure.invalidTarget");
                if (partId is not null)
                {
                    var part = RequirePart(db, filmId, partId);
                    if (versionId is not null && part.VersionId != versionId)
                        throw new ArgumentException("host.MediaStructure.invalidTarget");
                    versionId = part.VersionId;
                }
                db.Execute(
                    "INSERT INTO resource_sets VALUES(@id,@film,@version,@part,@name)",
                    ("@id", id),
                    ("@film", filmId),
                    ("@version", versionId),
                    ("@part", partId),
                    ("@name", name.Trim())
                );
                for (var i = 0; i < files.Length; i++)
                {
                    var file = RegisterResource(db, files[i]);
                    db.Execute(
                        "INSERT INTO resource_members VALUES(@set,@file,@ordinal)",
                        ("@set", id),
                        ("@file", file.Id),
                        ("@ordinal", i)
                    );
                }
                Changed(db, filmId, "media.resources.add");
                var result = ReadResources(db, filmId);
                tx.Commit();
                return result;
            },
            ct
        );
    }

    public async Task<MediaStructure> AddResourceFilesAsync(
        string filmId,
        long revision,
        string targetId,
        bool parts,
        IReadOnlyList<string> paths,
        CancellationToken ct = default
    )
    {
        if (parts)
            CheckPartFiles(paths);
        var files = await InspectFilesAsync(filmId, paths, ct);
        return await database.RunAsync(
            db =>
            {
                using var tx = db.BeginTransaction();
                CheckStructure(db, filmId, revision);
                var table = parts ? "media_versions" : "resource_sets";
                if (db.Scalar($"SELECT film_id FROM {table} WHERE id=@id", ("@id", targetId)) as string != filmId)
                    throw new ArgumentException("host.MediaStructure.invalidTarget");
                var ordinal = Convert.ToInt32(
                    db.Scalar(
                        parts
                            ? "SELECT COALESCE(MAX(ordinal),-1)+1 FROM media_parts WHERE version_id=@id"
                            : "SELECT COALESCE(MAX(ordinal),-1)+1 FROM resource_members WHERE set_id=@id",
                        ("@id", targetId)
                    )
                );
                foreach (var inspected in files)
                {
                    var file = RegisterResource(db, inspected);
                    if (parts)
                        db.Execute(
                            "INSERT INTO media_parts VALUES(@id,@target,@file,@ordinal,0)",
                            ("@id", Guid.NewGuid().ToString("N")),
                            ("@target", targetId),
                            ("@file", file.Id),
                            ("@ordinal", ordinal++)
                        );
                    else
                        db.Execute(
                            "INSERT INTO resource_members VALUES(@target,@file,@ordinal)",
                            ("@target", targetId),
                            ("@file", file.Id),
                            ("@ordinal", ordinal++)
                        );
                }
                RepairSelection(db, filmId);
                Changed(db, filmId, parts ? "media.parts.add" : "media.resources.attach");
                var result = ReadResources(db, filmId);
                tx.Commit();
                return result;
            },
            ct
        );
    }

    private static void CheckPartFiles(IReadOnlyList<string> paths)
    {
        if (paths.Any(path => !MediaFormats.VideoExtensions.Contains(Path.GetExtension(path))))
            throw new ArgumentException("host.Journey.unsupportedFile");
    }

    private static void RepairSelection(SqliteConnection db, string filmId) =>
        db.Execute(
            "UPDATE films SET selected_part_id=(SELECT p.id FROM media_parts p JOIN media_versions v ON v.id=p.version_id WHERE v.film_id=@id ORDER BY v.ordinal,p.ordinal LIMIT 1) WHERE id=@id AND (selected_part_id IS NULL OR NOT EXISTS(SELECT 1 FROM media_parts WHERE id=films.selected_part_id))",
            ("@id", filmId)
        );

    public Task<MediaFile> ResourceFileAsync(string filmId, string fileId, CancellationToken ct = default) =>
        database.ReadAsync(
            db =>
                db.Scalar(
                    "SELECT m.payload FROM media_file_projection m WHERE m.id=@file AND (EXISTS(SELECT 1 FROM media_parts p JOIN media_versions v ON v.id=p.version_id WHERE p.file_id=m.id AND v.film_id=@film) OR EXISTS(SELECT 1 FROM resource_members r JOIN resource_sets s ON s.id=r.set_id WHERE r.file_id=m.id AND s.film_id=@film))",
                    ("@file", fileId),
                    ("@film", filmId)
                )
                    is string json
                    ? Deserialize<MediaFile>(json)
                    : throw new ArgumentException("host.MediaStructure.invalidTarget"),
            ct
        );

    public Task<MediaStructure> ChangeResourcesAsync(
        string filmId,
        long revision,
        string operation,
        string id,
        string? name = null,
        IReadOnlyList<string>? order = null,
        CancellationToken ct = default,
        Action<SqliteConnection>? validate = null
    ) =>
        database.RunAsync(
            db =>
            {
                using var tx = db.BeginTransaction();
                CheckStructure(db, filmId, revision);
                var structure = ReadResources(db, filmId);
                switch (operation)
                {
                    case "select-part":
                        RequirePart(db, filmId, id);
                        db.Execute(
                            "UPDATE films SET selected_part_id=@part WHERE id=@id",
                            ("@part", id),
                            ("@id", filmId)
                        );
                        break;
                    case "rename-version":
                        Name(name ?? "");
                        if (!structure.Versions.Any(v => v.Id == id))
                            throw new ArgumentException("host.MediaStructure.invalidTarget");
                        db.Execute(
                            "UPDATE media_versions SET name=@name WHERE id=@id",
                            ("@name", name!.Trim()),
                            ("@id", id)
                        );
                        break;
                    case "rename-set":
                        Name(name ?? "");
                        if (!structure.ResourceSets.Any(s => s.Id == id))
                            throw new ArgumentException("host.MediaStructure.invalidTarget");
                        db.Execute(
                            "UPDATE resource_sets SET name=@name WHERE id=@id",
                            ("@name", name!.Trim()),
                            ("@id", id)
                        );
                        break;
                    case "remove-set":
                        if (!structure.ResourceSets.Any(s => s.Id == id))
                            throw new ArgumentException("host.MediaStructure.invalidTarget");
                        db.Execute("DELETE FROM resource_sets WHERE id=@id", ("@id", id));
                        break;
                    case "remove-part":
                        RequirePart(db, filmId, id);
                        db.Execute("UPDATE resource_sets SET part_id=NULL WHERE part_id=@id", ("@id", id));
                        db.Execute("DELETE FROM media_parts WHERE id=@id", ("@id", id));
                        RepairSelection(db, filmId);
                        break;
                    case "remove-version":
                        if (!structure.Versions.Any(v => v.Id == id))
                            throw new ArgumentException("host.MediaStructure.invalidTarget");
                        db.Execute(
                            "UPDATE resource_sets SET part_id=NULL,version_id=NULL WHERE version_id=@id",
                            ("@id", id)
                        );
                        db.Execute("DELETE FROM media_versions WHERE id=@id", ("@id", id));
                        RepairSelection(db, filmId);
                        break;
                    case "detach-file":
                        if (!structure.ResourceSets.Any(s => s.Id == id && s.Files.Any(f => f.Id == name)))
                            throw new ArgumentException("host.MediaStructure.invalidTarget");
                        db.Execute(
                            "DELETE FROM resource_members WHERE set_id=@id AND file_id=@file",
                            ("@id", id),
                            ("@file", name)
                        );
                        break;
                    case "reorder-parts":
                        var version =
                            structure.Versions.SingleOrDefault(v => v.Id == id)
                            ?? throw new ArgumentException("host.MediaStructure.invalidTarget");
                        if (
                            order is null
                            || order.Count != version.Parts.Count
                            || order.Distinct().Count() != order.Count
                            || order.Except(version.Parts.Select(p => p.Id)).Any()
                        )
                            throw new ArgumentException("host.MediaStructure.invalidOrder");
                        db.Execute("UPDATE media_parts SET ordinal=-ordinal-1 WHERE version_id=@id", ("@id", id));
                        for (var i = 0; i < order.Count; i++)
                            db.Execute(
                                "UPDATE media_parts SET ordinal=@ordinal WHERE id=@id",
                                ("@ordinal", i),
                                ("@id", order[i])
                            );
                        break;
                    case "reorder-versions":
                        if (
                            id != filmId
                            || order is null
                            || order.Count != structure.Versions.Count
                            || order.Distinct().Count() != order.Count
                            || order.Except(structure.Versions.Select(v => v.Id)).Any()
                        )
                            throw new ArgumentException("host.MediaStructure.invalidOrder");
                        db.Execute("UPDATE media_versions SET ordinal=-ordinal-1 WHERE film_id=@id", ("@id", filmId));
                        for (var i = 0; i < order.Count; i++)
                            db.Execute(
                                "UPDATE media_versions SET ordinal=@ordinal WHERE id=@id",
                                ("@ordinal", i),
                                ("@id", order[i])
                            );
                        break;
                    default:
                        throw new ArgumentException("host.MediaStructure.invalidOperation");
                }
                validate?.Invoke(db);
                Changed(db, filmId, "media.structure." + operation);
                var result = ReadResources(db, filmId);
                tx.Commit();
                return result;
            },
            ct
        );
}
