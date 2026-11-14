using System.Text.Json.Nodes;
using Vroom.Core.Application;
using Vroom.Core.Jobs;
using Vroom.Core.Storage;
using Vroom.Core.Tagging;

namespace Vroom.Tests;

public sealed partial class TaggingTests
{
    private async Task ConfigureDiscoveryAsync()
    {
        var package = await engine.ExportAsync("definitions");
        var changes = new JsonArray();
        foreach (var source in package.Map("sources"))
        {
            var disabled = source.Value!.DeepClone();
            disabled["enabled"] = false;
            changes.Add(
                new JsonObject
                {
                    ["kind"] = "sources",
                    ["key"] = source.Key,
                    ["value"] = disabled,
                }
            );
        }
        var toggle = package.List("definitions").First(d => d.Text("key") == "core.entity.follow")!.DeepClone();
        toggle["key"] = "user.unknown.follow";
        var field = package.List("definitions").First(d => d.Text("key") == "core.entity.discoveries")!.DeepClone();
        field["key"] = "user.unknown.records";
        field["enrichment"] = JsonNode.Parse(
            """[{"id":"new-records","source":"user.public-feed","field":"items","apply":"suggest-only","entities":{"namespace":"fixture-stable-identities","identity":{"op":"object-get","args":[{"fact":"source.value"},{"literal":"id"}]},"label":{"op":"object-get","args":[{"fact":"source.value"},{"literal":"name"}]},"annotations":{"core.discovery.reference":{"op":"object-get","args":[{"fact":"source.value"},{"literal":"id"}]}}}}]"""
        );
        var sourceDefinition = Parse(
            """{"label":{"en":"Neutral record feed"},"transport":"http","request":{"urlTemplate":"http://public.example/records"},"parse":{"format":"json","fields":{"items":{"pointer":"/items","structured":true}}},"subscription":{"enabledTag":"user.unknown.follow","intervalMinutes":15},"limits":{"minIntervalMs":500,"cacheTtlSeconds":0}}"""
        );
        foreach (var d in new[] { toggle, field })
            changes.Add(
                new JsonObject
                {
                    ["kind"] = "definition",
                    ["key"] = d.Text("key"),
                    ["value"] = d,
                }
            );
        changes.Add(
            new JsonObject
            {
                ["kind"] = "sources",
                ["key"] = "user.public-feed",
                ["value"] = sourceDefinition,
            }
        );
        var preview = await engine.PreviewConfigAsync(new() { ["changes"] = changes });
        await engine.ApplyConfigAsync(
            new()
            {
                ["previewToken"] = preview["previewToken"].Copy(),
                ["expectedGeneration"] = preview["generation"].Copy(),
            }
        );
        await repo.PatchSettingsAsync(new() { ["onlineMetadata"] = true });
    }

    private async Task AcceptDiscoveryAsync(string subjectId)
    {
        var detail = await engine.GetTermAsync(subjectId);
        var candidate = Assert.Single(detail.List("candidates"));
        await engine.ResolveCandidateAsync(
            new()
            {
                ["id"] = candidate!["id"].Copy(),
                ["accept"] = true,
                ["expectedGeneration"] = (await engine.SnapshotAsync())["generation"].Copy(),
                ["expectedRevision"] = detail["values"]?["user.unknown.records"].Number("revision") ?? 0,
            }
        );
    }

    private const string DiscoveryFixture =
        """{"items":[{"id":"https://source.example/one","name":"Same name"},{"id":"https://source.example/two","name":"Same name"}]}""";

    [Fact]
    public async Task DiscoveryReviewUsesStableExternalIdentityAndNeverMergesEqualNames()
    {
        await ConfigureDiscoveryAsync();
        await CreateTerm("user.observer.a", "core.people");
        await CreateTerm("user.observer.b", "core.people");
        await using var fixture = new SourceProxyFixture((_, _) => (200, "", DiscoveryFixture));
        using var sources = new TagSources(engine, fixture.Client());
        await sources.EnrichSubjectAsync("term", "user.observer.a");
        Assert.Equal(0L, await db.ReadAsync(c => c.Scalar("SELECT count(*) FROM tag_entity_identities")));
        await AcceptDiscoveryAsync("user.observer.a");
        var a = (await engine.GetTermAsync("user.observer.a"))["values"]!["user.unknown.records"]!.List("value");
        Assert.Equal(2, a.Count);
        Assert.NotEqual(a[0]!.Text("term"), a[1]!.Text("term"));
        await sources.EnrichSubjectAsync("term", "user.observer.b");
        await AcceptDiscoveryAsync("user.observer.b");
        var b = (await engine.GetTermAsync("user.observer.b"))["values"]!["user.unknown.records"]!.List("value");
        Assert.Equal(TagJson.Canonical(a), TagJson.Canonical(b));
        Assert.Equal(2L, await db.ReadAsync(c => c.Scalar("SELECT count(*) FROM tag_entity_identities")));
        foreach (var reference in b)
        {
            var entity = await engine.GetTermAsync(reference.Text("term"));
            Assert.StartsWith("https://source.example/", entity["values"]!["core.discovery.reference"]!.Text("value"));
        }
        var exported = await engine.ExportAsync("annotations", true);
        Assert.Equal(2, exported.List("entityIdentities").Count);
        var imported = await engine.PreviewImportAsync(new() { ["document"] = exported });
        Assert.True(imported.Flag("canCommit"));
        await engine.CommitImportAsync(new() { ["previewToken"] = imported["previewToken"].Copy() });
        Assert.Equal(2L, await db.ReadAsync(c => c.Scalar("SELECT count(*) FROM tag_entity_identities")));
    }

    [Fact]
    public async Task SubscriptionRunsFrozenSubjectsOncePerIntervalAndStopsWhenTheEffectiveToggleChanges()
    {
        await ConfigureDiscoveryAsync();
        await CreateTerm("user.observer", "core.people");
        await Batch(TermWrite("user.observer", "user.unknown.follow", JsonValue.Create(true)));
        await using var fixture = new SourceProxyFixture((_, _) => (200, "", DiscoveryFixture));
        using var sources = new TagSources(engine, fixture.Client());
        await using var jobs = new JobCoordinator(db);
        using var diagnostics = new LocalDiagnostics(directory);
        await using var subscriptions = new SourceSubscriptions(engine, sources, jobs, diagnostics);
        await jobs.InitializeAsync();
        var now = DateTimeOffset.UtcNow;
        Assert.Equal(1, await subscriptions.TickAsync(now, CancellationToken.None));
        Assert.Equal(0, await subscriptions.TickAsync(now.AddMinutes(1), CancellationToken.None));
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (
            jobs.List(null)
                .Items.Any(j => j.State is Vroom.Core.Domain.JobState.Queued or Vroom.Core.Domain.JobState.Running)
        )
        {
            await Task.Delay(20, timeout.Token);
        }
        Assert.Equal(Vroom.Core.Domain.JobState.Completed, Assert.Single(jobs.List(null).Items).State);
        Assert.Single((await engine.GetTermAsync("user.observer")).List("candidates"));
        var frozen = Assert.Single(await engine.DueSubscriptionsAsync(now.AddMinutes(16), CancellationToken.None));
        var write = TermWrite("user.observer", "user.unknown.follow", JsonValue.Create(false));
        write["expectedRevision"] = 1;
        await Batch(write);
        Assert.Equal(0, await subscriptions.TickAsync(now.AddMinutes(16), CancellationToken.None));
        var error = await Assert.ThrowsAsync<TagException>(() =>
            sources.EnrichSubscriptionAsync(frozen, CancellationToken.None)
        );
        Assert.Equal("STALE_SOURCE_RESULT", error.Code);
        Assert.Single(fixture.Requests);
    }

    [Fact]
    public async Task CandidateCannotIntroduceAReferenceCycleAndTheEntireResolutionRollsBack()
    {
        await CreateTerm("user.node.a", "core.people");
        await CreateTerm("user.node.b", "core.people");
        await Publish(RelationField("user.links", "core.people"));
        await Batch(TermWrite("user.node.a", "user.links", new JsonArray(new JsonObject { ["term"] = "user.node.b" })));
        await db.RunAsync(c =>
            TagEngine.Candidate(
                c,
                "user.node.b",
                "user.links",
                new JsonArray(new JsonObject { ["term"] = "user.node.a" }),
                "metadata",
                "fixture",
                "term:1",
                subjectKind: "term",
                subjectRevision: 1
            )
        );
        var candidate = Assert.Single((await engine.GetTermAsync("user.node.b")).List("candidates"));
        var generation = await Generation();
        await Assert.ThrowsAsync<TagException>(() =>
            engine.ResolveCandidateAsync(
                new()
                {
                    ["id"] = candidate!["id"].Copy(),
                    ["accept"] = true,
                    ["expectedGeneration"] = generation,
                    ["expectedRevision"] = 0,
                }
            )
        );
        Assert.Single((await engine.GetTermAsync("user.node.b")).List("candidates"));
    }
}
