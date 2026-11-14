using Json.Schema;

namespace Vroom.Core.Tagging;

/// <summary>Offline registry for the public schema graph. References never fetch network resources.</summary>
public static class TagSchemas
{
    private static readonly IReadOnlyDictionary<string, JsonSchema> Schemas = Load();

    // JsonSchema evaluation copies the global registry. Register the offline graph
    // once when this module loads, before any parallel host or test evaluation.
    [System.Runtime.CompilerServices.ModuleInitializer]
    [System.Diagnostics.CodeAnalysis.SuppressMessage(
        "Usage",
        "CA2255",
        Justification = "Publish the immutable public schema graph before concurrent evaluations."
    )]
    public static void InitializeRegistry() => _ = Schemas.Count;

    private static IReadOnlyDictionary<string, JsonSchema> Load()
    {
        var result = TagResources
            .Names.Where(n =>
                n.EndsWith(".schema.json", StringComparison.Ordinal)
                || n.EndsWith("-capabilities.json", StringComparison.Ordinal)
            )
            .ToDictionary(n => n, n => JsonSchema.FromText(TagResources.Read(n)), StringComparer.Ordinal);
        foreach (var schema in result.Values)
            SchemaRegistry.Global.Register(schema);
        return result;
    }

    public static JsonSchema Get(string name) =>
        Schemas.TryGetValue(name, out var schema) ? schema : throw new TagException("SCHEMA_UNAVAILABLE", name);
}
