using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Vroom.Core.Tagging;

public static class TagJson
{
    public static readonly JsonSerializerOptions Options = Vroom.Core.Domain.CanonicalJson.Options;

    public static string Text(this JsonNode? node, string key, string fallback = "") =>
        node?[key]?.GetValue<string>() ?? fallback;

    public static bool Flag(this JsonNode? node, string key, bool fallback = false) =>
        node?[key]?.GetValue<bool>() ?? fallback;

    public static double Number(this JsonNode? node, string key, double fallback = 0) =>
        node?[key] is { } value ? JsonSerializer.Deserialize<double>(value.ToJsonString()) : fallback;

    public static JsonArray List(this JsonNode? node, string key) => node?[key] as JsonArray ?? [];

    public static JsonObject Map(this JsonNode? node, string key) => node?[key] as JsonObject ?? [];

    public static JsonNode? Copy(this JsonNode? node) => node?.DeepClone();

    public static JsonObject Object(object value) => JsonSerializer.SerializeToNode(value, Options)!.AsObject();

    public static JsonNode? Get(JsonNode? node, string path)
    {
        foreach (var part in path.Split('.'))
        {
            if (node is not JsonObject obj)
                return null;
            node = obj[part];
        }
        return node;
    }

    public static string Canonical(JsonNode? node) => Vroom.Core.Domain.CanonicalJson.Write(node);

    public static string Hash(JsonNode? node) => Vroom.Core.Domain.CanonicalJson.Hash(node);

    /// <summary>Localized text is a locale-to-text map; a "message" member makes it a shared-message reference.</summary>
    public static JsonObject Localized(string value, string locale = "und") => new() { [locale] = value };

    public static bool IsMessageReference(JsonNode? text) => text is JsonObject o && o["message"] is JsonValue;

    /// <summary>Requested locale, then its language, then the package default locale, then the first entry.</summary>
    public static string Label(JsonNode? text, string? locale = null, JsonNode? package = null)
    {
        var fallback = package?["i18n"].Text("defaultLocale") ?? "";
        var values = IsMessageReference(text)
            ? package?["i18n"]?["messages"]?[text.Text("message")]?["values"] as JsonObject
            : text as JsonObject;
        if (values is null || values.Count == 0)
            return "";
        locale ??= fallback;
        if (locale.Length > 0 && values[locale] is JsonValue exact)
            return exact.ToString();
        if (locale.Length > 0 && values[locale.Split('-')[0]] is JsonValue parent)
            return parent.ToString();
        if (fallback.Length > 0 && values[fallback] is JsonValue preferred)
            return preferred.ToString();
        return values.Select(p => p.Value).OfType<JsonValue>().FirstOrDefault()?.ToString() ?? "";
    }
}

public sealed class TagException(string code, string path = "", string detail = "")
    : Exception(detail.Length > 0 ? detail : code)
{
    public string Code { get; } = code;
    public string Pointer { get; } = path;
}

public sealed record TagDiagnostic(string Code, string Path, string Detail, string Severity = "error");
