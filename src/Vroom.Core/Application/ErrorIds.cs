using System.Text.RegularExpressions;
using Vroom.Core.Tagging;

namespace Vroom.Core.Application;

/// <summary>Maps exceptions to stable interface message IDs ("error.CODE" or "host.*").</summary>
public static partial class ErrorIds
{
    [GeneratedRegex("^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$")]
    private static partial Regex CodePattern();

    /// <summary>The domain error code carried by an exception, if any.</summary>
    public static string? Code(Exception ex) =>
        ex is TagException tag ? tag.Code
        : CodePattern().IsMatch(ex.Message) ? ex.Message
        : null;

    /// <summary>A message ID, or null when the exception text is not a stable ID.</summary>
    public static string? MessageId(Exception ex) =>
        Code(ex) is { } code ? "error." + code
        : ex.Message.StartsWith("host.", StringComparison.Ordinal) ? ex.Message
        : null;
}
