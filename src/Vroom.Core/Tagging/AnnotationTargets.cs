using System.Text.Json.Nodes;

namespace Vroom.Core.Tagging;

/// <summary>One set of independent subjects, shared by reads, writes and bulk operations.</summary>
public static class AnnotationTargets
{
    private static readonly JsonArray Choices = TagResources.Json("annotation-targets.json").List("targets");

    public static string[] Read(JsonNode definition)
    {
        var targets = definition.List("targets").Select(n => n!.ToString()).ToHashSet(StringComparer.Ordinal);
        return Choices.Where(c => targets.Contains(c.Text("id"))).Select(c => c.Text("id")).ToArray();
    }

    public static bool Supports(JsonNode definition, string subject, string scope) =>
        Choices.Any(c =>
            c.Text("subject") == subject && c.Text("scope") == scope && Read(definition).Contains(c.Text("id"))
        );
}
