using System.Text.Json.Nodes;
using Vroom.Core.Tagging;

namespace Vroom.Tests;

public sealed partial class TaggingTests
{
    [Fact]
    public async Task IndependentTargetsDoNotAccidentallyEnableWholeFilmWritesOrBulk()
    {
        var d = await AddDefinition("user.independent");
        d.Remove("temporal");
        d["targets"] = new JsonArray("term-whole", "film-point");
        await Publish(d);
        await CreateTerm("user.target.entity", "core.people");
        await Batch(TermWrite("user.target.entity", d.Text("key"), JsonValue.Create(23)));
        var point = Write(d.Text("key"), JsonValue.Create(41));
        point["scope"] = Parse("""{"kind":"point","scopeId":"fixture-point","startUs":"1000"}""");
        await Batch(point);
        Assert.Equal(
            "SCOPE_UNSUPPORTED",
            (await Assert.ThrowsAsync<TagException>(() => Batch(Write(d.Text("key"), JsonValue.Create(1))))).Code
        );
        var interval = Write(d.Text("key"), JsonValue.Create(1));
        interval["scope"] = Parse(
            """{"kind":"interval","scopeId":"fixture-interval","startUs":"1000","endUs":"2000"}"""
        );
        Assert.Equal("SCOPE_UNSUPPORTED", (await Assert.ThrowsAsync<TagException>(() => Batch(interval))).Code);
        var bulk = Parse(
            """{"subjectKind":"film","subjectIds":[],"changes":[{"tagKey":"user.independent","operation":"set","value":2}]}"""
        );
        bulk["subjectIds"] = new JsonArray(film.Id);
        Assert.Equal(
            "SCOPE_UNSUPPORTED",
            (await Assert.ThrowsAsync<TagException>(() => engine.PreviewBulkAsync(bulk))).Code
        );
        Assert.Equal(23, (await engine.GetTermAsync("user.target.entity"))["values"]![d.Text("key")]!.Number("value"));
    }

    [Fact]
    public async Task EquivalentTargetEditsKeepExistingAnnotationsEffective()
    {
        var d = await AddDefinition("user.scope");
        await Batch(Write(d.Text("key"), JsonValue.Create(33)));
        var before = (await engine.ExportAsync("annotations", true))
            .List("records")
            .Single(r => r.Text("tagKey") == d.Text("key"))!
            .ToJsonString();
        d["targets"] = new JsonArray(AnnotationTargets.Read(d).Select(x => (JsonNode?)JsonValue.Create(x)).ToArray());
        d.Remove("temporal");
        await Publish(d);
        Assert.Equal(33, (await engine.FilmAsync(film.Id))["film"]!["values"]![d.Text("key")]!.Number("value"));
        Assert.Equal(
            before,
            (await engine.ExportAsync("annotations", true))
                .List("records")
                .Single(r => r.Text("tagKey") == d.Text("key"))!
                .ToJsonString()
        );
        d["temporal"] = new JsonArray("whole");
        Assert.Equal("SCHEMA_INVALID", (await Assert.ThrowsAsync<TagException>(() => Publish(d))).Code);
    }
}
