using System.Text.RegularExpressions;
using Vroom.Core.Tagging;

namespace Vroom.Tests;

/// <summary>Every RPC method, task kind and Agent tool the client names must exist on the host.</summary>
public sealed class RpcContractTests
{
    private static string Root()
    {
        var root = new DirectoryInfo(AppContext.BaseDirectory);
        while (root is not null && !File.Exists(Path.Combine(root.FullName, "AGENTS.md")))
            root = root.Parent;
        return root!.FullName;
    }

    private static IEnumerable<string> Sources(string root, string folder, params string[] extensions) =>
        Directory
            .EnumerateFiles(Path.Combine(root, folder), "*", SearchOption.AllDirectories)
            .Where(f =>
                extensions.Contains(Path.GetExtension(f))
                && !f.Contains("node_modules")
                && !f.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}")
                && !f.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}")
                && !f.Contains(".test.")
            )
            .Select(File.ReadAllText);

    private static HashSet<string> Names(IEnumerable<string> texts, string pattern) =>
        texts
            .SelectMany(t => Regex.Matches(t, pattern).Select(m => m.Groups[1].Value))
            .ToHashSet(StringComparer.Ordinal);

    [Fact]
    public void ClientCallsOnlyMethodsTasksAndToolsTheHostImplements()
    {
        var root = Root();
        var client = Sources(root, "src/Vroom.Client/src", ".ts", ".tsx").ToArray();
        var core = Sources(root, "src/Vroom.Core", ".cs").ToArray();
        // Hosts dispatch with switch statements, switch expressions and explicit comparisons.
        var methods = Names(core, "case \"([a-z][a-zA-Z0-9.-]+)\":");
        methods.UnionWith(Names(core, "\"([a-z][a-zA-Z0-9-]*\\.[a-zA-Z0-9.-]+)\" =>"));
        methods.UnionWith(Names(core, "method == \"([a-z][a-zA-Z0-9.-]+)\""));
        methods.UnionWith(TagRpc.Methods);
        var jobs = Names(core, "Register\\(\\s*\"([a-z][a-zA-Z0-9.-]+)\"");
        var tools = Names(core, "Add\\(\\s*\"([a-z][a-zA-Z0-9.-]+)\"");
        var called = Names(client, "\\bcall(?:<[^>()]*(?:<[^>]*>[^>()]*)*>)?\\(\\s*'([a-z][a-zA-Z0-9.-]+)'");
        var started = Names(client, "\\bstartJob\\(\\s*'([a-z][a-zA-Z0-9.-]+)'");
        var used = Names(client, "\\btool(?:<[^>]*>)?\\(\\s*'([a-z][a-zA-Z0-9.-]+)'");
        Assert.NotEmpty(called);
        var unknownMethods = called
            // A trailing dot is a dynamic prefix (for example forwarded native player commands).
            .Where(m => !m.EndsWith('.') && !methods.Contains(m))
            .ToArray();
        var unknownJobs = started.Where(k => !jobs.Contains(k)).ToArray();
        var unknownTools = used.Where(t => !tools.Contains(t)).ToArray();
        Assert.Equal([], unknownMethods);
        Assert.Equal([], unknownJobs);
        Assert.Equal([], unknownTools);
    }
}
