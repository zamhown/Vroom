using System.Text;
using System.Text.RegularExpressions;

namespace Vroom.Core.Catalog;

/// <summary>
/// Library exclusion rules, evaluated against the path relative to the library root.
/// A rule without a separator or wildcard matches a whole path segment (for example
/// <c>$RECYCLE.BIN</c>); otherwise it is a glob where <c>*</c> stays inside a segment,
/// <c>**</c> crosses segments and <c>?</c> matches one character. Matching ignores case.
/// </summary>
public sealed class ExcludeMatcher
{
    private readonly string[] segments;
    private readonly Regex[] globs;

    public ExcludeMatcher(IEnumerable<string> rules)
    {
        var clean = rules.Select(r => r.Trim().Replace('\\', '/').Trim('/')).Where(r => r.Length > 0).ToArray();
        segments = clean.Where(r => r.IndexOfAny(['/', '*', '?']) < 0).ToArray();
        globs = clean.Where(r => r.IndexOfAny(['/', '*', '?']) >= 0).Select(Compile).ToArray();
    }

    public bool IsEmpty => segments.Length == 0 && globs.Length == 0;

    public bool Excludes(string relativePath)
    {
        if (IsEmpty)
            return false;
        var normalized = relativePath.Replace('\\', '/').Trim('/');
        if (normalized.Length == 0)
            return false;
        var parts = normalized.Split('/');
        if (parts.Any(part => segments.Any(s => string.Equals(s, part, StringComparison.OrdinalIgnoreCase))))
            return true;
        return globs.Any(glob => glob.IsMatch(normalized));
    }

    private static Regex Compile(string glob)
    {
        var pattern = new StringBuilder("^(?:.*/)?");
        for (var i = 0; i < glob.Length; i++)
        {
            var c = glob[i];
            if (c == '*' && i + 1 < glob.Length && glob[i + 1] == '*')
            {
                pattern.Append(".*");
                i++;
            }
            else if (c == '*')
                pattern.Append("[^/]*");
            else if (c == '?')
                pattern.Append("[^/]");
            else
                pattern.Append(Regex.Escape(c.ToString()));
        }
        pattern.Append("(?:/.*)?$");
        return new Regex(
            pattern.ToString(),
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.NonBacktracking
        );
    }
}
