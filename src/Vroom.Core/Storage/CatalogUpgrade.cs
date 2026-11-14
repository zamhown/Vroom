using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;
using Vroom.Core.Domain;

namespace Vroom.Core.Storage;

public sealed partial class CatalogDatabase
{
    // Explicitly authorized one-time v3 -> v4 upgrade (2026-11-11). No other old
    // formats are read. The SQLite backup includes WAL commits and remains immutable.
    private void UpgradeMediaStructure(SqliteConnection db)
    {
        var backups = Path.Combine(DataDirectory, "backups");
        Directory.CreateDirectory(backups);
        var path = Path.Combine(
            backups,
            $"catalog-before-media-v4-{DateTime.UtcNow:yyyyMMddHHmmss}-{Guid.NewGuid():N}.db"
        );
        using (
            var backup = new SqliteConnection(
                new SqliteConnectionStringBuilder { DataSource = path, Pooling = false }.ToString()
            )
        )
        {
            backup.Open();
            db.BackupDatabase(backup);
            if (backup.Scalar("PRAGMA integrity_check") as string != "ok")
                throw new InvalidOperationException("host.MediaStructure.backupFailed");
        }
        var original = new List<Film>();
        using (var command = db.Command("SELECT payload FROM films"))
        using (var reader = command.ExecuteReader())
            while (reader.Read())
                original.Add(CatalogRepository.Deserialize<Film>(reader.GetString(0)));
        using var transaction = db.BeginTransaction();
        db.Execute("ALTER TABLE films RENAME TO media_upgrade_v3;");
        db.Execute(Schema);
        db.Execute("INSERT OR REPLACE INTO settings VALUES('media.projectionPending','true')");
        foreach (var film in original)
        {
            CatalogRepository.SaveFilm(db, film);
            // Capture existing filesystem identities during this one-time upgrade,
            // so the first scan after a rename can reconnect the original work.
            var identity = FileIdentity.Read(film.Path);
            if (identity is not null)
                db.Execute(
                    "UPDATE media_files SET filesystem_identity=@identity WHERE id=@id",
                    ("@identity", identity),
                    ("@id", film.Id)
                );
        }
        // Add the explicit clock binding as a new current revision. Original
        // annotation revisions remain byte-for-byte intact in history and backup.
        if (db.Scalar("SELECT name FROM sqlite_master WHERE type='table' AND name='tag_heads'") is not null)
        {
            var workIds = original.Select(f => f.Id).ToHashSet();
            var scopes = new List<(string Id, long Revision, string Json)>();
            using (
                var command = db.Command(
                    "SELECT id,revision,payload FROM tag_heads WHERE subject_kind='film' AND scope_id<>'whole'"
                )
            )
            using (var reader = command.ExecuteReader())
                while (reader.Read())
                    scopes.Add((reader.GetString(0), reader.GetInt64(1), reader.GetString(2)));
            foreach (var head in scopes)
            {
                var record = JsonNode.Parse(head.Json)!.AsObject();
                var work = record["subject"]?["id"]?.ToString();
                if (work is null || !workIds.Contains(work))
                    continue;
                record["scope"]!["partId"] = work + "-part";
                record["revision"] = head.Revision + 1;
                record["modified"] = DateTimeOffset.UtcNow.ToString("O");
                var json = record.ToJsonString();
                db.Execute(
                    "INSERT OR IGNORE INTO tag_history VALUES(@id,@revision,@json)",
                    ("@id", head.Id),
                    ("@revision", head.Revision),
                    ("@json", head.Json)
                );
                db.Execute(
                    "INSERT INTO tag_history VALUES(@id,@revision,@json)",
                    ("@id", head.Id),
                    ("@revision", head.Revision + 1),
                    ("@json", json)
                );
                db.Execute(
                    "UPDATE tag_heads SET revision=@revision,payload=@json WHERE id=@id",
                    ("@id", head.Id),
                    ("@revision", head.Revision + 1),
                    ("@json", json)
                );
            }
        }
        if (
            Convert.ToInt64(db.Scalar("SELECT count(*) FROM films")) != original.Count
            || Convert.ToInt64(db.Scalar("SELECT count(*) FROM media_parts")) != original.Count
            || db.Scalar("PRAGMA foreign_key_check") is not null
        )
            throw new InvalidOperationException("host.MediaStructure.upgradeFailed");
        if (db.Scalar("SELECT name FROM sqlite_master WHERE type='table' AND name='tag_candidates'") is not null)
            db.Execute(
                "UPDATE tag_candidates SET payload=json_set(payload,'$.subjectKind','film','$.subjectRevision',0,'$.partId',subject_id||'-part')"
            );
        db.Execute("DROP TABLE media_upgrade_v3;");
        db.Execute(Schema);
        db.Execute(
            "INSERT INTO audit(time,tool,summary) VALUES(@time,'catalog.media-v4',@summary)",
            ("@time", DateTimeOffset.UtcNow.ToString("O")),
            ("@summary", CatalogRepository.Serialize(new { works = original.Count, backup = path }))
        );
        transaction.Commit();
    }
}
