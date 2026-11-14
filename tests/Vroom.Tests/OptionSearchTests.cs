using System.Text.Json;
using System.Text.Json.Nodes;

namespace Vroom.Tests;

public sealed partial class TaggingTests
{
    private async Task<string[]> OptionIds(string search, string locale)
    {
        var result = JsonSerializer.SerializeToNode(
            await engine.OptionsAsync(
                new()
                {
                    ["tagKey"] = "core.visibility",
                    ["search"] = search,
                    ["locale"] = locale,
                }
            )
        )!;
        return result["items"]!.AsArray().Select(i => i!["id"]!.GetValue<string>()).ToArray();
    }

    [Fact]
    public async Task OptionSearchMatchesNamesInAnyLanguageButNotSerializationKeys()
    {
        Assert.Contains("core.visibility.options.visible", await OptionIds("VISIB", "zh-CN"));
        Assert.Empty(await OptionIds("values", "en"));
        Assert.Empty(await OptionIds("defaultLocale", "en"));
        var ordered = await OptionIds("", "en");
        Assert.Equal(ordered.OrderBy(id => id.EndsWith("visible") ? 1 : 0).ToArray(), ordered);
    }
}
