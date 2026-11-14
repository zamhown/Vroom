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
    public void EveryInstalledTagHasLocalizedDescriptionButUserDescriptionsRemainOptional()
    {
        var defaults = TagResources.Json("core.tagdefs.json");
        foreach (var definition in defaults.List("definitions"))
        {
            Assert.False(
                string.IsNullOrWhiteSpace(definition?["description"]?["zh-CN"]?.ToString()),
                definition.Text("key")
            );
            Assert.False(
                string.IsNullOrWhiteSpace(definition?["description"]?["en"]?.ToString()),
                definition.Text("key")
            );
        }
        var copy = defaults.DeepClone().AsObject();
        copy.List("definitions")[0]!.AsObject().Remove("description");
        _ = new DefinitionCompiler().Compile(DefinitionDocument.From(copy));
    }

    [Fact]
    public async Task CreatableReferenceOptionUsesStableIdentityWithoutRepublishingDefinition()
    {
        var d = await AddDefinition("user.custom.palette");
        d["value"] = Parse(
            """{"cardinality":"one","semanticVersion":1,"schema":{"type":"object","properties":{"term":{"type":"string"}},"required":["term"],"additionalProperties":false}}"""
        );
        d["input"] = Parse("""{"component":"select@1"}""");
        d["value"]!["vocabulary"] = "user.palette";
        d["writes"] = Parse("""{"manual":true,"createTerms":{"namespace":"user.palette"}}""");
        await ConfigureVocabulary("user.palette", d);
        var generation = await Generation();
        var result = JsonSerializer.SerializeToNode(
            await engine.CreateOptionAsync(
                new()
                {
                    ["tagKey"] = d.Text("key"),
                    ["name"] = "new",
                    ["expectedGeneration"] = generation.Copy(),
                    ["write"] = Write(d.Text("key"), null),
                }
            )
        )!;
        Assert.StartsWith("user.palette.", result["value"].Text("term"));
        Assert.Equal(
            result["value"].Text("term"),
            (await engine.FilmAsync(film.Id))["film"]!["values"]![d.Text("key")]!["value"].Text("term")
        );
        Assert.True(JsonNode.DeepEquals(generation, await Generation()));
        Assert.Equal("new", (await engine.GetTermAsync(result.Text("key")))["term"]!["label"]!["und"]!.ToString());
        Assert.DoesNotContain(
            (await engine.SnapshotAsync())["package"].List("definitions"),
            f => f.Text("key") == result.Text("key")
        );
    }

    [Fact]
    public async Task ProvenanceAndUnlockChangesAreAuditedWithoutChangingValue()
    {
        var d = await AddDefinition();
        await Put(d.Text("key"), JsonValue.Create(9)!);
        var write = Write(d.Text("key"), JsonValue.Create(9), 1);
        write["locked"] = false;
        write["provenance"] = Parse("""{"source":"user.review","observedAt":"2026-11-01T00:00:00Z"}""");
        await engine.BatchAsync(
            new() { ["expectedGeneration"] = await Generation(), ["writes"] = new JsonArray(write) }
        );
        write = write.DeepClone().AsObject();
        write["expectedRevision"] = 2;
        write["provenance"]!["source"] = "user.second-review";
        await engine.BatchAsync(
            new() { ["expectedGeneration"] = await Generation(), ["writes"] = new JsonArray(write) }
        );
        var record = (await engine.FilmAsync(film.Id))["film"]!["values"]![d.Text("key")]!;
        Assert.Equal(3, record.Number("revision"));
        Assert.Equal(9, record.Number("value"));
        Assert.False(record["editPolicy"].Flag("locked"));
    }

    [Fact]
    public async Task BulkPauseStopAndRestartRetainFrozenTargets()
    {
        var d = await AddDefinition();
        var preview = await engine.PreviewBulkAsync(
            new()
            {
                ["query"] = new JsonObject(),
                ["changes"] = new JsonArray(new JsonObject { ["tagKey"] = d.Text("key"), ["value"] = 15 }),
            }
        );
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var entered = 0;
        string id;
        await using (var jobs = new JobCoordinator(db))
        {
            jobs.Register(
                "hold",
                async (context, _) =>
                {
                    Interlocked.Increment(ref entered);
                    await release.Task.WaitAsync(context.CancellationToken);
                    return null;
                }
            );
            var tagJobs = new TagJobs(engine, jobs);
            await jobs.InitializeAsync();
            for (int i = 0; i < 3; i++)
                await jobs.StartAsync("hold", "hold");
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            while (Volatile.Read(ref entered) < 3)
                await Task.Delay(10, timeout.Token);
            id = JsonSerializer
                .SerializeToNode(await tagJobs.StartBulkAsync(preview.Text("previewToken")))!
                .Text("jobId");
            await jobs.PauseAsync(id);
            release.TrySetResult();
            while (jobs.Get(id).State != JobState.Paused)
                await Task.Delay(10, timeout.Token);
            Assert.Null((await engine.FilmAsync(film.Id))["film"]!["values"]![d.Text("key")]);
            await jobs.StopAsync(id);
            Assert.Equal(JobState.Cancelled, (await jobs.WaitAsync(id, timeout.Token)).State);
        }
        var later = await repo.ImportMediaAsync(
            new()
            {
                LibraryId = "lib",
                Path = Path.Combine(directory, "later.mp4"),
                Size = 1,
            }
        );
        await using (var jobs = new JobCoordinator(db))
        {
            _ = new TagJobs(engine, jobs);
            await jobs.InitializeAsync();
            Assert.Equal(JobState.Cancelled, jobs.Get(id).State);
            await jobs.ResumeAsync(id);
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            Assert.Equal(JobState.Completed, (await jobs.WaitAsync(id, timeout.Token)).State);
        }
        Assert.Equal(15, (await engine.FilmAsync(film.Id))["film"]!["values"]![d.Text("key")]!.Number("value"));
        Assert.Null((await engine.FilmAsync(later.Id))["film"]!["values"]![d.Text("key")]);
    }

    [Fact]
    public async Task AgentDiscoversSchemaPreviewsUserOverrideAndCannotPublishWithoutReview()
    {
        var d = await AddDefinition();
        var changed = d.DeepClone().AsObject();
        changed["label"] = Parse("""{"en":"Reviewed field"}""");
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
        var generation = await Generation();
        var model = new ScriptedTagModel(
            (step, context) =>
                step switch
                {
                    0 => Call("schema.get", Parse("""{"kind":"definition"}""")),
                    1 => Call("definitions.get", new() { ["key"] = d.Text("key") }),
                    2 => Call(
                        "config.preview",
                        new()
                        {
                            ["layer"] = "user",
                            ["expectedGeneration"] = generation.Copy(),
                            ["changes"] = new JsonArray(
                                new JsonObject
                                {
                                    ["kind"] = "definition",
                                    ["key"] = d.Text("key"),
                                    ["value"] = changed.Copy(),
                                }
                            ),
                        }
                    ),
                    _ => Call("config.apply", PreviewArguments(context)),
                }
        );
        var plan = await new LocalAgent(model, tools).PlanAsync("Change this field's label");
        Assert.True(plan.NeedsReview);
        Assert.NotNull(plan.Preview);
        Assert.Equal("config.apply", plan.Tool);
        Assert.Equal(
            "Progress",
            TagJson.Label((await engine.GetConfigAsync(new() { ["key"] = d.Text("key") }))["effective"]?["label"])
        );
        await Assert.ThrowsAsync<InvalidOperationException>(() => tools.ExecuteAsync(plan.Tool, plan.Arguments, false));
        var result = await tools.ExecuteAsync(plan.Tool, plan.Arguments, true);
        var id = JsonNode.Parse(result.Json)!.Text("jobId");
        Assert.Equal(JobState.Completed, (await jobs.WaitAsync(id)).State);
        Assert.Equal(
            "Reviewed field",
            TagJson.Label((await engine.GetConfigAsync(new() { ["key"] = d.Text("key") }))["effective"]?["label"])
        );
    }

    private static string Call(string tool, JsonObject arguments) =>
        new JsonObject { ["tool"] = tool, ["arguments"] = arguments }.ToJsonString();

    private static JsonObject PreviewArguments(string context)
    {
        var token = System
            .Text.RegularExpressions.Regex.Matches(context, "\"previewToken\":\"([^\"]+)\"")
            .Last()
            .Groups[1]
            .Value;
        return new() { ["previewToken"] = token };
    }

    private sealed class ScriptedTagModel(Func<int, string, string> output) : ILocalModel
    {
        private int step;

        public Task<string> CompleteJsonAsync(string system, string request, CancellationToken ct) =>
            Task.FromResult(output(step++, request));
    }
}
