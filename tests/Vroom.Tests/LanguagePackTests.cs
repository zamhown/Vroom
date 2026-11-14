using System.Text.Json.Nodes;
using Vroom.Core.Application;
using Vroom.Core.Storage;

namespace Vroom.Tests;

public sealed class LanguagePackTests
{
    [Fact]
    public async Task InstalledPacksPersistSeparatelyFromBuiltinsAndCanBeRemoved()
    {
        var folder = Path.Combine(Path.GetTempPath(), "vroom-language-" + Guid.NewGuid().ToString("N"));
        using var db = new CatalogDatabase(folder);
        var store = new LanguagePacks(db);
        var pack = JsonNode
            .Parse(
                """{"formatVersion":1,"locale":"fr","displayName":"Français","direction":"ltr","messages":{"ui.cancel":"Annuler"}}"""
            )!
            .AsObject();
        await store.InstallAsync(pack);
        Assert.Equal(
            "Annuler",
            (await new LanguagePacks(db).ListAsync()).Single()["messages"]!["ui.cancel"]!.GetValue<string>()
        );
        Assert.DoesNotContain(LanguagePacks.Bundled, p => p["locale"]!.GetValue<string>() == "fr");
        await store.RemoveAsync("fr");
        Assert.Empty(await store.ListAsync());
    }

    [Fact]
    public void RejectsUnsupportedFormatsPathsAndBuiltinOverrides()
    {
        var pack = JsonNode
            .Parse(
                """{"formatVersion":1,"locale":"fr","displayName":"Français","direction":"ltr","messages":{"ui.cancel":"Annuler"}}"""
            )!
            .AsObject();
        foreach (var locale in new[] { "../fr", LanguagePacks.DefaultLocale })
        {
            var invalid = pack.DeepClone().AsObject();
            invalid["locale"] = locale;
            Assert.ThrowsAny<ArgumentException>(() => LanguagePacks.Validate(invalid));
        }
        var version = pack.DeepClone().AsObject();
        version["formatVersion"] = 2;
        Assert.Throws<ArgumentException>(() => LanguagePacks.Validate(version));
        var unknown = pack.DeepClone().AsObject();
        unknown["messages"]!["unknown"] = true;
        Assert.Throws<ArgumentException>(() => LanguagePacks.Validate(unknown));
        Assert.Equal("zh-CN", LanguagePacks.DefaultLocale);
        Assert.Equal(
            new[] { "en", "zh-CN" },
            LanguagePacks.Bundled.Select(pack => pack["locale"]!.GetValue<string>()).Order().ToArray()
        );
    }
}
