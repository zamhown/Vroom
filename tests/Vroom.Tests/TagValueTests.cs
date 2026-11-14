using System.Text.Json;
using System.Text.Json.Nodes;
using Vroom.Core.Catalog;
using Vroom.Core.Domain;
using Vroom.Core.Intelligence;
using Vroom.Core.Jobs;
using Vroom.Core.Media;
using Vroom.Core.Storage;
using Vroom.Core.Tagging;

namespace Vroom.Tests;

public sealed partial class TaggingTests
{
    [Fact]
    public async Task AgentCanDiscoverConcreteValuesAndPrepareReviewedBulkChanges()
    {
        await AddPersonMetric();
        await CreateTerm("user.agent-person", "core.people");
        using var jobs = new JobCoordinator(db);
        var ffmpeg = new FfmpegService(repo);
        using var scanner = new LibraryScanner(repo, ffmpeg, jobs, engine, new TagSources(engine));
        await using var media = new LocalMediaServer(repo, ffmpeg);
        var tagJobs = new TagJobs(engine, jobs);
        var tools = new AgentTools(
            repo,
            scanner,
            jobs,
            media,
            engine,
            new TagRpc(engine, tagJobs),
            new TagSources(engine),
            tagJobs
        );
        var model = new ValueWorkflowModel();
        var plan = await new LocalAgent(model, tools).PlanAsync("Prepare a metric annotation for user.agent-person");
        Assert.Equal(5, model.Calls);
        Assert.Equal("annotations.bulk.commit", plan.Tool);
        Assert.True(plan.NeedsReview);
        Assert.Equal(1, plan.Preview!.Number("count"));
        Assert.Empty((await engine.GetTermAsync("user.agent-person"))["values"]!.AsObject());
        Assert.True(tools.Definitions.Single(t => t.Name == "terms.put").Mutates);
        await Assert.ThrowsAsync<InvalidOperationException>(() => tools.ExecuteAsync(plan.Tool, plan.Arguments, false));
    }

    private sealed class ValueWorkflowModel : ILocalModel
    {
        public int Calls { get; private set; }

        public Task<string> CompleteJsonAsync(string system, string request, CancellationToken ct)
        {
            Calls++;
            var output = Calls switch
            {
                1 => """{"tool":"terms.query","arguments":{"vocabulary":"core.people"}}""",
                2 => """{"tool":"terms.get","arguments":{"id":"user.agent-person"}}""",
                3 => """{"tool":"annotations.get","arguments":{"subject":{"kind":"term","id":"user.agent-person"}}}""",
                4 =>
                    """{"tool":"annotations.bulk.preview","arguments":{"subjectKind":"term","subjectIds":["user.agent-person"],"changes":[{"tagKey":"user.person.metric","operation":"set","value":28}]}}""",
                _ => new JsonObject
                {
                    ["tool"] = "annotations.bulk.commit",
                    ["arguments"] = new JsonObject
                    {
                        ["previewToken"] = JsonNode
                            .Parse(
                                request[
                                    (
                                        request.LastIndexOf(
                                            "TOOL DATA annotations.bulk.preview:\n",
                                            StringComparison.Ordinal
                                        ) + "TOOL DATA annotations.bulk.preview:\n".Length
                                    )..
                                ]
                            )!
                            .Text("previewToken"),
                    },
                }.ToJsonString(),
            };
            return Task.FromResult(output);
        }
    }

    private Task AddPersonMetric() =>
        Publish(
            Parse(
                """{"key":"user.person.metric","revision":1,"enabled":true,"label":{"en":"Test metric"},"parents":[],"targets":["term-whole"],"subjectVocabularies":["core.people"],"value":{"cardinality":"one","schema":{"type":"integer","minimum":0,"maximum":150},"semanticVersion":1},"input":{"component":"number@1"},"placements":[],"query":{"filter":true,"sort":true},"writes":{"manual":true}}"""
            )
        );

    private async Task ConfigureVocabulary(string vocabulary, params JsonObject[] definitions)
    {
        var changes = new JsonArray(
            new JsonObject
            {
                ["kind"] = "vocabularies",
                ["key"] = vocabulary,
                ["value"] = new JsonObject
                {
                    ["label"] = TagJson.Localized(vocabulary),
                    ["description"] = TagJson.Localized("Test vocabulary"),
                    ["enabled"] = true,
                    ["items"] = new JsonArray(),
                },
            }
        );
        foreach (var d in definitions)
            changes.Add(
                new JsonObject
                {
                    ["kind"] = "definition",
                    ["key"] = d.Text("key"),
                    ["value"] = d.DeepClone(),
                }
            );
        var preview = await engine.PreviewConfigAsync(new() { ["changes"] = changes });
        await engine.ApplyConfigAsync(new() { ["previewToken"] = preview.Text("previewToken") });
    }

    private async Task<JsonObject> CreateTerm(string id, string vocabulary, string label = "Same name")
    {
        var term = new JsonObject
        {
            ["id"] = id,
            ["revision"] = 0,
            ["enabled"] = true,
            ["label"] = TagJson.Localized(label),
            ["vocabularyIds"] = new JsonArray(vocabulary),
        };
        return (
            await engine.PutTermAsync(
                new()
                {
                    ["expectedGeneration"] = await Generation(),
                    ["expectedRevision"] = 0,
                    ["term"] = term,
                }
            )
        )["term"]!.DeepClone().AsObject();
    }

    private static JsonObject RelationField(string key, string vocabulary)
    {
        var d = Parse(
            """{"key":"placeholder","revision":1,"enabled":true,"label":{"en":"Relationship"},"parents":[],"targets":["film-whole","term-whole"],"value":{"cardinality":"many","semanticVersion":1,"schema":{"type":"object","properties":{"term":{"type":"string"}},"required":["term"],"additionalProperties":false},"vocabulary":"placeholder"},"input":{"component":"multi-select@1"},"placements":[]}"""
        );
        d["key"] = key;
        d["value"]!["vocabulary"] = vocabulary;
        return d;
    }

    private JsonObject TermWrite(string id, string key, JsonNode? value, long revision = 0) =>
        new()
        {
            ["subject"] = new JsonObject { ["kind"] = "term", ["id"] = id },
            ["scope"] = new JsonObject { ["kind"] = "whole" },
            ["tagKey"] = key,
            ["value"] = value,
            ["operation"] = value is null ? "clear" : "set",
            ["expectedRevision"] = revision,
        };

    private async Task<JsonObject> Batch(params JsonObject[] writes) =>
        await engine.BatchAsync(
            new()
            {
                ["expectedGeneration"] = await Generation(),
                ["writes"] = new JsonArray(writes.Select(w => (JsonNode?)w).ToArray()),
            }
        );

    private static JsonArray Refs(params string[] ids) =>
        new(ids.Select(id => (JsonNode?)new JsonObject { ["term"] = id }).ToArray());

    [Fact]
    public async Task ValuesHaveIdentityAndAttributesWhileDeclarationsCannotBeAnnotated()
    {
        await AddPersonMetric();
        var a = await CreateTerm("user.a", "core.people");
        var b = await CreateTerm("user.b", "core.people");
        Assert.NotEqual(a.Text("id"), b.Text("id"));
        await Batch(TermWrite("user.a", "user.person.metric", JsonValue.Create(28)));
        Assert.Equal(28, (await engine.GetTermAsync("user.a"))["values"]!["user.person.metric"]!.Number("value"));
        Assert.Empty((await engine.GetTermAsync("user.b"))["values"]!.AsObject());
        var bad = TermWrite("core.cast", "user.person.metric", JsonValue.Create(28));
        bad["subject"]!["kind"] = "tag";
        Assert.Equal("SUBJECT_UNRESOLVED", (await Assert.ThrowsAsync<TagException>(() => Batch(bad))).Code);
        var topic = await CreateTerm("user.topic", "core.topics");
        Assert.Equal(
            "SUBJECT_VOCABULARY_MISMATCH",
            (
                await Assert.ThrowsAsync<TagException>(() =>
                    Batch(TermWrite(topic.Text("id"), "user.person.metric", JsonValue.Create(10)))
                )
            ).Code
        );
        var scope = TermWrite("user.a", "user.person.metric", JsonValue.Create(30), 1);
        scope["scope"]!["kind"] = "point";
        Assert.Equal("SCOPE_UNSUPPORTED", (await Assert.ThrowsAsync<TagException>(() => Batch(scope))).Code);
        a["label"] = TagJson.Localized("Renamed");
        await engine.PutTermAsync(
            new()
            {
                ["term"] = a,
                ["expectedGeneration"] = await Generation(),
                ["expectedRevision"] = 1,
            }
        );
        Assert.Equal(28, (await engine.GetTermAsync("user.a"))["values"]!["user.person.metric"]!.Number("value"));
    }

    [Fact]
    public async Task CrossFieldAndBatchCyclesRollBackWithoutRejectingSharedDescendants()
    {
        var x = RelationField("user.links.a", "user.nodes");
        var y = RelationField("user.links.b", "user.nodes");
        await ConfigureVocabulary("user.nodes", x, y);
        foreach (var id in new[] { "a", "b", "c", "d" })
            await CreateTerm(id, "user.nodes");
        await Batch(
            TermWrite("a", x.Text("key"), Refs("b", "c")),
            TermWrite("b", y.Text("key"), Refs("d")),
            TermWrite("c", x.Text("key"), Refs("d"))
        );
        var cycle = await Assert.ThrowsAsync<TagException>(() => Batch(TermWrite("d", y.Text("key"), Refs("a"))));
        Assert.Equal("TERM_CYCLE", cycle.Code);
        Assert.Empty((await engine.GetTermAsync("d"))["values"]!.AsObject());
        await CreateTerm("e", "user.nodes");
        await CreateTerm("f", "user.nodes");
        Assert.Equal(
            "TERM_CYCLE",
            (
                await Assert.ThrowsAsync<TagException>(() =>
                    Batch(TermWrite("e", x.Text("key"), Refs("f")), TermWrite("f", y.Text("key"), Refs("e")))
                )
            ).Code
        );
        Assert.Empty((await engine.GetTermAsync("e"))["values"]!.AsObject());
    }

    [Fact]
    public async Task ReferencesAndReactivatedFieldsCannotCreateCycles()
    {
        var relation = RelationField("user.link", "user.nodes");
        var other = RelationField("user.other-link", "user.nodes");
        await ConfigureVocabulary("user.nodes", relation, other);
        await CreateTerm("a", "user.nodes");
        await CreateTerm("b", "user.nodes");
        await Batch(TermWrite("a", "user.link", Refs("b")));
        Assert.Equal(
            "TERM_CYCLE",
            (await Assert.ThrowsAsync<TagException>(() => Batch(TermWrite("b", "user.other-link", Refs("a"))))).Code
        );
        relation["enabled"] = false;
        await Publish(relation);
        await Batch(TermWrite("b", "user.other-link", Refs("a")));
        relation["enabled"] = true;
        Assert.Equal("TERM_CYCLE", (await Assert.ThrowsAsync<TagException>(() => Publish(relation))).Code);
        Assert.False(
            (await engine.SnapshotAsync())["package"]
                .List("definitions")
                .Single(d => d.Text("key") == "user.link")
                .Flag("enabled")
        );
    }

    [Fact]
    public async Task RelatedFiltersConstrainTheSameEntityAndIgnoreDisabledValues()
    {
        await AddPersonMetric();
        await CreateTerm("a", "core.people");
        var b = await CreateTerm("b", "core.people");
        await Batch(
            Write("core.cast", Refs("a", "b")),
            TermWrite("a", "user.person.metric", JsonValue.Create(20)),
            TermWrite("b", "user.person.metric", JsonValue.Create(40))
        );
        var q = Parse(
            """{"where":{"op":"related","tag":"core.cast","where":{"op":"and","args":[{"op":"gte","tag":"user.person.metric","value":30},{"op":"lte","tag":"user.person.metric","value":25}]}}}"""
        );
        Assert.Equal(0, (await engine.QueryAsync(q)).Number("total"));
        q["where"]!["where"] = Parse("""{"op":"gte","tag":"user.person.metric","value":30}""");
        Assert.Equal(1, (await engine.QueryAsync(q)).Number("total"));
        b["enabled"] = false;
        await engine.PutTermAsync(
            new()
            {
                ["term"] = b,
                ["expectedGeneration"] = await Generation(),
                ["expectedRevision"] = 1,
            }
        );
        Assert.Equal(0, (await engine.QueryAsync(q)).Number("total"));
        Assert.Equal(
            "[{\"term\":\"a\"}]",
            (await engine.FilmAsync(film.Id))["film"]!["values"]!["core.cast"]!["value"]!.ToJsonString()
        );
        Assert.Null((await engine.GetTermAsync("b"))["values"]!["user.person.metric"]!["value"]);
    }

    [Fact]
    public async Task ValueImportHasCasAndStandaloneAnnotationExportContainsIdentities()
    {
        await AddPersonMetric();
        var term = await CreateTerm("a", "core.people");
        await Batch(TermWrite("a", "user.person.metric", JsonValue.Create(29)), Write("core.cast", Refs("a")));
        var export = await engine.ExportAsync("annotations", true);
        Assert.Equal(3, export.Number("formatVersion"));
        Assert.Contains(export.List("terms"), t => t.Text("id") == "a");
        var preview = await engine.PreviewImportAsync(new() { ["document"] = export, ["conflictPolicy"] = "replace" });
        term["label"] = TagJson.Localized("Changed");
        await engine.PutTermAsync(
            new()
            {
                ["term"] = term,
                ["expectedGeneration"] = await Generation(),
                ["expectedRevision"] = 1,
            }
        );
        Assert.Equal(
            "TERM_REVISION_CONFLICT",
            (
                await Assert.ThrowsAsync<TagException>(() =>
                    engine.CommitImportAsync(new() { ["previewToken"] = preview.Text("previewToken") })
                )
            ).Code
        );
        Assert.Equal("Changed", (await engine.GetTermAsync("a"))["term"]!["label"]!["und"]!.ToString());
    }

    [Fact]
    public async Task TermBulkFreezesIdentitiesAndDetectsProfileChanges()
    {
        await AddPersonMetric();
        var a = await CreateTerm("a", "core.people");
        await CreateTerm("b", "core.people");
        var preview = await engine.PreviewBulkAsync(
            Parse(
                """{"subjectKind":"term","query":{"vocabulary":"core.people"},"changes":[{"tagKey":"user.person.metric","value":25}]}"""
            )
        );
        Assert.Equal(2, preview.Number("count"));
        a["label"] = TagJson.Localized("After preview");
        await engine.PutTermAsync(
            new()
            {
                ["term"] = a,
                ["expectedGeneration"] = await Generation(),
                ["expectedRevision"] = 1,
            }
        );
        await CreateTerm("c", "core.people");
        using var jobs = new JobCoordinator(db);
        var tagJobs = new TagJobs(engine, jobs);
        await jobs.InitializeAsync();
        var job = JsonSerializer.SerializeToNode(await tagJobs.StartBulkAsync(preview.Text("previewToken")))!;
        await jobs.WaitAsync(job.Text("jobId"));
        var status = JsonSerializer.SerializeToNode(await engine.BulkStatusAsync(preview.Text("previewToken")))!;
        Assert.Single(status.List("conflicts"));
        Assert.Equal(25, (await engine.GetTermAsync("b"))["values"]!["user.person.metric"]!.Number("value"));
        Assert.Empty((await engine.GetTermAsync("c"))["values"]!.AsObject());
    }
}
