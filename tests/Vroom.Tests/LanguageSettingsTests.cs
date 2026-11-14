using System.Text.Json.Nodes;
using Vroom.Core.Tagging;

namespace Vroom.Tests;

public sealed partial class TaggingTests
{
    private static JsonObject LanguageChange(string locale) =>
        new()
        {
            ["changes"] = new JsonArray(
                new JsonObject
                {
                    ["kind"] = "i18n",
                    ["key"] = "defaultLocale",
                    ["value"] = locale,
                }
            ),
        };

    [Fact]
    public async Task GlobalLanguageUsesTheUserLayerAndRoundTripsWithoutRewritingTranslations()
    {
        var before = await engine.SnapshotAsync();
        var preview = await engine.PreviewConfigAsync(LanguageChange("fr"));
        Assert.True(JsonNode.DeepEquals(before["package"]!["definitions"], preview["package"]!["definitions"]));
        Assert.Equal(0, preview.Number("projectedCount"));
        await engine.ApplyConfigAsync(
            new()
            {
                ["previewToken"] = preview["previewToken"].Copy(),
                ["expectedGeneration"] = preview["generation"].Copy(),
            }
        );
        var config = await engine.GetConfigAsync(new() { ["kind"] = "i18n", ["key"] = "defaultLocale" });
        Assert.Equal("fr", config["effective"]!.GetValue<string>());
        Assert.Equal(
            before["package"]!["i18n"]!["defaultLocale"]!.GetValue<string>(),
            config["system"]!.GetValue<string>()
        );
        var exported = await engine.ExportAsync("definitions");
        var import = await engine.PreviewImportAsync(new() { ["document"] = exported });
        await engine.CommitImportAsync(new() { ["previewToken"] = import["previewToken"].Copy() });
        var reopened = new TagEngine(repo);
        Assert.Equal("fr", (await reopened.SnapshotAsync())["package"]!["i18n"]!["defaultLocale"]!.GetValue<string>());
        Assert.True(
            JsonNode.DeepEquals(
                before["package"]!["definitions"],
                (await reopened.SnapshotAsync())["package"]!["definitions"]
            )
        );
    }

    [Fact]
    public async Task GlobalLanguageRejectsExtraKeysInvalidLocalesAndStalePreviews()
    {
        var wrong = LanguageChange("fr");
        wrong["changes"]![0]!["key"] = "anotherDefault";
        Assert.Equal(
            "CONFIG_KEY_UNAVAILABLE",
            (await Assert.ThrowsAsync<TagException>(() => engine.PreviewConfigAsync(wrong))).Code
        );
        await Assert.ThrowsAsync<TagException>(() => engine.PreviewConfigAsync(LanguageChange("invalid locale")));
        var first = await engine.PreviewConfigAsync(LanguageChange("fr"));
        var second = await engine.PreviewConfigAsync(LanguageChange("en"));
        await engine.ApplyConfigAsync(
            new()
            {
                ["previewToken"] = second["previewToken"].Copy(),
                ["expectedGeneration"] = second["generation"].Copy(),
            }
        );
        Assert.Equal(
            "STALE_GENERATION",
            (
                await Assert.ThrowsAsync<TagException>(() =>
                    engine.ApplyConfigAsync(
                        new()
                        {
                            ["previewToken"] = first["previewToken"].Copy(),
                            ["expectedGeneration"] = first["generation"].Copy(),
                        }
                    )
                )
            ).Code
        );
    }

    [Fact]
    public void GlobalLanguageControlsLiteralAndSharedFallback()
    {
        var text = Parse("""{"en":"Source","fr":"Global"}""");
        var package = Parse(
            """{"i18n":{"defaultLocale":"fr","messages":{"example":{"values":{"en":"Source","fr":"Global"}}}}}"""
        );
        Assert.Equal("Global", TagJson.Label(text, "ja", package));
        Assert.Equal("Global", TagJson.Label(Parse("""{"message":"example"}"""), "ja", package));
        Assert.Equal("Source", TagJson.Label(text, "en", package));
        // Without a package default the first entry is the fallback.
        Assert.Equal("Source", TagJson.Label(text, "ja"));
    }

    [Fact]
    public async Task LabelSortingUsesTheSameGlobalFallbackAsDisplay()
    {
        var a = await CreateTerm("user.locale-a", "core.people");
        var b = await CreateTerm("user.locale-b", "core.people");
        a["label"] = Parse("""{"en":"Zulu","fr":"Alpha"}""");
        b["label"] = Parse("""{"en":"Alpha","fr":"Zulu"}""");
        foreach (var term in new[] { a, b })
            await engine.PutTermAsync(
                new()
                {
                    ["term"] = term,
                    ["expectedRevision"] = term["revision"].Copy(),
                    ["expectedGeneration"] = await Generation(),
                }
            );
        var field = (await engine.SnapshotAsync())["package"]
            .List("definitions")
            .Single(d => d.Text("key") == "core.cast")!
            .DeepClone()
            .AsObject();
        field["query"]!["sort"] = true;
        await Publish(field);
        var second = await repo.ImportMediaAsync(
            new()
            {
                LibraryId = "lib",
                Path = Path.Combine(directory, "OTHER-002.mp4"),
                Size = 11,
                Duration = 60,
            }
        );
        var otherWrite = Write("core.cast", Refs("user.locale-b"));
        otherWrite["subject"]!["id"] = second.Id;
        await Batch(Write("core.cast", Refs("user.locale-a")), otherWrite);
        foreach (var (locale, first) in new[] { ("fr", film.Id), ("en", second.Id) })
        {
            var preview = await engine.PreviewConfigAsync(LanguageChange(locale));
            await engine.ApplyConfigAsync(new() { ["previewToken"] = preview["previewToken"].Copy() });
            var result = await engine.QueryAsync(
                Parse(
                    """{"orderBy":[{"tag":"core.cast","mode":"min","direction":"asc"}],"locale":"ja","ignoreDefaultQuery":true}"""
                )
            );
            Assert.Equal(2, result.Number("total"));
            Assert.Equal(first, result["films"]![0]!.Text("id"));
        }
    }
}
