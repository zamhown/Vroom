using System.Text.Json.Nodes;
using Vroom.Core.Storage;
using Vroom.Core.Tagging;

namespace Vroom.Tests;

public sealed partial class TaggingTests
{
    private async Task<JsonObject> FilmValues(string id) => (await engine.FilmAsync(id))["film"]!["values"]!.AsObject();

    [Fact]
    public async Task DefaultsAndDerivedFieldsAreProjectedWithoutWritingAnnotations()
    {
        var flag = Parse(
            """{"key":"user.defaults.flag","revision":1,"enabled":true,"label":{"en":"Flag"},"parents":[],"targets":["film-whole"],"value":{"cardinality":"one","schema":{"type":"boolean"},"semanticVersion":1,"default":{"literal":true}},"input":{"component":"toggle@1"},"placements":[],"query":{"filter":true,"sort":true}}"""
        );
        var size = Parse(
            """{"key":"user.defaults.size","revision":1,"enabled":true,"label":{"en":"Size"},"parents":[],"targets":["film-whole"],"value":{"cardinality":"one","schema":{"type":"integer"},"semanticVersion":1,"default":{"fact":"file.size"}},"writes":{"manual":false},"input":{"component":"number@1"},"placements":[],"query":{"filter":true,"sort":true}}"""
        );
        await Publish(flag);
        await Publish(size);
        await engine.RecordMediaEventAsync("film.discovered", film.Id);
        var heads = () =>
            db.ReadAsync(c =>
                Convert.ToInt64(
                    c.Scalar(
                        "SELECT COUNT(*) FROM tag_heads WHERE subject_id=@id AND tag_key LIKE 'user.defaults.%'",
                        ("@id", film.Id)
                    )
                )
            );
        Assert.Equal(0L, await heads());
        var values = await FilmValues(film.Id);
        Assert.True(values["user.defaults.flag"]!["value"]!.GetValue<bool>());
        Assert.Equal("default", values["user.defaults.flag"]!["origin"].Text("kind"));
        Assert.Equal(film.Size, values["user.defaults.size"]!["value"]!.GetValue<long>());
        Assert.Equal("derived", values["user.defaults.size"]!["origin"].Text("kind"));
        var matched = await engine.QueryIdsAsync(
            Parse("""{"where":{"op":"eq","tag":"user.defaults.flag","value":true},"ignoreDefaultQuery":true}""")
        );
        Assert.Contains(film.Id, matched.List("ids").Select(i => i!.ToString()));

        // An explicit value replaces the default; clearing it brings the default back.
        await Batch(Write("user.defaults.flag", JsonValue.Create(false)));
        Assert.False((await FilmValues(film.Id))["user.defaults.flag"]!["value"]!.GetValue<bool>());
        var clear = Write("user.defaults.flag", null, 1);
        clear["operation"] = "clear";
        await Batch(clear);
        var cleared = (await FilmValues(film.Id))["user.defaults.flag"]!;
        Assert.True(cleared["value"]!.GetValue<bool>());
        Assert.Equal(2, cleared["revision"]!.GetValue<int>());

        // Derived fields follow the facts after media changes, and default edits reproject every film.
        await repo.ImportMediaAsync(film with { Size = film.Size + 10 });
        await engine.RecordMediaEventAsync("film.discovered", film.Id);
        Assert.Equal(film.Size + 10, (await FilmValues(film.Id))["user.defaults.size"]!["value"]!.GetValue<long>());
        flag["value"]!["default"] = new JsonObject { ["literal"] = false };
        flag["revision"] = 2;
        await Publish(flag);
        var other = await repo.ImportMediaAsync(
            new()
            {
                LibraryId = film.LibraryId,
                Path = Path.Combine(directory, "other.mp4"),
                Size = 3,
            }
        );
        await engine.RecordMediaEventAsync("film.discovered", other.Id);
        Assert.False((await FilmValues(other.Id))["user.defaults.flag"]!["value"]!.GetValue<bool>());
    }

    [Fact]
    public async Task DefaultsMustSatisfyTheValueContract()
    {
        var field = Parse(
            """{"key":"user.defaults.bad","revision":1,"enabled":true,"label":{"en":"Bad"},"parents":[],"targets":["film-whole"],"value":{"cardinality":"one","schema":{"type":"integer"},"semanticVersion":1,"default":{"literal":"text"}},"input":{"component":"number@1"},"placements":[],"query":{"filter":true}}"""
        );
        Assert.Equal("RULE_VALUE_MISMATCH", (await Assert.ThrowsAsync<TagException>(() => Publish(field))).Code);
        field["value"]!["default"] = new JsonObject { ["fact"] = "file.path" };
        Assert.Equal("RULE_FACT_TYPE_MISMATCH", (await Assert.ThrowsAsync<TagException>(() => Publish(field))).Code);
    }
}

public sealed partial class TaggingTests
{
    [Fact]
    public async Task AutomaticEnrichmentSkipsSourcesWhoseFieldsAreAlreadyFilled()
    {
        var field = Parse(
            """{"key":"user.enrich.note","revision":1,"enabled":true,"label":{"en":"Note"},"parents":[],"targets":["film-whole"],"value":{"cardinality":"one","schema":{"type":"string"},"semanticVersion":1},"input":{"component":"text@1"},"placements":[],"query":{"filter":true},"enrichment":[{"id":"sidecar-note","source":"user.sidecar","field":"note","apply":"prefer-source"}]}"""
        );
        var preview = await engine.PreviewConfigAsync(
            new()
            {
                ["changes"] = new JsonArray(
                    new JsonObject
                    {
                        ["kind"] = "sources",
                        ["key"] = "user.sidecar",
                        ["value"] = Parse(
                            """{"transport":"sidecar","extension":".nfo","parse":{"format":"xml","fields":{"note":{"selector":"note","label":{"en":"Note"}}}}}"""
                        ),
                    },
                    new JsonObject
                    {
                        ["kind"] = "definition",
                        ["key"] = field.Text("key"),
                        ["value"] = field,
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
        await Batch(Write(field.Text("key"), JsonValue.Create("kept")));
        var sources = new TagSources(engine);
        var automatic = await sources.EnrichSubjectAsync("film", film.Id, automatic: true);
        Assert.Contains(automatic.Sources, s => s.SourceId == "user.sidecar" && s.Status == "up-to-date");
        var explicitRun = await sources.EnrichSubjectAsync("film", film.Id);
        Assert.DoesNotContain(explicitRun.Sources, s => s.Status == "up-to-date");
    }
}
