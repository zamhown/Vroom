using System.Text.Json.Nodes;
using Json.Schema;
using Vroom.Core.Tagging;

namespace Vroom.Tests;

public sealed partial class TaggingTests
{
    private static JsonObject RibbonLayout() =>
        Parse(
            """
            {"surface":"library.actions","root":{"id":"research","type":"ribbon","title":{"en":"Research"},"children":[
              {"id":"sources","type":"ribbon-tab","title":{"en":"Sources"},"children":[
                {"id":"records","type":"ribbon-group","title":{"en":"Records"},"children":[
                  {"id":"find","type":"control","binding":"library.search"},
                  {"id":"retrieve","type":"action-bar","actions":["unfamiliar.retrieve"]}
                ]}
              ]}
            ]}}
            """
        );

    private Task<JsonObject> PreviewRibbon(JsonObject layout) =>
        engine.PreviewConfigAsync(
            new()
            {
                ["changes"] = new JsonArray(
                    new JsonObject
                    {
                        ["kind"] = "ui.actions",
                        ["key"] = "unfamiliar.retrieve",
                        ["value"] = Parse("""{"command":"metadata.enrich","label":{"en":"Retrieve records"}}"""),
                    },
                    new JsonObject
                    {
                        ["kind"] = "ui.layouts",
                        ["key"] = "unfamiliar.research",
                        ["value"] = layout,
                    },
                    new JsonObject
                    {
                        ["kind"] = "ui.surfaceBindings",
                        ["key"] = "library.actions",
                        ["value"] = "unfamiliar.research",
                    }
                ),
            }
        );

    [Fact]
    public async Task RibbonWithUnfamiliarIdsPublishesWithoutChangingFilmAnnotations()
    {
        var before = (await engine.FilmAsync(film.Id))["film"]!["values"]!.ToJsonString();
        var preview = await PreviewRibbon(RibbonLayout());
        Assert.Equal(0, preview["affectedCount"]!.GetValue<long>());
        await engine.ApplyConfigAsync(
            new()
            {
                ["previewToken"] = preview["previewToken"]!.DeepClone(),
                ["expectedGeneration"] = preview["generation"]!.DeepClone(),
            }
        );
        var package = (await engine.SnapshotAsync())["package"]!;
        Assert.Equal("unfamiliar.research", package["ui"]!["surfaceBindings"].Text("library.actions"));
        Assert.Equal("ribbon", package["ui"]!["layouts"]!["unfamiliar.research"]!["root"].Text("type"));
        Assert.Equal(before, (await engine.FilmAsync(film.Id))["film"]!["values"]!.ToJsonString());
    }

    [Theory]
    [InlineData("structure", "SCHEMA_INVALID")]
    [InlineData("binding", "SCHEMA_INVALID")]
    [InlineData("surface", "CONTROL_UNAVAILABLE")]
    [InlineData("orphan", "RIBBON_STRUCTURE_INVALID")]
    [InlineData("condition", "LAYOUT_CONDITION_UNAVAILABLE")]
    public async Task RibbonRejectsInvalidStructureAndUnavailableControlsBeforePublication(string change, string code)
    {
        var layout = RibbonLayout();
        var root = layout["root"]!;
        var group = root["children"]![0]!["children"]![0]!;
        switch (change)
        {
            case "structure":
                root["children"] = new JsonArray(group.DeepClone());
                break;
            case "binding":
                group["children"]![0]!["binding"] = "unregistered.control";
                break;
            case "surface":
                layout["surface"] = "film.details";
                break;
            case "orphan":
                layout["root"] = group.DeepClone();
                break;
            case "condition":
                root["visibleWhen"] = Parse("""{"literal":true}""");
                break;
        }
        var generation = (await engine.SnapshotAsync())["generation"]!.ToJsonString();
        Assert.Equal(code, (await Assert.ThrowsAsync<TagException>(() => PreviewRibbon(layout))).Code);
        Assert.Equal(generation, (await engine.SnapshotAsync())["generation"]!.ToJsonString());
    }

    [Fact]
    public void RibbonEditorUsesTheRegisteredControlContract()
    {
        var schema = JsonSchema.FromText(SchemaKnowledge.Fragment("ui.layouts").ToJsonString());
        var layout = RibbonLayout();
        Assert.True(schema.Evaluate(layout).IsValid);
        layout["root"]!["children"]![0]!["children"]![0]!["children"]![0]!["binding"] = "unknown.control";
        Assert.False(schema.Evaluate(layout).IsValid);
    }
}
