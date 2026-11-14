using System.Text.Json.Nodes;
using Vroom.Core.Storage;
using Vroom.Core.Tagging;

namespace Vroom.Tests;

public sealed partial class TaggingTests
{
    [Fact]
    public async Task EnrichmentResolvesLinksAgainstFinalUrlIncludingCachedDocuments()
    {
        await using var fixture = new SourceProxyFixture(
            (uri, _) =>
                uri.AbsolutePath == "/start"
                    ? (302, "Location: http://other.example/folder/page\r\n", "")
                    : (200, "", "<a href=\"cover.jpg\">Cover</a>")
        );
        var source = Parse(
            """{"label":{"en":"Redirect review"},"transport":"http","request":{"urlTemplate":"http://public.example/start"},"parse":{"format":"html","fields":{"note":{"selector":"a","extract":"attribute:href","resolveUrl":true}}}}"""
        );
        await ConfigureFeedbackSource(source);
        await repo.PatchSettingsAsync(new() { ["onlineMetadata"] = true });
        using var sources = new TagSources(engine, fixture.Client());
        for (var attempt = 0; attempt < 2; attempt++)
        {
            var result = await sources.EnrichAsync(film.Id);
            Assert.True(result.Found);
            var detail = await engine.FilmAsync(film.Id);
            Assert.Contains("http://other.example/folder/cover.jpg", detail["candidates"]!.ToJsonString());
            Assert.Null(detail["film"]!["values"]?["user.feedback.note"]);
        }
        Assert.Equal(2, fixture.Requests.Count);
        Assert.Equal(1, await db.RunAsync(c => Convert.ToInt32(c.Scalar("SELECT COUNT(*) FROM tag_source_cache"))));
    }

    [Fact]
    public async Task EnrichmentRejectsAndDoesNotCachePagesWithoutRequiredIdentityInformation()
    {
        await using var fixture = new SourceProxyFixture(
            (uri, _) =>
                uri.AbsolutePath == "/start"
                    ? (302, "Location: /verify\r\n", "")
                    : (200, "", "<h3>Verification required</h3>")
        );
        var source = Parse(
            """{"label":{"en":"Required identity review"},"transport":"http","request":{"urlTemplate":"http://public.example/start"},"parse":{"format":"html","fields":{"note":{"selector":"h3"},"identity":{"selector":".identity"}}},"match":[{"field":"identity","tag":"user.feedback.note"}]}"""
        );
        await ConfigureFeedbackSource(source);
        await repo.PatchSettingsAsync(new() { ["onlineMetadata"] = true });
        using var sources = new TagSources(engine, fixture.Client());
        var result = await sources.EnrichAsync(film.Id);
        var error = Assert.Single(result.Sources, s => s.Error is not null);
        Assert.Equal("verification-required", error.Status);
        Assert.Equal("host.SourceHttp.requiredFieldMissing", error.Error);
        var detail = await engine.FilmAsync(film.Id);
        Assert.Empty(detail.List("candidates"));
        Assert.Null(detail["film"]!["values"]?["user.feedback.note"]);
        Assert.Equal(0, await db.RunAsync(c => Convert.ToInt32(c.Scalar("SELECT COUNT(*) FROM tag_source_cache"))));
    }
}
