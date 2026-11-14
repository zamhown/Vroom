using System.Text.Json.Nodes;
using Vroom.Core.Tagging;

namespace Vroom.Tests;

public sealed partial class TaggingTests
{
    [Fact]
    public async Task FacetGroupingIsOneCapabilityThatCoversEveryDeclaredBandSet()
    {
        var field = Parse(
            """{"key":"user.facet.level","revision":1,"enabled":true,"label":{"en":"Level"},"parents":[],"targets":["film-whole"],"value":{"cardinality":"one","schema":{"type":"integer","minimum":0,"maximum":9},"semanticVersion":1},"facets":{"tiers":{"kind":"numeric-bands","label":{"en":"Tiers"},"bands":[{"id":"low","label":{"en":"Low"},"gte":0,"lte":4},{"id":"high","label":{"en":"High"},"gte":5,"lte":9}]}},"input":{"component":"slider@1","props":{"min":0,"max":9}},"placements":[],"query":{"filter":true,"sort":true,"groupBy":["value","facet"]}}"""
        );
        await Publish(field);
        await Batch(Write(field.Text("key"), JsonValue.Create(7)));
        var result = await engine.QueryAsync(
            Parse("""{"groupBy":[{"tag":"user.facet.level","mode":"facet","facet":"tiers"}]}""")
        );
        Assert.Contains("high", result["groups"]!.ToJsonString());
        await Assert.ThrowsAsync<TagException>(() =>
            engine.QueryAsync(Parse("""{"groupBy":[{"tag":"user.facet.level","mode":"facet","facet":"unknown"}]}"""))
        );
        var invalid = Parse(field.ToJsonString());
        invalid["key"] = "user.facet.plain";
        invalid.Remove("facets");
        await Assert.ThrowsAsync<TagException>(() => Publish(invalid));
    }
}

public sealed partial class TaggingTests
{
    [Fact]
    public async Task RuleIdsMustBeMeaningfulAndUniqueAndWritePoliciesConsistent()
    {
        var field = Parse(
            """{"key":"user.rules.flag","revision":1,"enabled":true,"label":{"en":"Flag"},"parents":[],"targets":["film-whole"],"value":{"cardinality":"one","schema":{"type":"boolean"},"semanticVersion":1},"input":{"component":"toggle@1"},"placements":[],"query":{"filter":true},"initialization":[{"id":"0","event":"film.discovered","executor":"value.constant@1","apply":"if-unset","args":{"value":false}}]}"""
        );
        Assert.Equal("RULE_ID_INVALID", (await Assert.ThrowsAsync<TagException>(() => Publish(field))).Code);
        field["initialization"]![0]!["id"] = "initial";
        field["initialization"]!.AsArray().Add(field["initialization"]![0]!.DeepClone());
        Assert.Equal("DUPLICATE_KEY", (await Assert.ThrowsAsync<TagException>(() => Publish(field))).Code);
        field["initialization"]!.AsArray().RemoveAt(1);
        field["writes"] = new JsonObject { ["manual"] = false, ["manualClearBlocksAutomatic"] = true };
        Assert.Equal("WRITE_POLICY_INVALID", (await Assert.ThrowsAsync<TagException>(() => Publish(field))).Code);
        field.Remove("writes");
        await Publish(field);
    }
}

public sealed partial class TaggingTests
{
    [Fact]
    public async Task PublicationRejectsUnregisteredIcons()
    {
        var field = Parse(
            """{"key":"user.icons.flag","revision":1,"enabled":true,"label":{"en":"Flag"},"parents":[],"targets":["film-whole"],"value":{"cardinality":"one","schema":{"type":"boolean"},"semanticVersion":1},"input":{"component":"toggle@1"},"placements":[],"query":{"filter":true},"icon":"NoSuchIcon"}"""
        );
        var error = await Assert.ThrowsAsync<TagException>(() => Publish(field));
        Assert.True(error.Code is "ICON_UNAVAILABLE" or "SCHEMA_INVALID", error.Code);
    }
}

public sealed partial class TaggingTests
{
    [Fact]
    public async Task GroupedQueriesReturnFilmsOrderedByGroupWithTheirGroupKey()
    {
        var field = Parse(
            """{"key":"user.group.shelf","revision":1,"enabled":true,"label":{"en":"Shelf"},"parents":[],"targets":["film-whole"],"value":{"cardinality":"one","schema":{"type":"string"},"semanticVersion":1},"input":{"component":"text@1"},"placements":[],"query":{"filter":true,"sort":true,"groupBy":["value"]}}"""
        );
        await Publish(field);
        await Batch(Write(field.Text("key"), JsonValue.Create("b")));
        var other = await repo.ImportMediaAsync(
            new()
            {
                LibraryId = film.LibraryId,
                Path = Path.Combine(directory, "grouped.mp4"),
                Size = 2,
            }
        );
        var write = Write(field.Text("key"), JsonValue.Create("a"));
        write["subject"]!["id"] = other.Id;
        await Batch(write);
        var result = await engine.QueryAsync(
            Parse("""{"groupBy":[{"tag":"user.group.shelf","mode":"value"}],"ignoreDefaultQuery":true}""")
        );
        var keys = result.List("films").Select(f => f.Text("groupKey")).ToArray();
        Assert.Equal(keys.Order(StringComparer.Ordinal).ToArray(), keys);
        Assert.Contains("[\"a\"]", keys);
        Assert.Equal(other.Id, result.List("films")[0].Text("id"));
        // Queues and bulk work use the same order as the sectioned list.
        var ids = await engine.QueryIdsAsync(
            Parse("""{"groupBy":[{"tag":"user.group.shelf","mode":"value"}],"ignoreDefaultQuery":true}""")
        );
        Assert.Equal(result.List("films").Select(f => f.Text("id")), ids.List("ids").Select(i => i!.ToString()));
    }
}
