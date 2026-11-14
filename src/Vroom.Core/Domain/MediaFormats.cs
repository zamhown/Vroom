namespace Vroom.Core.Domain;

/// <summary>File extensions the host indexes and plays as video.</summary>
public static class MediaFormats
{
    public static readonly IReadOnlySet<string> VideoExtensions = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        ".mp4",
        ".mkv",
        ".avi",
        ".mov",
        ".wmv",
        ".webm",
        ".m4v",
        ".ts",
        ".mts",
        ".m2ts",
        ".mpg",
        ".mpeg",
        ".flv",
        ".vob",
        ".rmvb",
        ".rm",
        ".asf",
        ".3gp",
    };
}
