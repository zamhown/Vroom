using System.Text.Json.Nodes;

namespace Vroom.Core.Tagging;

/// <summary>An authoring document, deliberately distinct from the expanded client snapshot.</summary>
public sealed class DefinitionDocument
{
    internal JsonObject Root { get; }

    private DefinitionDocument(JsonObject root) => Root = root;

    public static DefinitionDocument From(JsonObject document)
    {
        if (document.ContainsKey("terms"))
            throw new TagException("AUTHORING_DOCUMENT_REQUIRED", "/terms");
        return new(document.DeepClone().AsObject());
    }
}

internal sealed record SourceSnapshot(
    CompiledDefinitions Definitions,
    Vroom.Core.Domain.Film? Film,
    JsonObject Subject,
    JsonObject Values,
    long Generation,
    long SubjectRevision,
    JsonObject Facts
)
{
    public JsonObject Package => Definitions.Package;
}
