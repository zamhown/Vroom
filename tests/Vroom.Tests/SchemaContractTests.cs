using System.Text.Json.Nodes;
using Vroom.Core.Tagging;

namespace Vroom.Tests;

public sealed partial class TaggingTests
{
    [Fact]
    public async Task CapabilitiesRejectInvalidParametersAndValueContractsBeforePublication()
    {
        var d = await AddDefinition();
        var generation = (await Generation()).GetValue<long>();
        d["input"]!["props"]!["inventedParameter"] = true;
        Assert.Equal("SCHEMA_INVALID", (await Assert.ThrowsAsync<TagException>(() => Publish(d))).Code);
        d["input"] = new JsonObject { ["component"] = "toggle@1" };
        Assert.Equal("COMPONENT_VALUE_MISMATCH", (await Assert.ThrowsAsync<TagException>(() => Publish(d))).Code);
        d["input"] = new JsonObject { ["component"] = "number@1" };
        d["initialization"] = new JsonArray(
            new JsonObject
            {
                ["id"] = "bad-fact",
                ["event"] = "film.discovered",
                ["executor"] = "fact.copy@1",
                ["args"] = new JsonObject { ["path"] = "file.path" },
                ["apply"] = "if-unset",
            }
        );
        Assert.Equal("RULE_FACT_TYPE_MISMATCH", (await Assert.ThrowsAsync<TagException>(() => Publish(d))).Code);
        var package = TagResources.Json("core.tagdefs.json");
        package["package"]!["requires"]!["features"]!.AsArray().Add("unsupported@9");
        Assert.Equal(
            "CAPABILITY_UNSUPPORTED",
            Assert.Throws<TagException>(() => new DefinitionCompiler().Compile(DefinitionDocument.From(package))).Code
        );
        var client = (await engine.SnapshotAsync())["package"]!.AsObject();
        Assert.Equal(
            "AUTHORING_DOCUMENT_REQUIRED",
            Assert.Throws<TagException>(() => DefinitionDocument.From(client)).Code
        );
        Assert.Equal(generation, (await Generation()).GetValue<long>());
    }

    [Fact]
    public async Task CleanDefaultsHaveRealDatesAndNoRedundantAgeOrSourceField()
    {
        var definitions = TagResources.Json("core.tagdefs.json").List("definitions");
        Assert.DoesNotContain(definitions, d => d.Text("key") is "core.person.age" or "core.source");
        Assert.All(definitions, d => Assert.False(string.IsNullOrWhiteSpace(d?["description"]?.Text("zh-CN"))));
        await CreateTerm("person", "core.people");
        Assert.Equal(
            "VALUE_OUT_OF_DOMAIN",
            (
                await Assert.ThrowsAsync<TagException>(() =>
                    Batch(TermWrite("person", "core.person.birthdate", JsonValue.Create("2001-02-29")))
                )
            ).Code
        );
        await Batch(TermWrite("person", "core.person.birthdate", JsonValue.Create("2000-02-29")));
        Assert.Equal(
            "2000-02-29",
            (await engine.GetTermAsync("person"))["values"]!["core.person.birthdate"]!.Text("value")
        );
        Assert.Null((await engine.FilmAsync(film.Id))["film"]!["values"]!["core.rating"]);
    }

    [Fact]
    public async Task ScopedPredicatesUseOneScopeAndHalfOpenRanges()
    {
        var field = await AddDefinition();
        var key = field.Text("key");
        JsonObject At(string id, string kind, string start, string? end, int value)
        {
            var w = Write(key, JsonValue.Create(value));
            w["scope"] = new JsonObject
            {
                ["kind"] = kind,
                ["scopeId"] = id,
                ["startUs"] = start,
            };
            if (end is not null)
                w["scope"]!["endUs"] = end;
            return w;
        }
        await Batch(At("a", "point", "1000000", null, 20), At("b", "interval", "2000000", "4000000", 80));
        JsonObject Query(string quantifier, string start, string end, int minimum) =>
            new()
            {
                ["where"] = new JsonObject
                {
                    ["op"] = "scoped",
                    ["scope"] = new JsonObject
                    {
                        ["kind"] = "any",
                        ["startUs"] = start,
                        ["endUs"] = end,
                    },
                    ["quantifier"] = quantifier,
                    ["where"] = new JsonObject
                    {
                        ["op"] = "gte",
                        ["tag"] = key,
                        ["value"] = minimum,
                    },
                },
            };
        Assert.Equal(1, (await engine.QueryAsync(Query("any", "0", "3000000", 70))).Number("total"));
        Assert.Equal(0, (await engine.QueryAsync(Query("all", "0", "3000000", 70))).Number("total"));
        Assert.Equal(1, (await engine.QueryAsync(Query("none", "4000000", "5000000", 1))).Number("total"));
        Assert.Equal(0, (await engine.QueryAsync(Query("all", "4000000", "5000000", 1))).Number("total"));
        var query = Query("any", "0", "3000000", 70);
        await engine.SaveViewAsync(
            new()
            {
                ["id"] = "scoped",
                ["name"] = "Scoped",
                ["query"] = query.DeepClone(),
            }
        );
        var view = (await repo.ViewsAsync()).Single();
        Assert.True(JsonNode.DeepEquals(view.Query.Where, query["where"]));
        var bulk = await engine.PreviewBulkAsync(
            new()
            {
                ["query"] = query,
                ["changes"] = new JsonArray(
                    new JsonObject
                    {
                        ["tagKey"] = key,
                        ["operation"] = "set",
                        ["value"] = 12,
                    }
                ),
            }
        );
        Assert.Equal(1, bulk.Number("count"));
        Assert.Equal(
            "QUERY_SCHEMA_INVALID",
            (
                await Assert.ThrowsAsync<TagException>(() =>
                    engine.QueryAsync(Parse("""{"where":{"op":"gte","tag":"x"}}"""))
                )
            ).Code
        );
        Assert.Equal(
            "QUERY_SCHEMA_INVALID",
            (await Assert.ThrowsAsync<TagException>(() => engine.QueryAsync(new() { ["limit"] = 10001 }))).Code
        );
        Assert.Equal(
            "QUERY_TYPE_MISMATCH",
            (
                await Assert.ThrowsAsync<TagException>(() =>
                    engine.QueryAsync(
                        new()
                        {
                            ["where"] = new JsonObject
                            {
                                ["op"] = "gte",
                                ["tag"] = key,
                                ["value"] = "text",
                            },
                        }
                    )
                )
            ).Code
        );
    }

    [Fact]
    public async Task ProjectionUpdatesOnlyAffectedBindingsAndRestoresExcludedReferences()
    {
        var field = await AddDefinition();
        await Batch(Write(field.Text("key"), JsonValue.Create(42)));
        var p = await CreateTerm("person", "core.people");
        await Batch(Write("core.cast", Refs("person")));
        p["label"] = TagJson.Localized("Renamed");
        var changed = await engine.PutTermAsync(
            new()
            {
                ["term"] = p,
                ["expectedGeneration"] = await Generation(),
                ["expectedRevision"] = 1,
            }
        );
        Assert.Equal(0, changed.Number("projectedCount"));
        p = changed["term"]!.DeepClone().AsObject();
        p["enabled"] = false;
        changed = await engine.PutTermAsync(
            new()
            {
                ["term"] = p,
                ["expectedGeneration"] = await Generation(),
                ["expectedRevision"] = 2,
            }
        );
        Assert.Equal(1, changed.Number("projectedCount"));
        Assert.Empty((await engine.FilmAsync(film.Id))["film"]!["values"]!["core.cast"]!["value"]!.AsArray());
        p = changed["term"]!.DeepClone().AsObject();
        p["enabled"] = true;
        changed = await engine.PutTermAsync(
            new()
            {
                ["term"] = p,
                ["expectedGeneration"] = await Generation(),
                ["expectedRevision"] = 3,
            }
        );
        Assert.Equal(1, changed.Number("projectedCount"));
        Assert.Single((await engine.FilmAsync(film.Id))["film"]!["values"]!["core.cast"]!["value"]!.AsArray());
        field["value"]!["schema"]!["maximum"] = 10;
        var preview = await engine.PreviewConfigAsync(
            new()
            {
                ["changes"] = new JsonArray(
                    new JsonObject
                    {
                        ["kind"] = "definition",
                        ["key"] = field.Text("key"),
                        ["value"] = field,
                    }
                ),
            }
        );
        Assert.Equal(1, preview.Number("projectedCount"));
        Assert.Equal(1, preview.Number("affectedCount"));
        Assert.Equal(42, (await engine.FilmAsync(film.Id))["film"]!["values"]![field.Text("key")]!.Number("value"));
        await engine.ApplyConfigAsync(new() { ["previewToken"] = preview.Text("previewToken") });
        Assert.Null((await engine.FilmAsync(film.Id))["film"]!["values"]![field.Text("key")]!["value"]);
    }

    [Fact]
    public async Task ReadSnapshotsDoNotWaitForWriterOrSeeUncommittedGeneration()
    {
        var generation = (await Generation()).GetValue<long>();
        using var writing = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        var writer = db.RunAsync(connection =>
        {
            using var tx = connection.BeginTransaction();
            using var cmd = connection.CreateCommand();
            cmd.CommandText = "UPDATE tag_state SET generation=generation+100";
            cmd.ExecuteNonQuery();
            writing.Set();
            if (!release.Wait(TimeSpan.FromSeconds(10)))
                throw new TimeoutException();
            tx.Rollback();
        });
        try
        {
            Assert.True(writing.Wait(TimeSpan.FromSeconds(5)));
            var snapshot = await engine.SnapshotAsync().WaitAsync(TimeSpan.FromSeconds(3));
            Assert.Equal(generation, snapshot["generation"]!.GetValue<long>());
        }
        finally
        {
            release.Set();
            await writer;
        }
        Assert.Equal(generation, (await Generation()).GetValue<long>());
    }

    [Fact]
    public async Task MemberGroupsAndLabelSortingHaveExplicitSemantics()
    {
        await CreateTerm("z", "core.people", "Alpha");
        await CreateTerm("a", "core.people", "Zulu");
        await Batch(Write("core.cast", Refs("z", "a")));
        var groups = (await engine.QueryAsync(Parse("""{"groupBy":[{"tag":"core.cast","mode":"member"}]}""")))[
            "groups"
        ]!.AsObject();
        Assert.Equal(1, groups["[{\"term\":\"z\"}]"]!.GetValue<long>());
        Assert.Equal(1, groups["[{\"term\":\"a\"}]"]!.GetValue<long>());
        var definitions = (await engine.SnapshotAsync())["package"].List("definitions");
        var d = definitions.Single(d => d.Text("key") == "core.cast")!.DeepClone().AsObject();
        d["query"]!["sort"] = true;
        await Publish(d);
        Assert.Equal(
            "QUERY_COLLECTION_SORT_MODE_REQUIRED",
            (
                await Assert.ThrowsAsync<TagException>(() =>
                    engine.QueryAsync(Parse("""{"orderBy":[{"tag":"core.cast"}]}"""))
                )
            ).Code
        );
        Assert.Equal(
            1,
            (await engine.QueryAsync(Parse("""{"orderBy":[{"tag":"core.cast","mode":"min"}],"locale":"en"}"""))).Number(
                "total"
            )
        );
        Assert.Equal(1, (await engine.QueryAsync(new() { ["search"] = "Alpha" })).Number("total"));
    }
}
