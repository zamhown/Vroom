namespace Vroom.Tests;

/// <summary>Lower layers must not depend on the tag system, application services or hosts.</summary>
public sealed class LayeringTests
{
    [Theory]
    [InlineData(
        "Domain",
        new[]
        {
            "Vroom.Core.Tagging",
            "Vroom.Core.Storage",
            "Vroom.Core.Application",
            "Vroom.Core.Intelligence",
            "Vroom.Core.Catalog",
            "Vroom.Core.Jobs",
        }
    )]
    [InlineData(
        "Storage",
        new[] { "Vroom.Core.Tagging", "Vroom.Core.Application", "Vroom.Core.Intelligence", "Vroom.Core.Catalog" }
    )]
    public void LowerLayersDoNotReferenceHigherLayers(string folder, string[] forbidden)
    {
        var root = new DirectoryInfo(AppContext.BaseDirectory);
        while (root is not null && !File.Exists(Path.Combine(root.FullName, "AGENTS.md")))
            root = root.Parent;
        Assert.NotNull(root);
        var problems = Directory
            .EnumerateFiles(
                Path.Combine(root.FullName, "src", "Vroom.Core", folder),
                "*.cs",
                SearchOption.AllDirectories
            )
            .SelectMany(file =>
                forbidden
                    .Where(ns => File.ReadAllText(file).Contains(ns, StringComparison.Ordinal))
                    .Select(ns => Path.GetFileName(file) + " -> " + ns)
            )
            .ToArray();
        Assert.Empty(problems);
    }
}
