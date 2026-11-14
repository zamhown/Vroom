using System.Text.Json.Nodes;
using Vroom.Core.Domain;
using Vroom.Core.Jobs;
using Vroom.Core.Tagging;

namespace Vroom.Tests;

public sealed partial class TaggingTests
{
    [Fact]
    public async Task BulkSourceOutageStopsTheAttemptRetainsCauseAndRetriesOnlyUnfinishedFilms()
    {
        await ConfigureFeedbackSource(BrowserSource("browser"));
        await repo.PatchSettingsAsync(new() { ["onlineMetadata"] = true });
        var ids = new JsonArray(film.Id);
        for (var i = 0; i < 3; i++)
            ids.Add(
                (
                    await repo.ImportMediaAsync(
                        new()
                        {
                            LibraryId = "lib",
                            Path = Path.Combine(directory, $"outage-{i}.mp4"),
                            Size = 1,
                        }
                    )
                ).Id
            );
        var preview = await engine.PreviewEnrichmentAsync(new() { ["subjectIds"] = ids });
        var calls = 0;
        var browser = new BrowserStub(_ =>
            ++calls == 2
                ? throw new SourceAccessException("browser-disconnected", "host.SourceAccess.browserDisconnected")
                : Task.FromResult(ReadyDocument())
        );
        using var sources = new TagSources(engine, new SourceHttpClient(), browser);
        await using var jobs = new JobCoordinator(db);
        sources.RegisterBulkJobs(jobs);
        var started = (JsonObject)await new TagJobs(engine, jobs).StartEnrichmentAsync(preview.Text("previewToken"));
        var id = started.Text("jobId");
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        Assert.Equal(JobState.Failed, (await jobs.WaitAsync(id, timeout.Token)).State);
        var status = await engine.EnrichmentStatusAsync(preview.Text("previewToken"));
        Assert.Equal(1, status["counts"].Number("completed"));
        Assert.Equal(1, status["counts"].Number("deferred"));
        Assert.Equal(2, status["counts"].Number("pending"));
        Assert.Equal(0, status["counts"].Number("failed"));
        Assert.Equal(1, jobs.Get(id).Completed);
        Assert.Equal(2, calls);
        // A premature manual retry keeps the original reason and retry time, and makes no request.
        await jobs.ResumeAsync(id);
        await jobs.WaitAsync(id, timeout.Token);
        status = await engine.EnrichmentStatusAsync(preview.Text("previewToken"));
        var outcome = Assert.Single(
            status.List("items").First()!["target"]!["result"].List("sources"),
            s => s.Text("status") == "cooldown"
        );
        Assert.Equal("host.SourceAccess.browserDisconnected", outcome.Text("cause"));
        Assert.True(DateTimeOffset.Parse(outcome.Text("retryAt")) > DateTimeOffset.UtcNow);
        Assert.Equal(2, calls);
        // Network recovery clears connection failures through the normal source service.
        await sources.ResetConnectionFailuresAsync(timeout.Token);
        await jobs.ResumeAsync(id);
        Assert.Equal(JobState.Completed, (await jobs.WaitAsync(id, timeout.Token)).State);
        Assert.Equal(5, calls); // The first successfully completed film was not fetched again.
        Assert.Equal(
            4,
            (await engine.EnrichmentStatusAsync(preview.Text("previewToken")))["counts"].Number("completed")
        );
    }

    [Fact]
    public async Task BulkEnrichmentFreezesQueryTargetsAndPreservesConcurrentEdits()
    {
        await ConfigureFeedbackSource(FeedbackSidecar());
        await File.WriteAllTextAsync(Path.ChangeExtension(film.Path, ".review"), """{"note":"Remote"}""");
        var preview = await engine.PreviewEnrichmentAsync(new() { ["query"] = new JsonObject { ["limit"] = 1 } });
        await repo.ImportMediaAsync(
            new()
            {
                LibraryId = "lib",
                Path = Path.Combine(directory, "later.mp4"),
                Size = 1,
            }
        );
        await engine.BatchAsync(
            new()
            {
                ["expectedGeneration"] = preview["generation"].Copy(),
                ["writes"] = new JsonArray(Write("user.feedback.note", JsonValue.Create("My edit"))),
            }
        );
        using var sources = new TagSources(engine);
        await using var jobs = new JobCoordinator(db);
        sources.RegisterBulkJobs(jobs);
        var tagJobs = new TagJobs(engine, jobs);
        var started = (JsonObject)await tagJobs.StartEnrichmentAsync(preview.Text("previewToken"));
        Assert.Equal(
            started.Text("jobId"),
            ((JsonObject)await tagJobs.StartEnrichmentAsync(preview.Text("previewToken"))).Text("jobId")
        );
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        Assert.Equal(JobState.Completed, (await jobs.WaitAsync(started.Text("jobId"), timeout.Token)).State);
        var status = await engine.EnrichmentStatusAsync(preview.Text("previewToken"));
        Assert.Equal(1, status["counts"].Number("conflict"));
        Assert.Single(status.List("items"));
        Assert.Equal("error.STALE_SOURCE_RESULT", status.List("items")[0].Text("error"));
        var detail = await engine.FilmAsync(film.Id);
        Assert.Equal("My edit", detail["film"]!["values"]!["user.feedback.note"].Text("value"));
        Assert.Empty(detail.List("candidates"));
    }

    [Fact]
    public async Task BulkEnrichmentRetriesOnlyFailuresAndKeepsCompletedSourceResults()
    {
        await ConfigureFeedbackSource(FeedbackSidecar());
        var other = await repo.ImportMediaAsync(
            new()
            {
                LibraryId = "lib",
                Path = Path.Combine(directory, "other.mp4"),
                Size = 1,
            }
        );
        await File.WriteAllTextAsync(Path.ChangeExtension(film.Path, ".review"), """{"note":"First suggestion"}""");
        await File.WriteAllTextAsync(Path.ChangeExtension(other.Path, ".review"), "invalid json");
        var preview = await engine.PreviewEnrichmentAsync(new() { ["subjectIds"] = new JsonArray(film.Id, other.Id) });
        using var sources = new TagSources(engine);
        await using var jobs = new JobCoordinator(db);
        sources.RegisterBulkJobs(jobs);
        var tagJobs = new TagJobs(engine, jobs);
        var started = (JsonObject)await tagJobs.StartEnrichmentAsync(preview.Text("previewToken"));
        var id = started.Text("jobId");
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        Assert.Equal(JobState.Failed, (await jobs.WaitAsync(id, timeout.Token)).State);
        var status = await engine.EnrichmentStatusAsync(preview.Text("previewToken"));
        Assert.Equal(1, status["counts"].Number("completed"));
        Assert.Equal(1, status["counts"].Number("failed"));
        await File.WriteAllTextAsync(Path.ChangeExtension(film.Path, ".review"), """{"note":"Must not run again"}""");
        await File.WriteAllTextAsync(Path.ChangeExtension(other.Path, ".review"), """{"note":"Retry suggestion"}""");
        await jobs.ResumeAsync(id);
        Assert.Equal(JobState.Completed, (await jobs.WaitAsync(id, timeout.Token)).State);
        Assert.Equal(
            2,
            (await engine.EnrichmentStatusAsync(preview.Text("previewToken")))["counts"].Number("completed")
        );
        Assert.Equal(
            "First suggestion",
            Assert.Single((await engine.FilmAsync(film.Id)).List("candidates")).Text("value")
        );
        Assert.Equal(
            "Retry suggestion",
            Assert.Single((await engine.FilmAsync(other.Id)).List("candidates")).Text("value")
        );
    }

    [Fact]
    public async Task BulkEnrichmentRejectsChangedDefinitionsAndExplicitEmptySelectionNeverExpands()
    {
        await ConfigureFeedbackSource(FeedbackSidecar());
        var empty = await engine.PreviewEnrichmentAsync(
            new() { ["subjectIds"] = new JsonArray(), ["query"] = new JsonObject() }
        );
        Assert.Equal(0, empty.Number("count"));
        var preview = await engine.PreviewEnrichmentAsync(new() { ["subjectIds"] = new JsonArray(film.Id) });
        await AddDefinition("user.unfamiliar.measure");
        using var sources = new TagSources(engine);
        await using var jobs = new JobCoordinator(db);
        sources.RegisterBulkJobs(jobs);
        var started = (JsonObject)await new TagJobs(engine, jobs).StartEnrichmentAsync(preview.Text("previewToken"));
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await jobs.WaitAsync(started.Text("jobId"), timeout.Token);
        Assert.Equal(
            1,
            (await engine.EnrichmentStatusAsync(preview.Text("previewToken")))["counts"].Number("conflict")
        );
    }

    [Fact]
    public async Task BulkEnrichmentCanPauseCancelAndResumeAfterRestart()
    {
        await ConfigureFeedbackSource(FeedbackSidecar());
        var preview = await engine.PreviewEnrichmentAsync(new() { ["query"] = new JsonObject() });
        string id;
        using var sources = new TagSources(engine);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        await using (var jobs = new JobCoordinator(db))
        {
            sources.RegisterBulkJobs(jobs);
            await jobs.InitializeAsync();
            id = await jobs.StartAsync(
                "metadata.batch",
                "fixture",
                new { previewToken = preview.Text("previewToken") },
                schedule: new(0, DateTimeOffset.UtcNow.AddHours(1))
            );
            await jobs.PauseAsync(id);
            Assert.Equal(JobState.Paused, jobs.Get(id).State);
            await jobs.ScheduleAsync(id, new(0));
            await jobs.StopAsync(id);
            Assert.Equal(JobState.Cancelled, (await jobs.WaitAsync(id, timeout.Token)).State);
        }
        await repo.ImportMediaAsync(
            new()
            {
                LibraryId = "lib",
                Path = Path.Combine(directory, "after-cancel.mp4"),
                Size = 1,
            }
        );
        await using (var jobs = new JobCoordinator(db))
        {
            sources.RegisterBulkJobs(jobs);
            await jobs.InitializeAsync();
            await jobs.ResumeAsync(id);
            Assert.Equal(JobState.Completed, (await jobs.WaitAsync(id, timeout.Token)).State);
        }
        var status = await engine.EnrichmentStatusAsync(preview.Text("previewToken"));
        Assert.Equal(1, status["counts"].Number("completed"));
        Assert.Single(status.List("items"));
    }
}
