using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;
using Vroom.Core.Domain;

namespace Vroom.Core.Storage;

public sealed partial class CatalogRepository(CatalogDatabase database)
{
    public event Action<AppSettings>? SettingsChanged;
    public CatalogDatabase Database => database;
    internal static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    internal static string Serialize<T>(T value) => JsonSerializer.Serialize(value, Json);

    internal static T Deserialize<T>(string value) => JsonSerializer.Deserialize<T>(value, Json)!;

    public Task InitializeAsync(CancellationToken ct = default) => database.RunAsync(_ => { }, ct);

    public Task<IReadOnlyList<Library>> LibrariesAsync(CancellationToken ct = default) =>
        database.ReadAsync<IReadOnlyList<Library>>(
            db =>
            {
                using var cmd = db.Command("SELECT payload FROM libraries ORDER BY name");
                using var reader = cmd.ExecuteReader();
                var list = new List<Library>();
                while (reader.Read())
                    list.Add(Deserialize<Library>(reader.GetString(0)));
                return list;
            },
            ct
        );

    public Task SaveLibraryAsync(Library library, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(library.Name))
            throw new ArgumentException("host.CatalogRepository.enterALibraryNameAndAtLeast");
        // Relative roots would resolve against the process directory; reject them instead of guessing.
        if (library.Roots.Any(root => !System.IO.Path.IsPathFullyQualified(root.Trim())))
            throw new ArgumentException("host.CatalogRepository.libraryRootNotAbsolute");
        var normalized = library with
        {
            Name = library.Name.Trim(),
            Roots = library
                .Roots.Select(root =>
                    System.IO.Path.TrimEndingDirectorySeparator(System.IO.Path.GetFullPath(root.Trim()))
                )
                .Distinct(PathComparer)
                .ToArray(),
        };
        return database.RunAsync(
            db =>
            {
                // A folder may belong to one library only, otherwise the same file is indexed twice.
                var others = new List<string>();
                using (var cmd = db.Command("SELECT payload FROM libraries WHERE id<>@id", ("@id", library.Id)))
                using (var reader = cmd.ExecuteReader())
                    while (reader.Read())
                        others.AddRange(Deserialize<Library>(reader.GetString(0)).Roots);
                var roots = normalized.Roots;
                if (
                    roots.Any(root => others.Any(other => Overlaps(root, other)))
                    || roots.Any(root => roots.Any(other => !ReferenceEquals(root, other) && Overlaps(root, other)))
                )
                    throw new ArgumentException("host.CatalogRepository.libraryRootsOverlap");
                db.Execute(
                    "INSERT INTO libraries VALUES(@id,@name,@payload) ON CONFLICT(id) DO UPDATE SET name=@name,payload=@payload",
                    ("@id", library.Id),
                    ("@name", normalized.Name),
                    ("@payload", Serialize(normalized))
                );
            },
            ct
        );
    }

    private static bool Overlaps(string a, string b)
    {
        var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        bool Within(string child, string parent) =>
            child.Equals(parent, comparison)
            || child.StartsWith(
                System.IO.Path.TrimEndingDirectorySeparator(parent) + System.IO.Path.DirectorySeparatorChar,
                comparison
            );
        return Within(a, b) || Within(b, a);
    }

    public static StringComparer PathComparer =>
        OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal;

    private static string PathKey(string path) => OperatingSystem.IsWindows() ? path.ToUpperInvariant() : path;

    internal static Film RequireFilm(SqliteConnection db, string id) =>
        db.Scalar("SELECT payload FROM film_projection WHERE id=@id", ("@id", id)) is string json
            ? Deserialize<Film>(json)
            : throw new KeyNotFoundException("host.CatalogRepository.filmNotFound");

    internal static Film RequirePart(SqliteConnection db, string filmId, string partId) =>
        db.Scalar(
            "SELECT payload FROM media_part_projection WHERE id=@id AND part_id=@part",
            ("@id", filmId),
            ("@part", partId)
        )
            is string json
            ? Deserialize<Film>(json)
            : throw new KeyNotFoundException("host.MediaStructure.partNotFound");

    internal static void SaveFilm(SqliteConnection db, Film film)
    {
        var fileId = film.FileId ?? film.Id;
        var versionId = film.VersionId ?? film.Id + "-version";
        var partId = film.PartId ?? film.Id + "-part";
        db.Execute(
            "INSERT INTO films(id,library_id,added,selected_part_id) VALUES(@id,@lib,@added,@part) ON CONFLICT(id) DO NOTHING",
            ("@id", film.Id),
            ("@lib", film.LibraryId),
            ("@added", film.Added.ToString("O")),
            ("@part", film.Path.Length > 0 ? partId : null)
        );
        if (film.Path.Length == 0)
            return;
        var identity = db.Scalar("SELECT filesystem_identity FROM media_files WHERE id=@id", ("@id", fileId)) as string;
        var stored = db.Scalar("SELECT payload FROM media_file_projection WHERE id=@id", ("@id", fileId)) as string;
        var previousFile = stored is null ? null : Deserialize<MediaFile>(stored);
        SaveMediaFile(
            db,
            new()
            {
                Id = fileId,
                LibraryId = film.LibraryId,
                Path = film.Path,
                FileSystemIdentity = identity,
                Size = film.Size,
                Modified = film.Modified,
                RelativePath = film.RelativePath ?? previousFile?.RelativePath,
                MissingSince = previousFile?.MissingSince,
                ContentFingerprint =
                    previousFile?.Size == film.Size && previousFile.Modified == film.Modified
                        ? previousFile.ContentFingerprint
                        : null,
                ProbeState = film.ProbeState,
                ProbeError = film.ProbeError,
                Duration = film.Duration,
                Width = film.Width,
                Height = film.Height,
                FrameRate = film.FrameRate,
                VideoCodec = film.VideoCodec,
                AudioCodec = film.AudioCodec,
            }
        );
        db.Execute(
            "INSERT INTO media_versions(id,film_id,name,ordinal) VALUES(@id,@film,'',0) ON CONFLICT(id) DO NOTHING",
            ("@id", versionId),
            ("@film", film.Id)
        );
        db.Execute(
            "INSERT INTO media_parts(id,version_id,file_id,ordinal,position) VALUES(@id,@version,@file,0,@position) ON CONFLICT(id) DO UPDATE SET position=@position",
            ("@id", partId),
            ("@version", versionId),
            ("@file", fileId),
            ("@position", film.Position)
        );
    }

    internal static void SaveMediaFile(SqliteConnection db, MediaFile file)
    {
        var facts = JsonSerializer.SerializeToNode(file, Json)!.AsObject();
        foreach (var key in new[] { "id", "libraryId", "path", "fileSystemIdentity" })
            facts.Remove(key);
        db.Execute(
            "INSERT INTO media_files(id,library_id,path,path_key,filesystem_identity,payload) VALUES(@id,@lib,@path,@key,@identity,@payload) ON CONFLICT(id) DO UPDATE SET path=@path,path_key=@key,filesystem_identity=@identity,payload=@payload",
            ("@id", file.Id),
            ("@lib", file.LibraryId),
            ("@path", file.Path),
            ("@key", PathKey(file.Path)),
            ("@identity", file.FileSystemIdentity),
            ("@payload", facts.ToJsonString())
        );
    }

    public Task<Film> GetMediaAsync(string id, CancellationToken ct = default) =>
        database.ReadAsync(db => RequireFilm(db, id), ct);

    public Task<Film> GetMediaPartAsync(string id, string? partId, CancellationToken ct = default) =>
        database.ReadAsync(db => partId is null ? RequireFilm(db, id) : RequirePart(db, id, partId), ct);

    public async Task<Film> ImportMediaAsync(Film film, CancellationToken ct = default) =>
        (await ImportMediaBatchAsync([film], ct))[0];

    /// <summary>Indexes discovered files in one transaction. Seen files are no longer considered missing.</summary>
    public async Task<IReadOnlyList<Film>> ImportMediaBatchAsync(
        IReadOnlyList<Film> films,
        CancellationToken ct = default
    )
    {
        var identities = await Task.Run(() => films.Select(f => FileIdentity.Read(f.Path)).ToArray(), ct);
        return await database.RunAsync<IReadOnlyList<Film>>(
            db =>
            {
                using var tx = db.BeginTransaction();
                var imported = new List<Film>(films.Count);
                for (var i = 0; i < films.Count; i++)
                    imported.Add(ImportCore(db, films[i], identities[i]));
                tx.Commit();
                return imported;
            },
            ct
        );
    }

    private static Film ImportCore(SqliteConnection db, Film film, string? identity)
    {
        var previous =
            db.Scalar(
                "SELECT payload FROM media_part_projection WHERE library_id=@lib AND path_key=@path ORDER BY id,part_id LIMIT 1",
                ("@lib", film.LibraryId),
                ("@path", PathKey(film.Path))
            ) as string;
        if (previous is null && identity is not null)
        {
            var matches = new List<(string Id, string Path)>();
            using (
                var command = db.Command(
                    "SELECT id,path FROM media_files WHERE library_id=@lib AND filesystem_identity=@identity",
                    ("@lib", film.LibraryId),
                    ("@identity", identity)
                )
            )
            using (var reader = command.ExecuteReader())
                while (reader.Read())
                    matches.Add((reader.GetString(0), reader.GetString(1)));
            if (matches.Count == 1 && DefinitelyMissing(matches[0].Path))
            {
                var match = matches[0];
                db.Execute(
                    "UPDATE media_files SET path=@path,path_key=@key WHERE id=@id",
                    ("@path", film.Path),
                    ("@key", PathKey(film.Path)),
                    ("@id", match.Id)
                );
                previous =
                    db.Scalar(
                        "SELECT payload FROM media_part_projection WHERE json_extract(payload,'$.fileId')=@file ORDER BY id,part_id LIMIT 1",
                        ("@file", match.Id)
                    ) as string;
                db.Execute(
                    "INSERT INTO audit(time,tool,summary) VALUES(@time,'media.relocated',@summary)",
                    ("@time", DateTimeOffset.UtcNow.ToString("O")),
                    (
                        "@summary",
                        Serialize(
                            new
                            {
                                fileId = match.Id,
                                from = match.Path,
                                to = film.Path,
                            }
                        )
                    )
                );
            }
        }
        var relativePath = film.RelativePath;
        if (previous is not null)
        {
            var old = Deserialize<Film>(previous);
            if (relativePath is not null)
                old = old with { RelativePath = relativePath };
            film =
                old.Size == film.Size && old.Modified == film.Modified
                    ? old
                    : old with
                    {
                        Size = film.Size,
                        Modified = film.Modified,
                        ProbeState = "unknown",
                        ProbeError = null,
                        Duration = 0,
                        Width = 0,
                        Height = 0,
                        FrameRate = 0,
                        VideoCodec = null,
                        AudioCodec = null,
                    };
        }
        else if (
            db.Scalar(
                "SELECT id FROM media_files WHERE library_id=@lib AND path_key=@path",
                ("@lib", film.LibraryId),
                ("@path", PathKey(film.Path))
            )
            is string fileId
        )
            film = film with { FileId = fileId };
        SaveFilm(db, film);
        if (identity is not null)
            db.Execute(
                "UPDATE media_files SET filesystem_identity=@identity WHERE id=@id",
                ("@identity", identity),
                ("@id", film.FileId ?? film.Id)
            );
        var result = RequirePart(db, film.Id, film.PartId ?? film.Id + "-part");
        db.Execute(
            "UPDATE media_files SET payload=json_remove(payload,'$.missingSince') WHERE id=@id",
            ("@id", result.FileId)
        );
        return result;
    }

    private static bool DefinitelyMissing(string path)
    {
        try
        {
            File.GetAttributes(path);
            return false;
        }
        catch (Exception e) when (e is FileNotFoundException or DirectoryNotFoundException)
        {
            return true;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    public Task UpdateMediaAsync(
        string id,
        Func<Film, Film> change,
        CancellationToken ct = default,
        string? partId = null
    ) =>
        database.RunAsync(
            db =>
            {
                using var tx = db.BeginTransaction();
                var old = partId is null ? RequireFilm(db, id) : RequirePart(db, id, partId);
                var next = change(old);
                if (
                    next.Id != old.Id
                    || next.Path != old.Path
                    || next.LibraryId != old.LibraryId
                    || next.FileId != old.FileId
                    || next.PartId != old.PartId
                    || next.VersionId != old.VersionId
                )
                    throw new ArgumentException(
                        "host.CatalogRepository.mediaIdentityCannotChangeThroughAnnotationEdits"
                    );
                SaveFilm(db, next);
                tx.Commit();
            },
            ct
        );

    public Task SavePositionAsync(
        string filmId,
        string? partId,
        double position,
        string? mediaRevision = null,
        CancellationToken ct = default,
        bool ended = false
    ) =>
        database.RunAsync(
            db =>
            {
                using var tx = db.BeginTransaction();
                var film = partId is null ? RequireFilm(db, filmId) : RequirePart(db, filmId, partId);
                if (!double.IsFinite(position) || position < 0)
                    throw new ArgumentException("host.ClientApi.invalidPlaybackPosition");
                // Storage depends only on the domain model; the stable error code reaches clients unchanged.
                if (mediaRevision is not null && MediaRevisions.Of(film) != mediaRevision)
                    throw new InvalidOperationException("STALE_MEDIA");
                if (film.PartId is null)
                    throw new InvalidOperationException("host.MediaStructure.partNotFound");
                db.Execute(
                    "UPDATE media_parts SET position=@position WHERE id=@id",
                    ("@position", position),
                    ("@id", film.PartId)
                );
                // Host playback history for continue watching and recently played; never a display tag.
                db.Execute(
                    ended
                        ? "INSERT INTO playback_state(film_id,last_played,resume,completed_count,last_completed) VALUES(@film,@now,0,1,@now) ON CONFLICT(film_id) DO UPDATE SET last_played=@now,resume=0,completed_count=completed_count+1,last_completed=@now"
                        : "INSERT INTO playback_state(film_id,last_played,resume) VALUES(@film,@now,@resume) ON CONFLICT(film_id) DO UPDATE SET last_played=@now,resume=@resume",
                    ("@film", filmId),
                    ("@now", DateTimeOffset.UtcNow.ToString("O")),
                    ("@resume", position >= 5 ? 1 : 0)
                );
                tx.Commit();
            },
            ct
        );

    public Task<IReadOnlyList<SavedView>> ViewsAsync(CancellationToken ct = default) =>
        database.ReadAsync<IReadOnlyList<SavedView>>(
            db =>
            {
                using var cmd = db.Command("SELECT id,name,query FROM views ORDER BY name");
                using var r = cmd.ExecuteReader();
                var list = new List<SavedView>();
                while (r.Read())
                    list.Add(new(r.GetString(0), r.GetString(1), Deserialize<QuerySpec>(r.GetString(2))));
                return list;
            },
            ct
        );

    public Task DeleteViewAsync(string id, CancellationToken ct = default) =>
        database.RunAsync(db => db.Execute("DELETE FROM views WHERE id=@id", ("@id", id)), ct);

    public Task<AppSettings> SettingsAsync(CancellationToken ct = default) =>
        database.ReadAsync(
            db =>
                db.Scalar("SELECT value FROM settings WHERE key='app'") is string json
                    ? Deserialize<AppSettings>(json)
                    : new AppSettings(),
            ct
        );

    public async Task SaveSettingsAsync(AppSettings settings, CancellationToken ct = default)
    {
        Vroom.Core.Media.ExternalPlayers.ValidatePaths(settings.ExternalPlayerPaths);
        (settings.Network ?? throw new ArgumentException("host.Network.invalidProxy")).Validate();
        await database.RunAsync(
            db =>
                db.Execute(
                    "INSERT INTO settings VALUES('app',@json) ON CONFLICT(key) DO UPDATE SET value=@json",
                    ("@json", Serialize(settings))
                ),
            ct
        );
        SettingsChanged?.Invoke(settings);
    }

    public async Task<AppSettings> PatchSettingsAsync(JsonObject patch, CancellationToken ct = default)
    {
        var result = await database.RunAsync(
            db =>
            {
                using var tx = db.BeginTransaction();
                var current = db.Scalar("SELECT value FROM settings WHERE key='app'") is string json
                    ? Deserialize<AppSettings>(json)
                    : new AppSettings();
                var merged = JsonSerializer.SerializeToNode(current, Json)!.AsObject();
                foreach (var property in patch)
                {
                    if (!merged.ContainsKey(property.Key) || property.Value is null)
                        throw new ArgumentException("host.CatalogRepository.invalidSettingsPatch");
                    merged[property.Key] = property.Value.DeepClone();
                }
                AppSettings updated;
                try
                {
                    updated = merged.Deserialize<AppSettings>(Json)!;
                }
                catch (JsonException e)
                {
                    throw new ArgumentException("host.CatalogRepository.invalidSettingsPatch", e);
                }
                Vroom.Core.Media.ExternalPlayers.ValidatePaths(updated.ExternalPlayerPaths);
                (updated.Network ?? throw new ArgumentException("host.Network.invalidProxy")).Validate();
                db.Execute(
                    "INSERT INTO settings VALUES('app',@json) ON CONFLICT(key) DO UPDATE SET value=@json",
                    ("@json", Serialize(updated))
                );
                tx.Commit();
                return updated;
            },
            ct
        );
        SettingsChanged?.Invoke(result);
        return result;
    }

    public Task AuditAsync(string tool, string summary, CancellationToken ct = default) =>
        database.RunAsync(
            db =>
                db.Execute(
                    "INSERT INTO audit(time,tool,summary) VALUES(@time,@tool,@summary)",
                    ("@time", DateTimeOffset.UtcNow.ToString("O")),
                    ("@tool", tool),
                    ("@summary", summary)
                ),
            ct
        );

    /// <summary>Recent audit entries as structured records; clients format time and text locally.</summary>
    public Task<IReadOnlyList<AuditEntry>> AuditLogAsync(CancellationToken ct = default) =>
        database.ReadAsync<IReadOnlyList<AuditEntry>>(
            db =>
            {
                using var cmd = db.Command("SELECT time,tool,summary FROM audit ORDER BY id DESC LIMIT 100");
                using var r = cmd.ExecuteReader();
                var result = new List<AuditEntry>();
                while (r.Read())
                    result.Add(
                        new(
                            DateTimeOffset.Parse(r.GetString(0), System.Globalization.CultureInfo.InvariantCulture),
                            r.GetString(1),
                            r.GetString(2)
                        )
                    );
                return result;
            },
            ct
        );
}

public sealed record AuditEntry(DateTimeOffset Time, string Operation, string Summary);
