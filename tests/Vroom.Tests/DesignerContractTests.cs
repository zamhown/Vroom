using System.Text.Json.Nodes;
using Vroom.Core.Tagging;

namespace Vroom.Tests;

public sealed partial class TaggingTests
{
    [Fact]
    public void DisplayProfilesHaveLocalizedNamesIndependentOfPlacementIdentity()
    {
        var package = TagResources.Json("core.tagdefs.json");
        foreach (var definition in package["definitions"]!.AsArray().OfType<JsonObject>())
        foreach (var style in definition["display"]?.AsObject() ?? new JsonObject())
            // The default style is named by the host; every additional style carries its own localized name.
            if (style.Key != "default")
                Assert.NotNull(style.Value?["label"]?["zh-CN"]);
        var field = package["definitions"]!
            .AsArray()
            .OfType<JsonObject>()
            .First(d => d["display"]?.AsObject().Count > 0);
        var key = field["display"]!.AsObject().First().Key;
        var positions = field["placements"]!.ToJsonString();
        field["display"]![key]!["label"] = JsonNode.Parse("""{"en":"My style","zh-CN":"自定样式"}""");
        new DefinitionCompiler().Compile(DefinitionDocument.From(package));
        Assert.Equal(positions, field["placements"]!.ToJsonString());
        field["display"]![key]!["label"] = "Unlocalized";
        Assert.Equal(
            "SCHEMA_INVALID",
            Assert.Throws<TagException>(() => new DefinitionCompiler().Compile(DefinitionDocument.From(package))).Code
        );
    }

    [Theory]
    [InlineData("Translate")]
    [InlineData("Heart")]
    [InlineData("HeartFilled")]
    public void IconConfigurationAcceptsRegisteredChoicesAndRejectsUnknownNames(string icon)
    {
        var package = TagResources.Json("core.tagdefs.json");
        var field = package["definitions"]!
            .AsArray()
            .OfType<JsonObject>()
            .First(d => d["display"]?["overlay"]?["component"]?.GetValue<string>() == "icon-toggle@1");
        field["display"]!["overlay"]!["props"]!["trueIcon"] = icon;
        field["display"]!["overlay"]!["props"]!["falseIcon"] = icon;
        new DefinitionCompiler().Compile(DefinitionDocument.From(package));
        field["display"]!["overlay"]!["props"]!["trueIcon"] = "UnknownIcon";
        Assert.Equal(
            "SCHEMA_INVALID",
            Assert.Throws<TagException>(() => new DefinitionCompiler().Compile(DefinitionDocument.From(package))).Code
        );
    }

    [Fact]
    public async Task InputRequirementsUseTheSamePublicValueContract()
    {
        var field = await AddDefinition();
        field["value"]!["schema"] = new JsonObject
        {
            ["type"] = "integer",
            ["minimum"] = 1,
            ["maximum"] = 10,
        };
        field["input"] = new JsonObject { ["component"] = "rating@1" };
        await Publish(field);
        await Batch(Write(field.Text("key"), JsonValue.Create(7)));
        field["input"] = new JsonObject { ["component"] = "number@1" };
        await Publish(field);
        Assert.Equal(7, (await engine.FilmAsync(film.Id))["film"]!["values"]![field.Text("key")]!.Number("value"));
        field["input"] = new JsonObject { ["component"] = "date@1" };
        Assert.Equal("SCHEMA_INVALID", (await Assert.ThrowsAsync<TagException>(() => Publish(field))).Code);
        field["input"] = new JsonObject { ["component"] = "rating@1" };
        field["value"]!["schema"]!["maximum"] = 1000;
        Assert.Equal("SCHEMA_INVALID", (await Assert.ThrowsAsync<TagException>(() => Publish(field))).Code);
    }

    [Fact]
    public async Task RuleConditionsAndExtractionSettingsAreValidatedBeforePublication()
    {
        var field = await AddDefinition();
        field["initialization"] = JsonNode.Parse(
            """[{"id":"calculated","event":"film.discovered","executor":"expression@1","args":{"expression":{"op":"add","args":[{"literal":2},{"literal":3}]}},"apply":"if-unset","when":{"op":"exists","args":[{"tag":"unknown.field"}]}}]"""
        );
        Assert.Equal(
            "EXPRESSION_FIELD_UNAVAILABLE",
            (await Assert.ThrowsAsync<TagException>(() => Publish(field))).Code
        );
        field["initialization"]![0]!["when"] = new JsonObject { ["literal"] = true };
        await Publish(field);
        await engine.RecordMediaEventAsync("film.discovered", film.Id);
        Assert.Equal(5, (await engine.FilmAsync(film.Id))["film"]!["values"]![field.Text("key")]!.Number("value"));
        var package = TagResources.Json("core.tagdefs.json");
        package["rules"]!.AsObject()["example.rule"] = JsonNode.Parse(
            """{"patterns":[{"pattern":"(x)","groups":{"1":{"padLeft":100}}}]}"""
        );
        Assert.Equal(
            "SCHEMA_INVALID",
            Assert.Throws<TagException>(() => new DefinitionCompiler().Compile(DefinitionDocument.From(package))).Code
        );
    }
}
