using System.Text.Json.Nodes;

namespace Vroom.Core.Tagging;

/// <summary>
/// The value contract is <c>value.schema</c> plus <c>value.cardinality</c>. The schema always describes a
/// single value; cardinality <c>many</c> stores a duplicate-free array of such values. The array form is
/// derived here, so the two fields can never disagree.
/// </summary>
internal static class ValueContracts
{
    public static bool Many(JsonNode? value) => value.Text("cardinality") == "many";

    /// <summary>The value collection an enumerable field references (part of the value contract).</summary>
    public static string Vocabulary(JsonNode? definition) => definition?["value"].Text("vocabulary") ?? "";

    /// <summary>Enumerable fields store stable term references from their contract's collection.</summary>
    public static bool Enumerable(JsonNode? definition) => Vocabulary(definition).Length > 0;

    /// <summary>Schema of one stored value (one member when the field holds several).</summary>
    public static JsonNode Member(JsonNode? value) => value?["schema"] ?? new JsonObject();

    /// <summary>Schema of the complete stored value.</summary>
    public static JsonNode Full(JsonNode? value) =>
        Many(value)
            ? new JsonObject
            {
                ["type"] = "array",
                ["items"] = Member(value).DeepClone(),
                ["uniqueItems"] = true,
            }
            : Member(value).DeepClone();
}
