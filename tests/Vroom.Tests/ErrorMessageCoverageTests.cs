using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Vroom.Tests;

/// <summary>Every error a user can see must have interface copy in each built-in language pack.</summary>
public sealed class ErrorMessageCoverageTests
{
    private static string Root()
    {
        var root = new DirectoryInfo(AppContext.BaseDirectory);
        while (root is not null && !File.Exists(Path.Combine(root.FullName, "AGENTS.md")))
            root = root.Parent;
        return root!.FullName;
    }

    [Fact]
    public void EveryDomainErrorCodeAndHostMessageIsTranslated()
    {
        var root = Root();
        var codes = new SortedSet<string>(StringComparer.Ordinal);
        var hostIds = new SortedSet<string>(StringComparer.Ordinal);
        foreach (
            var file in Directory.EnumerateFiles(
                Path.Combine(root, "src", "Vroom.Core"),
                "*.cs",
                SearchOption.AllDirectories
            )
        )
        {
            if (file.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}"))
                continue;
            var text = File.ReadAllText(file);
            // Any exception whose message is a stable code reaches clients as "error.CODE".
            foreach (Match match in Regex.Matches(text, "Exception\\(\\s*\"([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\""))
                codes.Add(match.Groups[1].Value);
            foreach (Match match in Regex.Matches(text, "\"(host\\.[A-Za-z0-9]+\\.[A-Za-z0-9]+)\""))
                hostIds.Add(match.Groups[1].Value);
        }
        Assert.NotEmpty(codes);
        foreach (var locale in new[] { "zh-CN", "en" })
        {
            var messages = JsonNode.Parse(
                File.ReadAllText(Path.Combine(root, "resources", "localization", "packs", locale + ".json"))
            )!["messages"]!.AsObject();
            Assert.Empty(
                codes.Where(code => !messages.ContainsKey("error." + code)).Select(code => locale + ":" + code)
            );
            Assert.Empty(hostIds.Where(id => !messages.ContainsKey(id)).Select(id => locale + ":" + id));
        }
    }
}
