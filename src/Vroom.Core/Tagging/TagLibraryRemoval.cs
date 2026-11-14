using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;
using Vroom.Core.Storage;

namespace Vroom.Core.Tagging;

public sealed partial class TagEngine
{
    /// <summary>
    /// Removes a library from the catalog. Source files stay on disk. The library's annotations,
    /// history and media structure are first written to an importable archive bundle under
    /// <c>backups/</c>; then films, files and every annotation projection row are removed in one
    /// transaction so no orphaned annotation, reference edge or candidate remains.
    /// </summary>
    public async Task<JsonObject> RemoveLibraryAsync(string libraryId, CancellationToken ct = default)
    {
        await InitializeAsync(ct);
        var (name, films) = await repository.Database.ReadAsync(
            db =>
                (
                    db.Scalar("SELECT name FROM libraries WHERE id=@id", ("@id", libraryId)) as string
                        ?? throw new KeyNotFoundException("host.Journey.libraryMissing"),
                    ReadRows(db, "SELECT id FROM films WHERE library_id=@id", r => r.GetString(0), ("@id", libraryId))
                        .ToHashSet(StringComparer.Ordinal)
                ),
            ct
        );
        return await RemoveAsync(
            films,
            "library-" + libraryId,
            db =>
            {
                db.Execute(
                    "DELETE FROM resource_members WHERE file_id IN (SELECT id FROM media_files WHERE library_id=@id)",
                    ("@id", libraryId)
                );
                db.Execute("DELETE FROM media_files WHERE library_id=@id", ("@id", libraryId));
                db.Execute("DELETE FROM libraries WHERE id=@id", ("@id", libraryId));
            },
            new JsonObject
            {
                ["operation"] = "library.remove",
                ["libraryId"] = libraryId,
                ["name"] = name,
            },
            ct
        );
    }

    /// <summary>
    /// Removes individual films from the catalog (source files stay on disk) with the same archive
    /// and cleanup guarantees as library removal. Files no longer used by any film are forgotten.
    /// </summary>
    public async Task<JsonObject> RemoveFilmsAsync(IReadOnlyCollection<string> filmIds, CancellationToken ct = default)
    {
        await InitializeAsync(ct);
        if (filmIds.Count == 0 || filmIds.Count > 100_000)
            throw new TagException("TARGETS_REQUIRED");
        return await RemoveAsync(
            filmIds.ToHashSet(StringComparer.Ordinal),
            "films",
            db =>
            {
                db.Execute(
                    "DELETE FROM resource_members WHERE file_id NOT IN (SELECT file_id FROM media_parts) AND set_id NOT IN (SELECT id FROM resource_sets)"
                );
                db.Execute(
                    "DELETE FROM media_files WHERE id NOT IN (SELECT file_id FROM media_parts) AND id NOT IN (SELECT file_id FROM resource_members)"
                );
            },
            new JsonObject { ["operation"] = "film.remove" },
            ct
        );
    }

    private async Task<JsonObject> RemoveAsync(
        IReadOnlySet<string> films,
        string archiveName,
        Action<SqliteConnection> afterFilms,
        JsonObject audit,
        CancellationToken ct
    )
    {
        var archive = await ExportAsync("bundle", archive: true, ct, films);
        var backups = Path.Combine(repository.Database.DataDirectory, "backups");
        Directory.CreateDirectory(backups);
        var file = Path.Combine(backups, $"{archiveName}-{DateTimeOffset.UtcNow:yyyyMMddHHmmssfff}.json");
        var temp = file + ".tmp";
        await File.WriteAllTextAsync(temp, archive.ToJsonString(TagJson.Options), ct);
        File.Move(temp, file, true);
        var removed = await repository.Database.RunAsync(
            db =>
            {
                using var tx = db.BeginTransaction();
                db.Execute("CREATE TEMP TABLE IF NOT EXISTS removed_films(id TEXT PRIMARY KEY)");
                db.Execute("DELETE FROM removed_films");
                foreach (var id in films)
                    db.Execute("INSERT OR IGNORE INTO removed_films VALUES(@id)", ("@id", id));
                const string film = "subject_kind='film' AND subject_id IN (SELECT id FROM removed_films)";
                db.Execute($"DELETE FROM tag_history WHERE id IN (SELECT id FROM tag_heads WHERE {film})");
                foreach (
                    var table in new[]
                    {
                        "tag_heads",
                        "tag_effective",
                        "tag_issues",
                        "tag_reference_edges",
                        "tag_raw_references",
                        "tag_scope_index",
                        "tag_source_observations",
                        "tag_subscriptions",
                    }
                )
                    db.Execute($"DELETE FROM {table} WHERE {film}");
                db.Execute("DELETE FROM tag_candidates WHERE subject_id IN (SELECT id FROM removed_films)");
                db.Execute("DELETE FROM media_scope_projection WHERE subject_id IN (SELECT id FROM removed_films)");
                var count = db.Execute("DELETE FROM films WHERE id IN (SELECT id FROM removed_films)");
                afterFilms(db);
                db.Execute("DROP TABLE removed_films");
                audit["films"] = count;
                audit["archive"] = file;
                Audit(db, audit.Text("operation"), audit);
                Emit(db, "exchange.committed", new JsonObject { ["removed"] = count });
                tx.Commit();
                return count;
            },
            ct
        );
        return new JsonObject { ["films"] = removed, ["archive"] = file };
    }
}
