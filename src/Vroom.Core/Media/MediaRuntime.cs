using Vroom.Core.Domain;

namespace Vroom.Core.Media;

[System.Text.Json.Serialization.JsonConverter(typeof(ToolSourceConverter))]
public enum ToolSource
{
    Custom,
    Bundled,
    SystemPath,
    Missing,
}

public sealed class ToolSourceConverter()
    : System.Text.Json.Serialization.JsonStringEnumConverter<ToolSource>(System.Text.Json.JsonNamingPolicy.CamelCase);

public sealed record ResolvedTool(string Path, ToolSource Source);

public sealed record RuntimeTools(
    ResolvedTool Ffmpeg,
    ResolvedTool Ffprobe,
    ResolvedTool HandBrake,
    ResolvedTool Mpv,
    ResolvedTool Model
);

/// <summary>
/// Resolves external tools at use time: an explicit, existing setting wins; otherwise the runtime
/// directory shipped next to the app; otherwise the command name for the system PATH. Nothing is
/// written back to settings, so a moved or upgraded installation never keeps stale absolute paths.
/// A configured path that no longer exists falls back to the bundled runtime and is reported as such.
/// </summary>
public static class MediaRuntime
{
    public const string ModelFile = "qwen2.5-0.5b-instruct-q4_k_m.gguf";

    public static string Directory { get; set; } =
        Environment.GetEnvironmentVariable("VROOM_RUNTIME") ?? Path.Combine(AppContext.BaseDirectory, "runtime");

    private static string Executable(string name) => OperatingSystem.IsWindows() ? name + ".exe" : name;

    public static RuntimeTools Resolve(AppSettings settings) =>
        new(
            Tool(settings.FfmpegPath, Path.Combine("ffmpeg", Executable("ffmpeg")), "ffmpeg"),
            Tool(settings.FfprobePath, Path.Combine("ffmpeg", Executable("ffprobe")), "ffprobe"),
            Tool(settings.HandBrakePath, Path.Combine("handbrake", Executable("HandBrakeCLI")), "HandBrakeCLI"),
            Tool(settings.MpvPath, Path.Combine("mpv", Executable("mpv")), null),
            Tool(settings.ModelPath, Path.Combine("models", ModelFile), null)
        );

    public static string Ffmpeg(AppSettings settings) => Resolve(settings).Ffmpeg.Path;

    public static string Ffprobe(AppSettings settings) => Resolve(settings).Ffprobe.Path;

    private static ResolvedTool Tool(string configured, string bundled, string? command)
    {
        if (configured.Length > 0 && (!Path.IsPathFullyQualified(configured) || File.Exists(configured)))
            return new(configured, ToolSource.Custom);
        var local = Path.Combine(Directory, bundled);
        if (File.Exists(local))
            return new(Path.GetFullPath(local), ToolSource.Bundled);
        return command is null ? new("", ToolSource.Missing) : new(command, ToolSource.SystemPath);
    }
}
