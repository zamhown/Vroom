using System.Text.Json.Nodes;
using Vroom.Core.Domain;
using Vroom.Core.Storage;
using Vroom.Core.Tagging;

namespace Vroom.Tests;

public sealed partial class TaggingTests
{
    private Task SaveActivityJob(
        string id,
        JobState state,
        string time,
        string? parent = null,
        string? result = null
    ) =>
        db.RunAsync(connection =>
        {
            var job = new JobInfo(id, "test.task", state, 1, "", DateTimeOffset.Parse(time))
            {
                Updated = DateTimeOffset.Parse(time),
                ParentId = parent,
                Kind = "unfamiliar.operation",
                ResultJson = result,
            };
            connection.Execute(
                "INSERT INTO background_jobs VALUES(@id,@state,@kind,@updated,@payload)",
                ("@id", id),
                ("@state", JobStateConverter.Name(state)),
                ("@kind", job.Kind),
                ("@updated", time),
                ("@payload", CatalogRepository.Serialize(job))
            );
        });

    private Task SaveActivityCandidate(string id, string key, string time) =>
        db.RunAsync(connection =>
        {
            var candidate = new JsonObject
            {
                ["id"] = id,
                ["subjectId"] = film.Id,
                ["subjectKind"] = "film",
                ["tagKey"] = key,
                ["value"] = 42,
                ["updated"] = time,
                ["source"] = "unfamiliar.source",
                ["mediaRevision"] = TagEngine.MediaRevision(film),
            };
            connection.Execute(
                "INSERT INTO tag_candidates(id,subject_id,tag_key,payload) VALUES(@id,@subject,@key,@payload)",
                ("@id", id),
                ("@subject", film.Id),
                ("@key", key),
                ("@payload", candidate.ToJsonString())
            );
        });

    private static JsonObject ActivityRequest(string filter = "all", int limit = 20, JsonNode? before = null) =>
        new()
        {
            ["sources"] = new JsonArray("jobs", "candidates"),
            ["filter"] = filter,
            ["limit"] = limit,
            ["before"] = before.Copy(),
        };

    [Fact]
    public async Task ActivityMergesDurableSourcesWithStableCursorAndAttention()
    {
        await AddDefinition("unfamiliar.review-score");
        const string time = "2026-11-12T10:00:00.0000000+00:00";
        await SaveActivityJob("parent", JobState.Completed, time);
        await SaveActivityJob("child", JobState.Completed, time, "parent");
        await SaveActivityJob("failed-child", JobState.Failed, time, "parent");
        await SaveActivityCandidate("proposal", "unfamiliar.review-score", time);
        var first = await engine.ActivityAsync(ActivityRequest(limit: 2));
        Assert.Equal(3, first["total"]!.GetValue<long>());
        Assert.Equal(2, first["attention"]!.GetValue<long>());
        Assert.Equal(new[] { "job:parent", "job:failed-child" }, first.List("items").Select(x => x.Text("id")));
        await SaveActivityJob("newer", JobState.Completed, "2026-11-12T11:00:00.0000000+00:00");
        var older = await engine.ActivityAsync(ActivityRequest(limit: 2, before: first["next"]));
        Assert.Equal("candidate:proposal", Assert.Single(older.List("items")).Text("id"));
        Assert.Null(older["next"]);
        var attention = await engine.ActivityAsync(ActivityRequest("attention"));
        Assert.Equal(2, attention.List("items").Count);
        Assert.All(attention.List("items"), x => Assert.True(x.Flag("attention")));
        Assert.NotNull(older["items"]![0]!["subjectLabel"]);
    }

    [Fact]
    public async Task ActivityDismissalUsesExistingReviewCommandAndPreservesProposal()
    {
        await AddDefinition("unfamiliar.review-score");
        await SaveActivityCandidate("proposal", "unfamiliar.review-score", "2026-11-12T10:00:00.0000000+00:00");
        var generation = (await engine.SnapshotAsync())["generation"]!.GetValue<long>();
        Assert.Equal(
            "STALE_GENERATION",
            (
                await Assert.ThrowsAsync<TagException>(() =>
                    engine.ResolveCandidateAsync(
                        new()
                        {
                            ["id"] = "proposal",
                            ["accept"] = false,
                            ["expectedGeneration"] = generation - 1,
                        }
                    )
                )
            ).Code
        );
        Assert.Single((await engine.ActivityAsync(ActivityRequest())).List("items"));
        await engine.ResolveCandidateAsync(
            new()
            {
                ["id"] = "proposal",
                ["accept"] = false,
                ["expectedGeneration"] = generation,
            }
        );
        Assert.Empty((await engine.ActivityAsync(ActivityRequest())).List("items"));
        Assert.Equal(
            "rejected",
            await db.ReadAsync(connection => connection.Scalar("SELECT state FROM tag_candidates WHERE id='proposal'"))
        );
    }

    [Fact]
    public async Task ActivityExcludesUnavailableDefinitionsWithoutDeletingTheirProposals()
    {
        var definition = await AddDefinition("unfamiliar.review-score");
        await SaveActivityCandidate("proposal", definition.Text("key"), "2026-11-12T10:00:00.0000000+00:00");
        definition["enabled"] = false;
        definition["revision"] = 2;
        await Publish(definition);
        Assert.Empty((await engine.ActivityAsync(ActivityRequest())).List("items"));
        Assert.Equal(
            1L,
            await db.ReadAsync(connection =>
                connection.Scalar("SELECT COUNT(*) FROM tag_candidates WHERE id='proposal'")
            )
        );
    }

    [Fact]
    public async Task ActivityContractRejectsUnsupportedSourcesAndLayoutParameters()
    {
        await Assert.ThrowsAsync<TagException>(() => engine.ActivityAsync(Parse("""{"sources":["unknown"]}""")));
        // Use the same public schema and compiler used by publication and editor completion.
        var defaults = TagResources.Json("core.tagdefs.json");
        defaults["ui"]!["layouts"]!["workspace.activity"]!["root"]!["activity"]!["sources"] = new JsonArray("unknown");
        Assert.Throws<TagException>(() => new DefinitionCompiler().Compile(DefinitionDocument.From(defaults)));
    }

    [Theory]
    [InlineData("""{"counts":[{"state":"completed","count":2},{"state":"conflict","count":1}]}""")]
    [InlineData("""{"counts":{"completed":2,"failed":1}}""")]
    [InlineData("""{"failures":[{"id":"unfamiliar.target"}]}""")]
    public async Task CompletedTasksWithUnresolvedOutcomesRemainActionable(string result)
    {
        await SaveActivityJob("partial", JobState.Completed, "2026-11-12T10:00:00.0000000+00:00", result: result);
        Assert.Equal(
            "job:partial",
            Assert.Single((await engine.ActivityAsync(ActivityRequest("attention"))).List("items")).Text("id")
        );
    }

    [Fact]
    public async Task ReviewingAProposalCannotOverwriteAnEditMadeAfterComparison()
    {
        const string key = "unfamiliar.review-score";
        await AddDefinition(key);
        await SaveActivityCandidate("proposal", key, "2026-11-12T10:00:00.0000000+00:00");
        var generation = (await engine.SnapshotAsync())["generation"]!.GetValue<long>();
        await engine.BatchAsync(
            new() { ["expectedGeneration"] = generation, ["writes"] = new JsonArray(Write(key, JsonValue.Create(10))) }
        );
        var compared = await engine.AnnotationsAsync(new() { ["id"] = film.Id });
        await engine.BatchAsync(
            new()
            {
                ["expectedGeneration"] = generation,
                ["writes"] = new JsonArray(Write(key, JsonValue.Create(20), 1)),
            }
        );
        await Assert.ThrowsAsync<TagException>(() =>
            engine.ResolveCandidateAsync(
                new()
                {
                    ["id"] = "proposal",
                    ["accept"] = true,
                    ["expectedGeneration"] = generation,
                    ["expectedRevision"] = compared["values"]![key]!["revision"].Copy(),
                }
            )
        );
        Assert.Equal(
            20,
            (await engine.AnnotationsAsync(new() { ["id"] = film.Id }))["values"]![key]!["value"]!.GetValue<int>()
        );
        Assert.Single((await engine.ActivityAsync(ActivityRequest())).List("items"));
    }
}
