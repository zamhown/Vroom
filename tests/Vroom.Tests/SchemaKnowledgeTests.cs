using System.Text.Json.Nodes;
using Json.Schema;
using Vroom.Core.Tagging;

namespace Vroom.Tests;

public sealed class SchemaKnowledgeTests
{
    [Theory]
    [InlineData("definition")]
    [InlineData("term")]
    [InlineData("message")]
    [InlineData("i18n")]
    [InlineData("groups")]
    [InlineData("vocabularies")]
    [InlineData("catalogPolicy")]
    [InlineData("ui.layouts")]
    [InlineData("ui.surfaceBindings")]
    [InlineData("ui.actions")]
    [InlineData("ui.identity")]
    [InlineData("ui.naming")]
    [InlineData("ui.agentHints")]
    [InlineData("rules")]
    [InlineData("sources")]
    [InlineData("eventBindings")]
    public void EveryEditorFragmentKeepsItsIdentityAndResolvesAllReferencesOffline(string kind)
    {
        var fragment = SchemaKnowledge.Fragment(kind);
        Assert.Equal("urn:vroom:schema:" + kind + ":3", fragment.Text("$id"));
        Assert.Equal("https://json-schema.org/draft/2020-12/schema", fragment.Text("$schema"));
        Assert.IsType<JsonObject>(fragment["$defs"]);
        void Visit(JsonNode? node)
        {
            if (node is JsonArray array)
                foreach (var item in array)
                    Visit(item);
            else if (node is JsonObject value)
            {
                if (value["$ref"] is { } reference)
                {
                    var path = reference.GetValue<string>();
                    Assert.StartsWith("#/", path);
                    JsonNode? resolved = fragment;
                    foreach (var segment in path[2..].Split('/'))
                        resolved = resolved?[segment.Replace("~1", "/").Replace("~0", "~")];
                    Assert.True(resolved is not null, $"Unresolved reference {path} in {kind}");
                }
                foreach (var property in value)
                    Visit(property.Value);
            }
        }
        Visit(fragment);
    }

    [Fact]
    public void SourceAndRuleEditorsValidateCurrentTransportAndParserConstraints()
    {
        var source = JsonSchema.FromText(SchemaKnowledge.Fragment("sources").ToJsonString());
        var local = JsonNode
            .Parse(
                """{"transport":"sidecar","extension":".review","parse":{"format":"json","fields":{"unfamiliar":{"pointer":"/note","cardinality":"one"}}}}"""
            )!
            .AsObject();
        Assert.True(source.Evaluate(local).IsValid);
        var remote = local.DeepClone().AsObject();
        remote.Remove("extension");
        remote["transport"] = "http";
        Assert.False(source.Evaluate(remote).IsValid);
        remote["request"] = JsonNode.Parse(
            """{"urlTemplate":"https://example.invalid/review/{id}","parameters":{"id":{"literal":"sample"}}}"""
        );
        Assert.True(source.Evaluate(remote).IsValid);
        remote["extension"] = ".review";
        Assert.False(source.Evaluate(remote).IsValid);
        local["parse"]!["format"] = "unsupported";
        Assert.False(source.Evaluate(local).IsValid);

        var rule = JsonSchema.FromText(SchemaKnowledge.Fragment("rules").ToJsonString());
        Assert.True(rule.Evaluate(JsonNode.Parse("""{"patterns":[{"pattern":"(sample)"}]}""")).IsValid);
        Assert.False(rule.Evaluate(JsonNode.Parse("""{"patterns":"not-an-array"}""")).IsValid);
    }

    [Fact]
    public void RebasedReferencesPreserveSiblingValidationKeywordsWithoutMutatingResources()
    {
        var input = JsonNode.Parse(
            """{"$ref":"urn:vroom:schema:capabilities:3#/$defs/source","title":"Review source","required":["enabled"],"properties":{"enabled":{"const":true}},"$defs":{"label":{"$ref":"urn:vroom:schema:tag-definitions:3#/$defs/text","description":"Retain this help"}}}"""
        )!;
        var original = input.ToJsonString();
        var fragment = CapabilityContract.Expand(input)!.AsObject();
        Assert.Equal(original, input.ToJsonString());
        Assert.Equal("#/$defs/cap.source", fragment.Text("$ref"));
        Assert.Equal("Retain this help", fragment["$defs"]!["label"].Text("description"));
        var source = SchemaKnowledge.Fragment("sources");
        foreach (var entry in source.Map("$defs"))
            fragment["$defs"]![entry.Key] = entry.Value!.DeepClone();
        fragment["$schema"] = source["$schema"]!.DeepClone();
        var schema = JsonSchema.FromText(fragment.ToJsonString());
        var value = JsonNode.Parse("""{"transport":"sidecar","parse":{"format":"json","fields":{}}}""")!.AsObject();
        Assert.False(schema.Evaluate(value).IsValid);
        value["enabled"] = true;
        Assert.True(schema.Evaluate(value).IsValid);
        value["enabled"] = false;
        Assert.False(schema.Evaluate(value).IsValid);
    }
}
