using System.Text.Json;
using System.Text.Json.Nodes;
using Vroom.Core.Domain;
using Vroom.Core.Jobs;
using Vroom.Core.Storage;
using Vroom.Core.Tagging;

namespace Vroom.Tests;

public sealed partial class TaggingTests
{
    private async Task<JsonNode> Generation() => (await engine.SnapshotAsync())["generation"]!.DeepClone();

    private async Task Put(string key, JsonNode value, long revision = 0) =>
        await engine.BatchAsync(
            new()
            {
                ["expectedGeneration"] = await Generation(),
                ["writes"] = new JsonArray(Write(key, value, revision)),
            }
        );

    [Fact]
    public async Task MultiValueIntersectionAndUnitChangesDoNotReinterpretData()
    {
        var d = await AddDefinition();
        d["value"]!["unit"] = "meters";
        await Publish(d);
        await Put(d.Text("key"), JsonValue.Create(5)!);
        d["value"]!["unit"] = "feet";
        await Publish(d);
        Assert.Equal(
            "VALUE_CONTRACT_CHANGED",
            (await engine.FilmAsync(film.Id))["film"]!["values"]![d.Text("key")].Text("status")
        );
        d["key"] = "user.other.palette";
        d["value"] = Parse(
            """{"cardinality":"many","semanticVersion":1,"schema":{"type":"object","properties":{"term":{"type":"string"}},"required":["term"],"additionalProperties":false}}"""
        );
        d["input"] = Parse("""{"component":"multi-select@1"}""");
        d["value"]!["vocabulary"] = "user.palette";
        await ConfigureVocabulary("user.palette", d);
        await CreateTerm("a", "user.palette", "A");
        var b = await CreateTerm("b", "user.palette", "B");
        await Put(d.Text("key"), Refs("a", "b"));
        b["enabled"] = false;
        await engine.PutTermAsync(
            new()
            {
                ["term"] = b,
                ["expectedRevision"] = 1,
                ["expectedGeneration"] = await Generation(),
            }
        );
        var entry = (await engine.FilmAsync(film.Id))["film"]!["values"]![d.Text("key")]!;
        Assert.Equal("PARTIAL_INTERSECTION", entry.Text("status"));
        Assert.True(JsonNode.DeepEquals(Refs("a"), entry["value"]));
    }

    [Fact]
    public async Task BulkFreezesTargetsAndReportsConcurrentValueAndMediaConflicts()
    {
        var d = await AddDefinition();
        var second = await repo.ImportMediaAsync(
            new()
            {
                LibraryId = "lib",
                Path = Path.Combine(directory, "second.mp4"),
                Size = 50,
            }
        );
        await engine.RecordMediaEventAsync("film.discovered", second.Id);
        var preview = await engine.PreviewBulkAsync(
            new()
            {
                ["query"] = new JsonObject(),
                ["changes"] = new JsonArray(new JsonObject { ["tagKey"] = d.Text("key"), ["value"] = 10 }),
            }
        );
        Assert.Equal(2, preview.Number("count"));
        await Put(d.Text("key"), JsonValue.Create(20)!);
        await repo.UpdateMediaAsync(second.Id, f => f with { Size = 51 });
        var third = await repo.ImportMediaAsync(
            new()
            {
                LibraryId = "lib",
                Path = Path.Combine(directory, "later.mp4"),
                Size = 1,
            }
        );
        await engine.RecordMediaEventAsync("film.discovered", third.Id);
        using var jobs = new JobCoordinator(db);
        var tagJobs = new TagJobs(engine, jobs);
        await jobs.InitializeAsync();
        var started = JsonSerializer.SerializeToNode(await tagJobs.StartBulkAsync(preview.Text("previewToken")))!;
        var job = await jobs.WaitAsync(started.Text("jobId"));
        Assert.Equal(JobState.Completed, job.State);
        var status = JsonNode.Parse(job.ResultJson!)!;
        Assert.Equal(2, status.List("conflicts").Count);
        Assert.Null((await engine.FilmAsync(third.Id))["film"]!["values"]![d.Text("key")]);
        Assert.Equal(20, (await engine.FilmAsync(film.Id))["film"]!["values"]![d.Text("key")]!.Number("value"));
        Assert.Equal(
            started.Text("jobId"),
            JsonSerializer.SerializeToNode(await tagJobs.StartBulkAsync(preview.Text("previewToken")))!.Text("jobId")
        );
    }

    [Fact]
    public async Task ImportPreservesArchiveAndDetectsChangesAfterPreview()
    {
        var d = await AddDefinition();
        await Put(d.Text("key"), JsonValue.Create(10)!);
        await Put(d.Text("key"), JsonValue.Create(20)!, 1);
        var exported = await engine.ExportAsync("annotations", true);
        var preview = await engine.PreviewImportAsync(
            new() { ["document"] = exported.DeepClone(), ["conflictPolicy"] = "replace" }
        );
        Assert.True(preview.Flag("canCommit"));
        await Put(d.Text("key"), JsonValue.Create(30)!, 2);
        var conflict = await Assert.ThrowsAsync<TagException>(() =>
            engine.CommitImportAsync(new() { ["previewToken"] = preview.Text("previewToken") })
        );
        Assert.Equal("VALUE_REVISION_CONFLICT", conflict.Code);
        preview = await engine.PreviewImportAsync(
            new() { ["document"] = exported.DeepClone(), ["conflictPolicy"] = "replace" }
        );
        await engine.CommitImportAsync(new() { ["previewToken"] = preview.Text("previewToken") });
        Assert.Equal(20, (await engine.FilmAsync(film.Id))["film"]!["values"]![d.Text("key")]!.Number("value"));
        var archive = await engine.ExportAsync("annotations", true);
        Assert.NotEmpty(archive.List("archives"));
        Assert.Contains("\"value\":10", archive["archives"]!.ToJsonString());
    }

    [Fact]
    public async Task SavedViewUsesExactlyTheSameTypedQueryAsFilmList()
    {
        var d = await AddDefinition();
        await Put(d.Text("key"), JsonValue.Create(42)!);
        await engine.SaveViewAsync(
            new()
            {
                ["id"] = "view-1",
                ["name"] = "Answer",
                ["query"] = new JsonObject
                {
                    ["where"] = new JsonObject
                    {
                        ["op"] = "eq",
                        ["tag"] = d.Text("key"),
                        ["value"] = 42,
                    },
                    ["orderBy"] = new JsonArray(new JsonObject { ["tag"] = d.Text("key") }),
                },
            }
        );
        var saved = (await repo.ViewsAsync()).Single();
        var query = JsonSerializer
            .SerializeToNode(saved.Query, new JsonSerializerOptions(JsonSerializerDefaults.Web))!
            .AsObject();
        Assert.Equal(1, (await engine.QueryAsync(query)).Number("total"));
    }

    [Fact]
    public async Task TimeScopeValidatesFileRevisionAndDoesNotChangeWholeAnnotation()
    {
        var d = await AddDefinition();
        await repo.UpdateMediaAsync(film.Id, f => f with { Duration = 30 });
        await Put(d.Text("key"), JsonValue.Create(7)!);
        var w = Write(d.Text("key"), JsonValue.Create(12));
        w["scope"] = Parse("""{"kind":"interval","scopeId":"clip-a","startUs":"1000000","endUs":"5000000"}""");
        await engine.BatchAsync(new() { ["expectedGeneration"] = await Generation(), ["writes"] = new JsonArray(w) });
        var detail = await engine.FilmAsync(film.Id);
        Assert.Single(detail.List("annotations"));
        Assert.Equal(7, detail["film"]!["values"]![d.Text("key")]!.Number("value"));
        w = w.DeepClone().AsObject();
        w["scope"]!["endUs"] = "35000000";
        w["expectedRevision"] = 1;
        await Assert.ThrowsAsync<TagException>(() =>
            engine.BatchAsync(
                new() { ["expectedGeneration"] = detail["generation"].Copy(), ["writes"] = new JsonArray(w) }
            )
        );
    }

    [Fact]
    public async Task OutboxRulesUseConfigAndDoNotLoopOnTheirOwnWrites()
    {
        var d = await AddDefinition();
        d["automation"] = new JsonArray(
            Parse(
                """{"id":"mirror","event":"annotation.changed","executor":"value.constant@1","args":{"value":9},"apply":"unless-locked","when":{"op":"eq","args":[{"fact":"event.tagKey"},{"literal":"user.external.trigger"}]}}"""
            )
        );
        await Publish(d);
        var other = await AddDefinition("user.external.trigger");
        await Put(other.Text("key"), JsonValue.Create(1)!);
        await engine.ResumeEventsAsync();
        await engine.ResumeEventsAsync();
        var entry = (await engine.FilmAsync(film.Id))["film"]!["values"]![d.Text("key")]!;
        Assert.Equal(9, entry.Number("value"));
        Assert.Equal(1, entry.Number("revision"));
    }

    [Fact]
    public async Task ConfigFragmentsAndAgentKnowledgeShareTheBundledSchema()
    {
        using var jobs = new JobCoordinator(db);
        var tagJobs = new TagJobs(engine, jobs);
        var rpc = new TagRpc(engine, tagJobs);
        var schema = (JsonObject)(await rpc.DispatchAsync("schema.get", Parse("""{"kind":"ui.layouts"}""")))!;
        Assert.NotNull(schema["properties"]?["root"]);
        var knowledge = await rpc.DispatchAsync("knowledge.read", Parse("""{"resource":"KNOWLEDGE.md"}"""));
        Assert.Contains("config.preview", JsonSerializer.Serialize(knowledge));
        await Assert.ThrowsAsync<TagException>(() =>
            rpc.DispatchAsync("config.preview", Parse("""{"layer":"system","changes":[]}"""))
        );
    }
}
