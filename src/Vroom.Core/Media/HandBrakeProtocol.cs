using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Vroom.Core.Application;
using Vroom.Core.Domain;

namespace Vroom.Core.Media;

public sealed record HandBrakeOption(
    string Key,
    string Group,
    string Arity,
    string ValueType,
    string[] Choices,
    JsonObject Label,
    JsonObject Help
);

public sealed record HandBrakePreset(string Name, string Category, string? Json = null);

public sealed record HandBrakeCapabilities(
    string Executable,
    string Version,
    string Fingerprint,
    IReadOnlyList<HandBrakeOption> Options,
    IReadOnlyList<HandBrakePreset> Presets
);

public static class HandBrakeProtocol
{
    // These switches control process I/O, discovery, or writes outside the reviewed destination.
    private static readonly HashSet<string> Managed = new(StringComparer.Ordinal)
    {
        "help",
        "version",
        "json",
        "input",
        "output",
        "preset",
        "preset-list",
        "preset-import-file",
        "preset-import-gui",
        "preset-export",
        "preset-export-file",
        "preset-export-description",
        "queue-import-file",
        "scan",
        "encoder-preset-list",
        "encoder-tune-list",
        "encoder-profile-list",
        "encoder-level-list",
    };

    public static JsonObject Text(string value) => new() { ["en"] = value };

    public static IReadOnlyList<HandBrakeOption> ParseHelp(string help)
    {
        var result = new List<HandBrakeOption>();
        string group = "General";
        string[] keys = [];
        string arity = "none",
            valueType = "string";
        var lines = new List<string>();
        void Flush()
        {
            if (keys.Length == 0)
                return;
            var description = string.Join('\n', lines).Trim();
            var choices = lines
                .Where(l => Regex.IsMatch(l, @"^\s{27,}[A-Za-z0-9_:.-]+\s*$"))
                .Select(l => l.Trim())
                .Distinct()
                .ToArray();
            foreach (var key in keys.Where(k => !Managed.Contains(k)))
                result.Add(new(key, group, arity, valueType, choices, Text(key), Text(description)));
            lines.Clear();
            keys = [];
        }
        foreach (var line in help.Replace("\r", "").Split('\n'))
        {
            var heading = Regex.Match(line, @"^([A-Za-z ]+) Options -+");
            if (heading.Success)
            {
                Flush();
                group = heading.Groups[1].Value;
                continue;
            }
            if (Regex.IsMatch(line, @"^\s+(?:-[A-Za-z0-9],\s*)?--[\w-]+"))
            {
                Flush();
                var declaration = Regex.Match(
                    line,
                    @"^\s+(?:-[A-Za-z0-9],\s*)?(?<flags>--[\w-]+(?:,\s*--[\w-]+)*)(?<arg>\[[^\]]*\]|\s*<[^>]+>)?(?<help>.*)$"
                );
                if (!declaration.Success)
                    continue;
                keys = Regex
                    .Matches(declaration.Groups["flags"].Value, @"--([\w-]+)")
                    .Select(m => m.Groups[1].Value)
                    .ToArray();
                var argument = declaration.Groups["arg"].Value.Trim();
                arity =
                    argument.StartsWith('[') ? "optional"
                    : argument.StartsWith('<') ? "required"
                    : "none";
                valueType = argument is "<number>" or "<float>" ? "number" : "string";
                // Upstream's help omits argument markers for these getopt-required arguments.
                if (
                    keys.Any(k =>
                        k
                            is "min-duration"
                                or "max-duration"
                                or "arate"
                                or "normalize-mix"
                                or "automatic-naming-behaviour"
                    )
                )
                    arity = "required";
                lines.Add(declaration.Groups["help"].Value.Trim());
            }
            else if (keys.Length > 0)
                lines.Add(line);
        }
        Flush();
        return result;
    }

    public static string[] Arguments(
        IReadOnlyDictionary<string, string?> values,
        IReadOnlyList<HandBrakeOption> options
    )
    {
        if (values.Count > 256)
            throw new ArgumentException("host.HandBrakeProtocol.tooManyEncodingOptions");
        var arguments = new List<string>();
        var map = options.ToDictionary(o => o.Key);
        foreach (var (key, value) in values)
        {
            if (Managed.Contains(key) || !map.TryGetValue(key, out var option))
                throw new ArgumentException("host.export.optionUnavailable").Localize(
                    "host.export.optionUnavailable",
                    key
                );
            if (value?.Length > 8192 || value?.Any(c => c is '\0' or '\r' or '\n') == true)
                throw new ArgumentException("host.export.encodingValueInvalid").Localize(
                    "host.export.encodingValueInvalid",
                    key
                );
            if (option.Arity == "required" && string.IsNullOrWhiteSpace(value))
                throw new ArgumentException("host.export.valueRequired").Localize("host.export.valueRequired", key);
            if (option.Arity == "none" && !string.IsNullOrEmpty(value))
                throw new ArgumentException("host.export.optionWithoutValue").Localize(
                    "host.export.optionWithoutValue",
                    key
                );
            if (
                option.ValueType == "number"
                && value is { Length: > 0 }
                && (
                    !double.TryParse(value, System.Globalization.CultureInfo.InvariantCulture, out var number)
                    || !double.IsFinite(number)
                )
            )
                throw new ArgumentException("host.export.numberInvalid").Localize("host.export.numberInvalid", key);
            if (key == "title" && (!int.TryParse(value, out var title) || title < 1))
                throw new ArgumentException("host.HandBrakeProtocol.encodingRequiresAPositiveTitleNumber");
            // One argv element per option prevents values from becoming switches or shell commands.
            arguments.Add("--" + key + (value is { Length: > 0 } ? "=" + value : ""));
        }
        foreach (
            var group in new[]
            {
                new[] { "vfr", "cfr", "pfr" },
                new[] { "quality", "vb" },
                new[] { "all-audio", "first-audio", "audio" },
                new[] { "all-subtitles", "first-subtitle", "subtitle" },
            }
        )
            if (group.Count(values.ContainsKey) > 1)
                throw new ArgumentException("host.export.optionsConflict").Localize(
                    "host.export.optionsConflict",
                    string.Join(", ", group)
                );
        foreach (var key in values.Keys)
            if (!key.StartsWith("no-", StringComparison.Ordinal) && values.ContainsKey("no-" + key))
                throw new ArgumentException("host.export.optionsConflict").Localize("host.export.optionsConflict", key);
        return arguments.ToArray();
    }

    public static (int Progress, JobTelemetry Telemetry)? Progress(JsonObject state)
    {
        var phase = state["State"]?.GetValue<string>() ?? "";
        var working =
            state["Working"] as JsonObject ?? state["Searching"] as JsonObject ?? state["Scanning"] as JsonObject;
        if (working is null)
            return null;
        double? N(string key) =>
            working[key] is JsonValue value && value.TryGetValue<double>(out var n) && double.IsFinite(n) ? n : null;
        var pass = (int?)N("Pass");
        var count = (int?)N("PassCount");
        var progress = N("Progress") ?? 0;
        if (count > 0 && pass > 0)
            progress = (pass.Value - 1 + progress) / count.Value;
        return (
            (int)(Math.Clamp(progress, 0, 1) * 10000),
            new(phase, N("Rate"), N("RateAvg"), N("ETASeconds") is >= 0 ? N("ETASeconds") : null, pass, count)
        );
    }
}

/// <summary>Parses balanced JSON objects embedded in HandBrake's line-oriented output.</summary>
public sealed class HandBrakeJsonReader
{
    private readonly StringBuilder buffer = new();
    private bool quoted,
        escaped;
    private int depth;

    public IEnumerable<JsonObject> Feed(string text)
    {
        var result = new List<JsonObject>();
        foreach (var c in text)
        {
            if (depth == 0)
            {
                if (c != '{')
                    continue;
                buffer.Clear();
                quoted = escaped = false;
                depth = 1;
                buffer.Append(c);
                continue;
            }
            buffer.Append(c);
            if (buffer.Length > 16_000_000)
                throw new IOException("host.HandBrakeProtocol.handbrakeJsonResponseExceedsTheLimit");
            if (escaped)
            {
                escaped = false;
                continue;
            }
            if (quoted && c == '\\')
            {
                escaped = true;
                continue;
            }
            if (c == '"')
            {
                quoted = !quoted;
                continue;
            }
            if (!quoted)
            {
                if (c == '{')
                    depth++;
                if (c == '}')
                    depth--;
            }
            if (depth == 0)
            {
                try
                {
                    if (JsonNode.Parse(buffer.ToString()) is JsonObject obj)
                        result.Add(obj);
                }
                catch (System.Text.Json.JsonException) { }
            }
        }
        return result;
    }
}
