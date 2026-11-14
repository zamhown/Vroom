using Vroom.Core.Domain;
using Vroom.Core.Jobs;
using Vroom.Core.Storage;
using Vroom.Core.Tagging;

namespace Vroom.Tests;

public sealed class MaintenanceTests : IAsyncLifetime
{
    private readonly string directory = Path.Combine(Path.GetTempPath(), "vroom-tests", Guid.NewGuid().ToString("N"));
    private CatalogDatabase db = null!;
    private CatalogRepository repo = null!;

    public async Task InitializeAsync()
    {
        db = new(directory);
        repo = new(db);
        await repo.InitializeAsync();
        await repo.SaveLibraryAsync(new("lib", "Library", [directory], []));
    }

    public Task DisposeAsync()
    {
        db.Dispose();
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        Directory.Delete(directory, true);
        return Task.CompletedTask;
    }

    private Task<long> Count(string table) =>
        db.ReadAsync(c => Convert.ToInt64(c.Scalar($"SELECT COUNT(*) FROM {table}")));

    [Fact]
    public async Task PlaybackEventsWithoutListeningRulesAreNotPersisted()
    {
        var engine = new TagEngine(repo);
        await engine.InitializeAsync();
        var path = Path.Combine(directory, "clip.mp4");
        await File.WriteAllTextAsync(path, "x");
        var film = await repo.ImportMediaAsync(
            new()
            {
                LibraryId = "lib",
                Path = path,
                Size = 1,
            }
        );
        var before = await Count("tag_events");
        await engine.RecordMediaEventAsync("playback.position-saved", film.Id);
        await engine.RecordMediaEventAsync("playback.seeked", film.Id);
        Assert.Equal(before, await Count("tag_events"));
        // The built-in definitions mark a film as watched when playback ends, so this one is kept.
        await engine.RecordMediaEventAsync("playback.ended", film.Id);
        Assert.True(await Count("tag_events") > before);
    }

    [Fact]
    public async Task MaintenanceBoundsLogsCachesAndFinishedTasksButKeepsAnnotationHistory()
    {
        var engine = new TagEngine(repo);
        await engine.InitializeAsync();
        var old = DateTimeOffset.UtcNow.AddDays(-60).ToString("O");
        await db.RunAsync(c =>
        {
            c.Execute(
                "INSERT INTO tag_events(event_id,payload,processed) VALUES('old',json_object('occurredAt',@t),1)",
                ("@t", old)
            );
            c.Execute("INSERT INTO tag_rule_runs VALUES('old','rule','{}')");
            c.Execute("INSERT INTO tag_previews VALUES('stale','config',1,'{}',NULL,@t)", ("@t", old));
            c.Execute("INSERT INTO tag_previews VALUES('running','bulk',1,'{}',NULL,@t)", ("@t", old));
            c.Execute("INSERT INTO tag_source_cache VALUES('k','{}',@t)", ("@t", old));
            c.Execute("INSERT INTO tag_history VALUES('kept',1,'{}')");
        });
        await using var jobs = new JobCoordinator(db);
        jobs.Register("fixture.done", (_, _) => Task.FromResult<object?>(null));
        await jobs.InitializeAsync();
        var finished = await jobs.WaitAsync(await jobs.StartAsync("fixture.done", "fixture"));
        Assert.Equal(JobState.Completed, finished.State);
        using var maintenance = new CatalogMaintenance(db, jobs);
        var report = await maintenance.RunAsync();
        Assert.True(report.Events >= 1);
        Assert.Equal(
            0,
            await db.ReadAsync(c =>
                Convert.ToInt64(c.Scalar("SELECT COUNT(*) FROM tag_rule_runs WHERE event_id='old'"))
            )
        );
        Assert.Equal(1, await Count("tag_previews"));
        Assert.Equal(0, await Count("tag_source_cache"));
        Assert.Equal(1, await Count("tag_history"));
        // A task that finished just now is inside the retention window.
        Assert.Equal(0, report.Jobs);
        Assert.Equal(1, await jobs.PruneAsync(TimeSpan.Zero));
        Assert.Throws<KeyNotFoundException>(() => jobs.Get(finished.Id));
        Assert.Equal(0, await Count("background_jobs"));
    }
}
