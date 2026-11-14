using System.Text.Json.Nodes;
using Vroom.Core.Storage;
using Vroom.Core.Tagging;

namespace Vroom.Tests;

public sealed partial class TaggingTests
{
    [Fact]
    public async Task EntityChangesRunSharedExpressionsWithoutApplyingFilmOnlyRules()
    {
        var input = await AddDefinition("user.unfamiliar.measure");
        input["targets"] = new JsonArray("term-whole");
        input["placements"] = new JsonArray();
        await Publish(input);
        var output = input.DeepClone().AsObject();
        output["key"] = "user.unfamiliar.total";
        output["automation"] = JsonNode.Parse(
            """[{"id":"calculate","event":"annotation.changed","executor":"expression@1","args":{"expression":{"op":"add","args":[{"tag":"user.unfamiliar.measure"},{"literal":3}]}},"apply":"replace-same-source"}]"""
        );
        await Publish(output);
        await CreateTerm("user.subject", "core.people");
        await Batch(TermWrite("user.subject", input.Text("key"), JsonValue.Create(9)));
        await engine.ResumeEventsAsync();
        Assert.Equal(
            12,
            (await engine.GetTermAsync("user.subject"))["values"]![output.Text("key")]!["value"]!.GetValue<int>()
        );
        Assert.Null((await engine.FilmAsync(film.Id))["film"]!["values"]![output.Text("key")]);
        await Batch(TermWrite("user.subject", input.Text("key"), JsonValue.Create(20), 1));
        for (var i = 0; i < 3; i++)
            await engine.ResumeEventsAsync();
        Assert.Equal(
            23,
            (await engine.GetTermAsync("user.subject"))["values"]![output.Text("key")]!["value"]!.GetValue<int>()
        );
    }

    [Fact]
    public async Task AnEntityEventThatWouldCreateACycleRollsBackAllItsRuleWrites()
    {
        var relation = RelationField("user.unknown.links", "core.people");
        await Publish(relation);
        await CreateTerm("user.left", "core.people");
        await CreateTerm("user.right", "core.people");
        await Batch(TermWrite("user.left", relation.Text("key"), Refs("user.right")));
        await engine.ResumeEventsAsync();
        var trigger = await AddDefinition("user.unknown.trigger");
        trigger["targets"] = new JsonArray("term-whole");
        trigger["placements"] = new JsonArray();
        await Publish(trigger);
        relation["automation"] = JsonNode.Parse(
            """[{"id":"cycle","event":"annotation.changed","when":{"op":"eq","args":[{"tag":"user.unknown.trigger"},{"literal":1}]},"executor":"value.constant@1","args":{"value":[{"term":"user.left"}]},"apply":"if-unset"}]"""
        );
        await Publish(relation);
        await Batch(TermWrite("user.right", trigger.Text("key"), JsonValue.Create(1)));
        await engine.ResumeEventsAsync();
        Assert.Null((await engine.GetTermAsync("user.right"))["values"]![relation.Text("key")]);
        Assert.Equal(
            1L,
            await db.ReadAsync(c => c.Scalar("SELECT count(*) FROM audit WHERE tool='events.rule-failed'"))
        );
        Assert.Equal(
            1,
            (await engine.GetTermAsync("user.right"))["values"]![trigger.Text("key")]!["value"]!.GetValue<int>()
        );
    }
}
