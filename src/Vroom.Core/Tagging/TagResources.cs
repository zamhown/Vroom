using System.Reflection;
using System.Text.Json.Nodes;

namespace Vroom.Core.Tagging;

public static class TagResources
{
    private const string Prefix = "Vroom.Tagging.";
    private static readonly Assembly Assembly = typeof(TagResources).Assembly;
    public static IReadOnlyList<string> Names =>
        Assembly
            .GetManifestResourceNames()
            .Where(n => n.StartsWith(Prefix, StringComparison.Ordinal))
            .Select(n => n[Prefix.Length..])
            .Order()
            .ToArray();
    private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, string> Texts = new(
        StringComparer.Ordinal
    );
    private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, JsonObject> Jsons = new(
        StringComparer.Ordinal
    );

    public static string Read(string name) => Texts.GetOrAdd(name, ReadCore);

    private static string ReadCore(string name)
    {
        if (!Names.Contains(name, StringComparer.Ordinal))
            throw new TagException("KNOWLEDGE_NOT_FOUND");
        using var stream = Assembly.GetManifestResourceStream(Prefix + name)!;
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }

    public static JsonObject Json(string name) =>
        Jsons.GetOrAdd(name, n => JsonNode.Parse(Read(n))!.AsObject()).DeepClone().AsObject();

    public static object Slice(string name, int offset = 0, int limit = 12000)
    {
        var text = Read(name);
        offset = Math.Clamp(offset, 0, text.Length);
        limit = Math.Clamp(limit, 1, 24000);
        var end = Math.Min(text.Length, offset + limit);
        return new
        {
            resource = name,
            offset,
            total = text.Length,
            nextOffset = end < text.Length ? (int?)end : null,
            text = text[offset..end],
        };
    }
}
