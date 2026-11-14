using System.Text.Json.Nodes;
using Vroom.Core.Tagging;

namespace Vroom.Tests;

public sealed partial class TaggingTests
{
    [Fact]
    public async Task RegionOrderIsAUserLayerConfigurationAndPlacementsRejectOrderNumbers()
    {
        var field = await AddDefinition("user.order.field");
        var order = new JsonArray("user.order.field", "core.title");
        var preview = await engine.PreviewConfigAsync(
            new()
            {
                ["changes"] = new JsonArray(
                    new JsonObject
                    {
                        ["kind"] = "ui.placementOrder",
                        ["key"] = "film.details.fields",
                        ["value"] = order.DeepClone(),
                    }
                ),
            }
        );
        await engine.ApplyConfigAsync(
            new()
            {
                ["previewToken"] = preview["previewToken"]!.DeepClone(),
                ["expectedGeneration"] = preview["generation"]!.DeepClone(),
            }
        );
        var published = (await engine.SnapshotAsync())["package"]!["ui"]!["placementOrder"]!["film.details.fields"];
        Assert.True(JsonNode.DeepEquals(order, published));
        var numbered = field.DeepClone().AsObject();
        numbered["placements"]![0]!["order"] = 10;
        Assert.Equal("SCHEMA_INVALID", (await Assert.ThrowsAsync<TagException>(() => Publish(numbered))).Code);
    }
}
