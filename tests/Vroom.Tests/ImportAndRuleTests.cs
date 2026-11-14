using System.Text.Json;
using System.Text.Json.Nodes;
using Vroom.Core.Application;
using Vroom.Core.Catalog;
using Vroom.Core.Domain;
using Vroom.Core.Jobs;
using Vroom.Core.Media;
using Vroom.Core.Storage;
using Vroom.Core.Tagging;

namespace Vroom.Tests;

public sealed partial class TaggingTests
{
    [Fact]
    public async Task WorkspacePreservesCompleteLargeQueuesAndRejectsOversizeWithoutReplacingThem()
    {
        var api = new ClientApi(repo, null!, null!, null!, null!, null!, engine, null!, null!, null!, null!);
        var ids = Enumerable.Range(0, 100_000).Select(_ => Guid.NewGuid().ToString("N")).ToArray();
        var workspace = new JsonObject
        {
            ["version"] = 3,
            ["activeId"] = "queue",
            ["tabs"] = new JsonArray(
                new JsonObject
                {
                    ["id"] = "queue",
                    ["kind"] = "player",
                    ["title"] = "Frozen result",
                    ["state"] = new JsonObject(),
                    ["params"] = new JsonObject
                    {
                        ["queue"] = new JsonArray(ids.Select(id => (JsonNode?)JsonValue.Create(id)).ToArray()),
                    },
                }
            ),
        };
        async Task<JsonObject> Request(string method, JsonNode? args = null) =>
            JsonNode
                .Parse(
                    await api.RequestAsync(
                        new JsonObject
                        {
                            ["method"] = method,
                            ["args"] = args?.DeepClone() ?? new JsonObject(),
                        }.ToJsonString()
                    )
                )!
                .AsObject();
        Assert.True((await Request("workspace.save", workspace)).Flag("ok"));
        var restored = await Request("workspace.get");
        Assert.Equal(ids, restored["data"]!["tabs"]![0]!["params"]!.List("queue").Select(n => n!.GetValue<string>()));
        var oversized = new JsonObject { ["version"] = 3, ["content"] = new string('x', 18_000_001) };
        var rejected = await Request("workspace.save", oversized);
        Assert.False(rejected.Flag("ok"));
        Assert.Equal("host.ClientApi.workspaceStateIsTooLarge", rejected.Text("error"));
        Assert.True(JsonNode.DeepEquals(restored["data"], (await Request("workspace.get"))["data"]));
    }

    [Fact]
    public async Task AddingAnotherFolderScansOnlyThatFolderAndPreservesLibraryPolicies()
    {
        var first = Path.Combine(directory, "first-source");
        var second = Path.Combine(directory, "second-source");
        Directory.CreateDirectory(first);
        Directory.CreateDirectory(second);
        var a = Path.Combine(first, "first.mp4");
        var b = Path.Combine(second, "second.mp4");
        await File.WriteAllTextAsync(a, "fixture");
        await File.WriteAllTextAsync(b, "fixture");
        await File.WriteAllTextAsync(Path.Combine(second, "skip-this.mp4"), "excluded");
        using var jobs = new JobCoordinator(db);
        using var scanner = new LibraryScanner(repo, new FfmpegService(repo), jobs, engine, new TagSources(engine));
        var imported = JsonSerializer.SerializeToNode(
            await scanner.ImportAsync(
                new()
                {
                    ["kind"] = "folder",
                    ["paths"] = new JsonArray(first),
                    ["excludes"] = new JsonArray("skip-this*"),
                    ["autoEnrich"] = false,
                    ["probeOnScan"] = false,
                }
            )
        )!;
        Assert.Equal(JobState.Completed, (await jobs.WaitAsync(imported.Text("jobId"))).State);
        await File.WriteAllTextAsync(Path.Combine(first, "not-selected-now.mp4"), "later");
        var next = JsonSerializer.SerializeToNode(
            await scanner.ImportAsync(
                new()
                {
                    ["kind"] = "folder",
                    ["paths"] = new JsonArray(second),
                    ["libraryId"] = imported.Text("libraryId"),
                    ["autoEnrich"] = true,
                    ["probeOnScan"] = true,
                }
            )
        )!;
        Assert.Equal(JobState.Completed, (await jobs.WaitAsync(next.Text("jobId"))).State);
        var library = (await repo.LibrariesAsync()).Single(l => l.Id == imported.Text("libraryId"));
        Assert.Equal(new[] { first, second }, library.Roots);
        Assert.Equal(new[] { "skip-this*" }, library.Excludes);
        Assert.False(library.AutoEnrich);
        Assert.False(library.ProbeOnScan);
        var result = await engine.QueryAsync(new() { ["libraryId"] = library.Id });
        Assert.Equal(new[] { a, b }.Order(), result.List("films").Select(f => f.Text("path")).Order());
        foreach (var probe in jobs.Jobs.Where(j => j.Kind == "media.process").ToArray())
            await jobs.WaitAsync(probe.Id);
    }

    private async Task<JsonObject> DurationClassifier()
    {
        var d = Parse(
            """{"key":"user.journey.scale","revision":1,"enabled":true,"label":{"en":"Video size"},"parents":[],"targets":["film-whole"],"value":{"cardinality":"one","semanticVersion":1,"schema":{"type":"object","properties":{"term":{"type":"string"}},"required":["term"],"additionalProperties":false},"vocabulary":"user.journey.bands"},"input":{"component":"select@1"},"placements":[],"query":{"filter":true,"sort":true},"initialization":[]}"""
        );
        await ConfigureVocabulary("user.journey.bands", d);
        foreach (var id in new[] { "short", "medium", "long" })
            await CreateTerm(id, "user.journey.bands", id);
        d["initialization"] = new JsonArray(
            Parse(
                """{"id":"duration-bands","event":"film.discovered","executor":"value.match@1","apply":"if-unset","args":{"cases":[{"id":"short","when":{"op":"lt","args":[{"fact":"probe.duration"},{"literal":600}]},"value":{"term":"short"}},{"id":"medium","when":{"op":"and","args":[{"op":"gte","args":[{"fact":"probe.duration"},{"literal":600}]},{"op":"lt","args":[{"fact":"probe.duration"},{"literal":1800}]}]},"value":{"term":"medium"}},{"id":"long","when":{"op":"gte","args":[{"fact":"probe.duration"},{"literal":1800}]},"value":{"term":"long"}}]}}"""
            )
        );
        await Publish(d);
        return d;
    }

    private async Task<JsonObject> RulePreview(JsonObject d, params string[] ids) =>
        await engine.PreviewAutomationAsync(
            new()
            {
                ["tagKey"] = d.Text("key"),
                ["subjectIds"] = new JsonArray(ids.Select(id => (JsonNode?)JsonValue.Create(id)).ToArray()),
            }
        );

    private async Task<JsonNode> ApplyRules(JsonObject preview, JobCoordinator jobs, TagJobs tagJobs)
    {
        var started = JsonSerializer.SerializeToNode(await tagJobs.StartAutomationAsync(preview.Text("previewToken")))!;
        var job = await jobs.WaitAsync(started.Text("jobId"));
        Assert.Equal(JobState.Completed, job.State);
        return JsonNode.Parse(job.ResultJson!)!;
    }

    [Theory]
    [InlineData(599, "short")]
    [InlineData(600, "medium")]
    [InlineData(1799, "medium")]
    [InlineData(1800, "long")]
    public async Task ClassificationTrialAndImportAgreeAtEveryBoundary(double seconds, string expected)
    {
        var d = await DurationClassifier();
        var trial = await engine.PreviewAutomationAsync(
            new()
            {
                ["tagKey"] = d.Text("key"),
                ["samples"] = new JsonArray(
                    new JsonObject
                    {
                        ["facts"] = new JsonObject { ["probe"] = new JsonObject { ["duration"] = seconds } },
                    }
                ),
            }
        );
        Assert.False(trial.Flag("committable"));
        Assert.Null(trial["previewToken"]);
        Assert.Equal(expected, trial.List("samples")[0]!["after"].Text("term"));
        await repo.UpdateMediaAsync(film.Id, f => f with { Duration = seconds, ProbeState = "ready" });
        await engine.RecordMediaEventAsync("film.discovered", film.Id);
        Assert.Equal(
            expected,
            (await engine.FilmAsync(film.Id))["film"]!["values"]![d.Text("key")]!["value"].Text("term")
        );
    }

    [Fact]
    public async Task UnknownDurationIncludingNegationWaitsThenRunsAfterProbe()
    {
        var d = await DurationClassifier();
        d["initialization"]![0]!["args"]!["cases"]![0]!["when"] = Parse(
            """{"op":"not","args":[{"op":"gte","args":[{"fact":"probe.duration"},{"literal":600}]}]}"""
        );
        await Publish(d);
        await repo.UpdateMediaAsync(film.Id, f => f with { Duration = 0, ProbeState = "failed" });
        var preview = await RulePreview(d, film.Id);
        Assert.Equal(1, preview["counts"]!.Number("waiting"));
        Assert.Equal(0, preview.Number("changedCount"));
        await engine.RecordMediaEventAsync("film.discovered", film.Id);
        Assert.Null((await engine.FilmAsync(film.Id))["film"]!["values"]![d.Text("key")]);
        await repo.UpdateMediaAsync(film.Id, f => f with { Duration = 200, ProbeState = "ready" });
        await engine.RecordMediaEventAsync("media.probed", film.Id);
        Assert.Equal(
            "short",
            (await engine.FilmAsync(film.Id))["film"]!["values"]![d.Text("key")]!["value"].Text("term")
        );
    }

    [Fact]
    public async Task DraftTrialCannotCommitAndOverlapsUseFirstMatch()
    {
        var d = await DurationClassifier();
        d["initialization"]![0]!["args"]!["cases"]![0]!["when"] = Parse(
            """{"op":"gte","args":[{"fact":"probe.duration"},{"literal":0}]}"""
        );
        var preview = await engine.PreviewAutomationAsync(
            new()
            {
                ["tagKey"] = d.Text("key"),
                ["changes"] = new JsonArray(
                    new JsonObject
                    {
                        ["kind"] = "definition",
                        ["key"] = d.Text("key"),
                        ["value"] = d,
                    }
                ),
                ["samples"] = new JsonArray(new JsonObject { ["facts"] = Parse("""{"probe":{"duration":1800}}""") }),
            }
        );
        Assert.False(preview.Flag("committable"));
        Assert.Equal(2, preview.List("samples")[0]!.Number("matches"));
        Assert.Equal("short", preview.List("samples")[0]!["after"].Text("term"));
        Assert.Null((await engine.FilmAsync(film.Id))["film"]!["values"]![d.Text("key")]);
    }

    [Fact]
    public async Task RecalculationPreservesRuleIdentityAndProtectsManualClears()
    {
        var d = await DurationClassifier();
        await engine.RecordMediaEventAsync("film.discovered", film.Id);
        var before = (await engine.FilmAsync(film.Id))["film"]!["values"]![d.Text("key")]!;
        d["initialization"]![0]!["args"]!["cases"]![0]!["value"] = Parse("""{"term":"medium"}""");
        await Publish(d);
        using var jobs = new JobCoordinator(db);
        var tagJobs = new TagJobs(engine, jobs);
        await ApplyRules(await RulePreview(d, film.Id), jobs, tagJobs);
        var after = (await engine.FilmAsync(film.Id))["film"]!["values"]![d.Text("key")]!;
        Assert.Equal("medium", after["value"].Text("term"));
        Assert.Equal(before["provenance"].Text("source"), after["provenance"].Text("source"));
        Assert.NotEqual(before["provenance"].Text("ruleHash"), after["provenance"].Text("ruleHash"));
        var clear = Write(d.Text("key"), null, (long)after.Number("revision"));
        clear["operation"] = "clear";
        clear["locked"] = false;
        await Batch(clear);
        var protectedPreview = await RulePreview(d, film.Id);
        Assert.Equal(1, protectedPreview["counts"]!.Number("protected"));
        Assert.Equal(0, protectedPreview.Number("changedCount"));
    }

    [Fact]
    public async Task RecalculationConflictsOnChangedDependenciesButNotPlaybackPosition()
    {
        var d = await DurationClassifier();
        var other = await repo.ImportMediaAsync(
            new()
            {
                LibraryId = "lib",
                Path = Path.Combine(directory, "other.mp4"),
                Duration = 200,
                Size = 1,
            }
        );
        var preview = await RulePreview(d, film.Id, other.Id);
        await repo.UpdateMediaAsync(film.Id, f => f with { Duration = 2000 });
        await repo.UpdateMediaAsync(other.Id, f => f with { Position = 30 });
        using var jobs = new JobCoordinator(db);
        var tagJobs = new TagJobs(engine, jobs);
        var result = await ApplyRules(preview, jobs, tagJobs);
        Assert.Single(result.List("conflicts"));
        Assert.Contains("STALE_MEDIA", result.List("conflicts")[0].Text("error"));
        Assert.Null((await engine.FilmAsync(film.Id))["film"]!["values"]![d.Text("key")]);
        Assert.Equal(
            "short",
            (await engine.FilmAsync(other.Id))["film"]!["values"]![d.Text("key")]!["value"].Text("term")
        );
    }

    [Fact]
    public async Task ClassificationTransfersToAnotherMediaPropertyAndHonorsTagDependencies()
    {
        var metric = await AddDefinition();
        await Put(metric.Text("key"), JsonValue.Create(2)!);
        var d = await DurationClassifier();
        d["initialization"]![0]!["args"]!["cases"] = new JsonArray(
            Parse(
                """{"id":"size","when":{"op":"and","args":[{"op":"gte","args":[{"fact":"file.size"},{"literal":5}]},{"op":"eq","args":[{"tag":"user.test.progress"},{"literal":2}]}]},"value":{"term":"long"}}"""
            )
        );
        await Publish(d);
        var preview = await RulePreview(d, film.Id);
        Assert.True(preview.Number("changedCount") == 1, preview.ToJsonString());
        await Put(metric.Text("key"), JsonValue.Create(3)!, 1);
        using var jobs = new JobCoordinator(db);
        var tagJobs = new TagJobs(engine, jobs);
        var result = await ApplyRules(preview, jobs, tagJobs);
        Assert.Single(result.List("conflicts"));
        Assert.Contains("VALUE_REVISION_CONFLICT", result.List("conflicts")[0].Text("error"));
    }

    [Fact]
    public async Task SelectingFilesNeverIndexesSiblingsAndFailedProbeDoesNotHideImportedFilm()
    {
        var chosen = Path.Combine(directory, "chosen.mp4");
        await File.WriteAllTextAsync(chosen, "not a video");
        await File.WriteAllTextAsync(Path.Combine(directory, "sibling.mp4"), "not selected");
        using var jobs = new JobCoordinator(db);
        using var scanner = new LibraryScanner(repo, new FfmpegService(repo), jobs, engine, new TagSources(engine));
        var started = JsonSerializer.SerializeToNode(
            await scanner.ImportAsync(new() { ["kind"] = "files", ["paths"] = new JsonArray(chosen) })
        )!;
        var job = await jobs.WaitAsync(started.Text("jobId"));
        Assert.Equal(JobState.Completed, job.State);
        var library = (await repo.LibrariesAsync()).Single(l => l.Id == started.Text("libraryId"));
        Assert.Empty(library.Roots);
        var result = await engine.QueryAsync(new() { ["libraryId"] = library.Id });
        Assert.Single(result.List("films"));
        Assert.Equal(chosen, result.List("films")[0].Text("path"));
        var process = await jobs.WaitAsync(jobs.Jobs.Single(j => j.Kind == "media.process").Id);
        Assert.Equal(JobState.Completed, process.State);
        Assert.Equal(1, JsonNode.Parse(process.ResultJson!)!.Number("failed"));
        Assert.Equal("failed", (await repo.GetMediaAsync(result.List("films")[0].Text("id"))).ProbeState);
        Assert.Single((await engine.QueryAsync(new() { ["libraryId"] = library.Id })).List("films"));
    }

    [Fact]
    public async Task ChangedSourceInvalidatesFactsAndFullResultIdsIgnorePresentationPagination()
    {
        var changed = await repo.ImportMediaAsync(film with { Size = film.Size + 1 });
        Assert.Equal(0, changed.Duration);
        Assert.Equal("unknown", changed.ProbeState);
        for (var i = 0; i < 35; i++)
            await repo.ImportMediaAsync(
                new()
                {
                    LibraryId = "lib",
                    Path = Path.Combine(directory, $"item-{i}.mp4"),
                    Size = 1,
                }
            );
        var args = new JsonObject
        {
            ["limit"] = 1,
            ["offset"] = 10,
            ["ignoreDefaultQuery"] = true,
        };
        Assert.Single((await engine.QueryAsync(args)).List("films"));
        var all = await engine.QueryIdsAsync(args);
        Assert.Equal(36, all.Number("count"));
        Assert.Equal(36, all.List("ids").DistinctBy(x => x!.ToString()).Count());
    }

    [Fact]
    public async Task ConfigReviewOnlyIncludesNewImpactAndShowsRestoredValues()
    {
        var d = await AddDefinition();
        await Put(d.Text("key"), JsonValue.Create(80)!);
        d["value"]!["schema"]!["maximum"] = 50;
        await Publish(d);
        d["label"]!["en"] = "Renamed";
        var changes = new JsonObject
        {
            ["changes"] = new JsonArray(
                new JsonObject
                {
                    ["kind"] = "definition",
                    ["key"] = d.Text("key"),
                    ["value"] = d.DeepClone(),
                }
            ),
        };
        var rename = await engine.PreviewConfigAsync(changes);
        Assert.False(rename["impact"].Flag("requiresReview"));
        Assert.Empty(rename.List("issues"));
        Assert.Empty(rename.List("valueChanges"));
        d["value"]!["schema"]!["maximum"] = 100;
        changes["changes"]![0]!["value"] = d.DeepClone();
        var restore = await engine.PreviewConfigAsync(changes);
        Assert.True(restore["impact"].Flag("requiresReview"));
        Assert.Equal(1, restore["impact"]!.Number("changedValues"));
        Assert.Null(restore.List("valueChanges")[0]!["before"]);
        Assert.Equal(80, restore.List("valueChanges")[0]!["after"]!.GetValue<int>());
    }

    [Fact]
    public async Task FullPlaybackSnapshotExceedsPageLimitWithoutDroppingFilms()
    {
        await db.RunAsync(connection =>
        {
            using var tx = connection.BeginTransaction();
            for (var i = 0; i < 10005; i++)
            {
                var item = new Film
                {
                    Id = $"full-{i:D5}",
                    LibraryId = "lib",
                    Path = Path.Combine(directory, $"full-{i}.mp4"),
                    Size = 1,
                };
                CatalogRepository.SaveFilm(connection, item);
            }
            tx.Commit();
        });
        var all = await engine.QueryIdsAsync(
            new()
            {
                ["ignoreDefaultQuery"] = true,
                ["limit"] = 2,
                ["offset"] = 9999,
            }
        );
        Assert.Equal(10006, all.Number("count"));
        Assert.Equal(10006, all.List("ids").DistinctBy(x => x!.ToString()).Count());
    }

    [Fact]
    public async Task FrozenRecalculationResumesAfterRestartWithoutIncludingNewFilms()
    {
        var d = await DurationClassifier();
        var preview = await RulePreview(d, film.Id);
        string id;
        await using (var jobs = new JobCoordinator(db))
        {
            var tags = new TagJobs(engine, jobs);
            await jobs.ConfigureAsync(new(Paused: true));
            id = JsonSerializer
                .SerializeToNode(await tags.StartAutomationAsync(preview.Text("previewToken")))!
                .Text("jobId");
            await jobs.PauseAsync(id);
        }
        var later = await repo.ImportMediaAsync(
            new()
            {
                LibraryId = "lib",
                Path = Path.Combine(directory, "later.mp4"),
                Duration = 30,
            }
        );
        await using (var jobs = new JobCoordinator(db))
        {
            var tags = new TagJobs(engine, jobs);
            await jobs.InitializeAsync();
            Assert.Equal(JobState.Paused, jobs.Get(id).State);
            await jobs.ConfigureAsync(new());
            await jobs.ResumeAsync(id);
            Assert.Equal(JobState.Completed, (await jobs.WaitAsync(id)).State);
            Assert.Equal(
                id,
                JsonSerializer
                    .SerializeToNode(await tags.StartAutomationAsync(preview.Text("previewToken")))!
                    .Text("jobId")
            );
        }
        Assert.Equal(
            "short",
            (await engine.FilmAsync(film.Id))["film"]!["values"]![d.Text("key")]!["value"].Text("term")
        );
        Assert.Null((await engine.FilmAsync(later.Id))["film"]!["values"]![d.Text("key")]);
    }

    [Fact]
    public async Task EmptyTrialAndCompetingClassificationTablesAreRejected()
    {
        var d = await DurationClassifier();
        await Assert.ThrowsAsync<TagException>(() =>
            engine.PreviewAutomationAsync(new() { ["tagKey"] = d.Text("key"), ["samples"] = new JsonArray() })
        );
        var second = d["initialization"]![0]!.DeepClone();
        second["id"] = "competing";
        d["initialization"]!.AsArray().Add(second);
        Assert.Equal("RULE_LIMIT", (await Assert.ThrowsAsync<TagException>(() => Publish(d))).Code);
    }
}
