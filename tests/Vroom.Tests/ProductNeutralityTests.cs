using System.Text.RegularExpressions;

namespace Vroom.Tests;

public sealed class ProductNeutralityTests
{
    [Fact]
    public void ActiveProductDoesNotReferenceConcreteTagDefinitionsOrLegacyBusinessServices()
    {
        var root = new DirectoryInfo(AppContext.BaseDirectory);
        while (root is not null && !File.Exists(Path.Combine(root.FullName, "AGENTS.md")))
            root = root.Parent;
        Assert.NotNull(root);
        var forbidden = new Regex(
            "[\"'.]core\\.(?!tagdefs\\.json)[a-z]|\\b(?:TagKind|FilmRating|PathTagParser|JavBusProvider)\\b|Labels\\.Ratings?\\b|film\\.(?:rating|favorite|watched|code|posterPath)\\b|(?i:javbus)",
            RegexOptions.CultureInvariant
        );
        var problems = new List<string>();
        foreach (var project in new[] { "Vroom.Core", "Vroom.App", "Vroom.Web", "Vroom.Client/src" })
        foreach (
            var path in Directory.EnumerateFiles(
                Path.Combine(root.FullName, "src", project),
                "*",
                SearchOption.AllDirectories
            )
        )
        {
            var relative = Path.GetRelativePath(root.FullName, path).Replace('\\', '/');
            if (
                relative.Contains("/obj/")
                || relative.Contains("/bin/")
                || relative.Contains(".test.")
                || relative.Contains("/wwwroot/")
                || relative.Contains("/Resources/Raw/")
                || Path.GetExtension(path) is not (".cs" or ".ts" or ".tsx" or ".css" or ".mjs" or ".xaml")
            )
                continue;
            if (forbidden.IsMatch(File.ReadAllText(path)))
                problems.Add(relative);
        }
        Assert.Empty(problems);
    }
}
