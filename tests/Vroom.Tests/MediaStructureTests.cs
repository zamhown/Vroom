using Microsoft.Data.Sqlite;
using Vroom.Core.Domain;
using Vroom.Core.Storage;

namespace Vroom.Tests;

public sealed class MediaStructureTests : IAsyncLifetime
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "vroom-resources", Guid.NewGuid().ToString("N"));

    public Task InitializeAsync()
    {
        Directory.CreateDirectory(root);
        return Task.CompletedTask;
    }

    public Task DisposeAsync()
    {
        SqliteConnection.ClearAllPools();
        Directory.Delete(root, true);
        return Task.CompletedTask;
    }

    [Fact]
    public async Task UpgradeKeepsIdentitiesProgressAndUninterpretedHistoryAndMakesAnIndependentBackup()
    {
        var file = Path.Combine(root, "old.db");
        var directory = Path.Combine(root, "catalog");
        Directory.CreateDirectory(directory);
        var film = new Film
        {
            Id = "stable-work",
            LibraryId = "lib",
            Path = Path.Combine(root, "unavailable.mp4"),
            Size = 123,
            Duration = 50,
            Position = 17,
            Modified = DateTimeOffset.UtcNow,
        };
        using (var old = new SqliteConnection("Data Source=" + file))
        {
            old.Open();
            old.Execute(
                "CREATE TABLE libraries(id TEXT PRIMARY KEY,name TEXT,payload TEXT);CREATE TABLE film_groups(id TEXT PRIMARY KEY,name TEXT);CREATE TABLE films(id TEXT PRIMARY KEY,library_id TEXT,path TEXT,path_key TEXT,size INTEGER,duration REAL,added TEXT,group_id TEXT,payload TEXT);CREATE TABLE retained_history(id TEXT PRIMARY KEY,payload TEXT);PRAGMA user_version=3;"
            );
            old.Execute(
                "INSERT INTO libraries VALUES('lib','Library',@p)",
                ("@p", CatalogRepository.Serialize(new Library("lib", "Library", [root], [])))
            );
            old.Execute(
                "INSERT INTO films VALUES(@id,'lib',@path,@path,123,50,@added,NULL,@p)",
                ("@id", film.Id),
                ("@path", film.Path),
                ("@added", film.Added.ToString("O")),
                ("@p", CatalogRepository.Serialize(film))
            );
            old.Execute("INSERT INTO retained_history VALUES('annotation','exact raw record')");
            old.Execute(
                "CREATE TABLE tag_heads(subject_kind TEXT NOT NULL,subject_id TEXT NOT NULL,scope_id TEXT NOT NULL,tag_key TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(subject_kind,subject_id,scope_id,tag_key));CREATE TABLE tag_history(id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(id,revision));"
            );
            old.Execute(
                "INSERT INTO tag_heads VALUES('film','stable-work','scene','user.unfamiliar.note','clock-note',3,@json)",
                (
                    "@json",
                    """{"id":"clock-note","revision":3,"subject":{"kind":"film","id":"stable-work"},"scope":{"kind":"point","scopeId":"scene","startUs":"1500000"},"tagKey":"user.unfamiliar.note","value":"original","operation":"set"}"""
                )
            );
        }
        SqliteConnection.ClearAllPools();
        File.Copy(file, Path.Combine(directory, "catalog.db"));
        using (var db = new CatalogDatabase(directory))
        {
            var repo = new CatalogRepository(db);
            var actual = await repo.GetMediaAsync(film.Id);
            Assert.Equal(film.Id, actual.Id);
            Assert.Equal(film.Id, actual.FileId);
            Assert.Equal(film.Path, actual.Path);
            Assert.Equal(17, actual.Position);
            Assert.Equal(film.Modified, actual.Modified);
            Assert.Equal("exact raw record", await db.ReadAsync(c => c.Scalar("SELECT payload FROM retained_history")));
            Assert.Equal(4L, await db.ReadAsync(c => c.Scalar("PRAGMA user_version")));
            Assert.Equal(1L, await db.ReadAsync(c => c.Scalar("SELECT count(*) FROM media_parts")));
            Assert.Equal(
                "stable-work-part",
                await db.ReadAsync(c =>
                    c.Scalar("SELECT json_extract(payload,'$.scope.partId') FROM tag_heads WHERE id='clock-note'")
                )
            );
            Assert.Equal(4L, await db.ReadAsync(c => c.Scalar("SELECT revision FROM tag_heads WHERE id='clock-note'")));
            Assert.Equal(
                2L,
                await db.ReadAsync(c => c.Scalar("SELECT count(*) FROM tag_history WHERE id='clock-note'"))
            );
            Assert.Equal(
                DBNull.Value,
                await db.ReadAsync(c =>
                    c.Scalar(
                        "SELECT json_extract(payload,'$.scope.partId') FROM tag_history WHERE id='clock-note' AND revision=3"
                    )
                )
            );
        }
        var backup = Assert.Single(Directory.GetFiles(Path.Combine(directory, "backups"), "*.db"));
        using (var original = new SqliteConnection("Data Source=" + backup + ";Mode=ReadOnly"))
        {
            original.Open();
            Assert.Equal(3L, original.Scalar("PRAGMA user_version"));
            Assert.Equal(CatalogRepository.Serialize(film), original.Scalar("SELECT payload FROM films"));
        }
        using (var again = new CatalogDatabase(directory))
            await new CatalogRepository(again).InitializeAsync();
        Assert.Single(Directory.GetFiles(Path.Combine(directory, "backups"), "*.db"));
        Assert.False(File.Exists(film.Path));
    }

    [Fact]
    public async Task FailedUpgradeRollsBackTheOriginalTablesAndRetainsItsVerifiedBackup()
    {
        var directory = Path.Combine(root, "rollback");
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, "catalog.db");
        using (var original = new SqliteConnection("Data Source=" + path))
        {
            original.Open();
            original.Execute(
                "CREATE TABLE libraries(id TEXT PRIMARY KEY,name TEXT,payload TEXT);CREATE TABLE film_groups(id TEXT PRIMARY KEY,name TEXT);CREATE TABLE films(id TEXT PRIMARY KEY,payload TEXT);PRAGMA user_version=3;"
            );
            original.Execute(
                "INSERT INTO libraries VALUES('lib','Fixture',@p)",
                ("@p", CatalogRepository.Serialize(new Library("lib", "Fixture", [], [])))
            );
            foreach (var id in new[] { "first", "second" })
                original.Execute(
                    "INSERT INTO films VALUES(@id,@p)",
                    ("@id", id),
                    (
                        "@p",
                        CatalogRepository.Serialize(
                            new Film
                            {
                                Id = id,
                                LibraryId = "lib",
                                Path = Path.Combine(root, "duplicate.mp4"),
                            }
                        )
                    )
                );
        }
        using (var failing = new CatalogDatabase(directory))
            await Assert.ThrowsAsync<SqliteException>(() => new CatalogRepository(failing).InitializeAsync());
        using (var unchanged = new SqliteConnection("Data Source=" + path + ";Mode=ReadOnly"))
        {
            unchanged.Open();
            Assert.Equal(3L, unchanged.Scalar("PRAGMA user_version"));
            Assert.Equal(2L, unchanged.Scalar("SELECT count(*) FROM films"));
            Assert.Equal(
                0L,
                unchanged.Scalar(
                    "SELECT count(*) FROM sqlite_master WHERE name='media_parts' OR name='media_upgrade_v3'"
                )
            );
        }
        var backup = Assert.Single(Directory.GetFiles(Path.Combine(directory, "backups"), "*.db"));
        using var saved = new SqliteConnection("Data Source=" + backup + ";Mode=ReadOnly");
        saved.Open();
        Assert.Equal("ok", saved.Scalar("PRAGMA integrity_check"));
        Assert.Equal(2L, saved.Scalar("SELECT count(*) FROM films"));
    }

    [Fact]
    public async Task RenamePreservesWorkFileIdentityAndProgressButACopyIsIndependent()
    {
        using var db = new CatalogDatabase(Path.Combine(root, "catalog"));
        var repo = new CatalogRepository(db);
        await repo.SaveLibraryAsync(new("lib", "Test", [root], []));
        var path = Path.Combine(root, "first.mp4");
        await File.WriteAllTextAsync(path, "synthetic fixture");
        var modified = new FileInfo(path).LastWriteTimeUtc;
        var first = await repo.ImportMediaAsync(
            new()
            {
                LibraryId = "lib",
                Path = path,
                Size = new FileInfo(path).Length,
                Modified = modified,
            }
        );
        Assert.NotNull(FileIdentity.Read(path));
        await repo.UpdateMediaAsync(first.Id, f => f with { Position = 7 });
        var moved = Path.Combine(root, "renamed.mp4");
        File.Move(path, moved);
        var found = await repo.ImportMediaAsync(
            new()
            {
                LibraryId = "lib",
                Path = moved,
                Size = new FileInfo(moved).Length,
                Modified = new FileInfo(moved).LastWriteTimeUtc,
            }
        );
        Assert.Equal(first.Id, found.Id);
        Assert.Equal(first.FileId, found.FileId);
        Assert.Equal(7, found.Position);
        Assert.Equal(moved, (await repo.GetMediaAsync(first.Id)).Path);
        var copy = Path.Combine(root, "copy.mp4");
        File.Copy(moved, copy);
        var second = await repo.ImportMediaAsync(
            new()
            {
                LibraryId = "lib",
                Path = copy,
                Size = new FileInfo(copy).Length,
                Modified = new FileInfo(copy).LastWriteTimeUtc,
            }
        );
        Assert.NotEqual(first.Id, second.Id);
        Assert.NotEqual(first.FileId, second.FileId);
        Assert.Equal(0, second.Position);
    }
}
