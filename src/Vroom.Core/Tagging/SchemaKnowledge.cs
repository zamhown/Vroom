using System.Text.Json.Nodes;

namespace Vroom.Core.Tagging;

public static class SchemaKnowledge
{
    public static JsonObject Fragment(string kind)
    {
        if (kind == "query")
            return TagResources.Json("query.schema.json");
        var package = TagResources.Json("tag-definitions.schema.json");
        var property = kind.StartsWith("ui.", StringComparison.Ordinal)
            ? package["properties"]?["ui"]?["properties"]?[kind[3..]]
            : package["properties"]?[kind];
        JsonNode? shape = kind switch
        {
            "definition" => package["$defs"]!["definition"].Copy(),
            "term" => package["$defs"]!["term"].Copy(),
            "message" => new JsonObject { ["$ref"] = "#/$defs/text" },
            "i18n" => property?["properties"]?["defaultLocale"].Copy(),
            "catalogPolicy" => property.Copy(),
            "ui.surfaceBindings" => new JsonObject { ["type"] = "string" },
            _ => property?["additionalProperties"] is JsonObject p
                ? p.DeepClone()
                : new JsonObject { ["type"] = "object" },
        };
        if (shape is not JsonObject result)
            throw new TagException("SCHEMA_FRAGMENT_UNAVAILABLE");
        result["$schema"] = "https://json-schema.org/draft/2020-12/schema";
        result["$id"] = "urn:vroom:schema:" + kind + ":3";
        result["$defs"] = package["$defs"].Copy();
        result = CapabilityContract.Expand(result)!.AsObject();
        foreach (var entry in CapabilityContract.Registry.Map("$defs"))
            result["$defs"]!["cap." + entry.Key] = CapabilityContract.Expand(entry.Value, true);
        return result;
    }
}
