using System.Text.Json.Nodes;
using Vroom.Core.Storage;
using Vroom.Core.Tagging;

namespace Vroom.Tests;

public sealed partial class TaggingTests
{
    private async Task ConfigureConsensusAsync(string[] groups, bool term = false)
    {
        var d = await AddDefinition("user.unfamiliar.measure");
        d["targets"] = new JsonArray(term ? "term-whole" : "film-whole");
        d["placements"] = new JsonArray();
        d["enrichmentPolicy"] = new JsonObject { ["minIndependentSources"] = 2 };
        var changes = new JsonArray();
        var exported = await engine.ExportAsync("definitions");
        foreach (var source in exported.Map("sources"))
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
        var enrichment = new JsonArray();
        for (var i = 0; i < groups.Length; i++)
        {
            var key = "user.feed." + i;
            var source = Parse(
                """{"label":{"en":"Independent observation"},"transport":"http","request":{"urlTemplate":"http://public.example/"},"parse":{"format":"json","fields":{"measure":{"pointer":"/measure"}}},"limits":{"minIntervalMs":500,"cacheTtlSeconds":0}}"""
            );
            source["request"]!["urlTemplate"] = "http://public.example/" + i;
            source["evidenceGroup"] = groups[i];
            changes.Add(
                new JsonObject
                {
                    ["kind"] = "sources",
                    ["key"] = key,
                    ["value"] = source,
                }
            );
            enrichment.Add(
                new JsonObject
                {
                    ["id"] = key,
                    ["source"] = key,
                    ["field"] = "measure",
                    ["apply"] = "if-unset",
                    ["transform"] = new JsonObject
                    {
                        ["op"] = "parse-number",
                        ["args"] = new JsonArray(new JsonObject { ["fact"] = "source.value" }),
                    },
                }
            );
        }
        d["enrichment"] = enrichment;
        changes.Add(
            new JsonObject
            {
                ["kind"] = "definition",
                ["key"] = d.Text("key"),
                ["value"] = d,
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

    [Theory]
    [InlineData(false, false, true)]
    [InlineData(true, false, false)]
    [InlineData(false, true, false)]
    public async Task IndependentAgreementIsRequiredAndConflictsRemainReviewable(
        bool sameUpstream,
        bool conflict,
        bool applied
    )
    {
        await ConfigureConsensusAsync(["upstream-a", sameUpstream ? "upstream-a" : "upstream-b"]);
        await using var fixture = new SourceProxyFixture(
            (uri, _) =>
                (200, "", conflict && uri.AbsolutePath == "/1" ? "{\"measure\":\"99\"}" : "{\"measure\":\"41\"}")
        );
        using var sources = new TagSources(engine, fixture.Client());
        Assert.True((await sources.EnrichAsync(film.Id)).Found);
        var detail = await engine.FilmAsync(film.Id);
        var value = detail["film"]!["values"]?["user.unfamiliar.measure"];
        if (applied)
        {
            Assert.Equal(41, value!.Number("value"));
            Assert.Equal(2, value!["provenance"].List("evidence").Count);
            Assert.Empty(detail.List("candidates"));
        }
        else
        {
            Assert.Null(value);
            Assert.Equal(conflict ? 2 : 1, detail.List("candidates").Count);
            Assert.All(detail.List("candidates"), c => Assert.Equal(2, c.List("evidence").Count));
        }
        Assert.Equal(1L, await db.ReadAsync(c => c.Scalar("SELECT count(*) FROM tag_source_observations")));
    }

    [Fact]
    public async Task TermProfilesUseTheSameGenericPipelineAndKeepRejectedEvidenceRejected()
    {
        await ConfigureConsensusAsync(["same-upstream", "same-upstream"], true);
        await CreateTerm("user.unfamiliar.entity", "core.people");
        await using var fixture = new SourceProxyFixture((_, _) => (200, "", "{\"measure\":\"41\"}"));
        using var sources = new TagSources(engine, fixture.Client());
        await sources.EnrichSubjectAsync("term", "user.unfamiliar.entity");
        var term = await engine.GetTermAsync("user.unfamiliar.entity");
        var candidate = Assert.Single(term.List("candidates"));
        Assert.Equal("term", candidate.Text("subjectKind"));
        Assert.Empty((await engine.FilmAsync(film.Id)).List("candidates"));
        await engine.ResolveCandidateAsync(
            new()
            {
                ["id"] = candidate!["id"].Copy(),
                ["accept"] = false,
                ["expectedGeneration"] = term["generation"].Copy(),
            }
        );
        await sources.EnrichSubjectAsync("term", "user.unfamiliar.entity");
        Assert.Empty((await engine.GetTermAsync("user.unfamiliar.entity")).List("candidates"));
        Assert.Null((await engine.GetTermAsync("user.unfamiliar.entity"))["values"]?["user.unfamiliar.measure"]);
    }
}
