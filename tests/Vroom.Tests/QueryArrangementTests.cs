using System.Text.Json.Nodes;
using Vroom.Core.Tagging;

namespace Vroom.Tests;

public sealed partial class TaggingTests
{
    [Fact]
    public async Task SavedQueryRetainsNestedScopesSearchAndEveryArrangementField()
    {
        foreach (var key in new[] { "user.saved.axis-a", "user.saved.axis-b" })
        {
            var d = await AddDefinition(key);
            d["query"]!["groupBy"] = new JsonArray("value");
            await Publish(d);
        }
        var scoped = Write("user.saved.axis-b", JsonValue.Create(6));
        scoped["scope"] = Parse("""{"kind":"interval","scopeId":"saved-range","startUs":"0","endUs":"2000000"}""");
        await engine.BatchAsync(
            new()
            {
                ["expectedGeneration"] = (await engine.SnapshotAsync())["generation"]!.DeepClone(),
                ["writes"] = new JsonArray(Write("user.saved.axis-a", JsonValue.Create(4)), scoped),
            }
        );
        var query = Parse(
            """
            {"libraryId":"lib","ignoreDefaultQuery":true,"search":"","locale":"en","offset":0,"limit":17,
              "where":{"op":"and","args":[
                {"op":"or","args":[{"op":"eq","tag":"user.saved.axis-a","value":4},{"op":"missing","tag":"user.saved.axis-a"}]},
                {"op":"not","arg":{"op":"between","tag":"user.saved.axis-a","value":[8,10]}},
                {"op":"scoped","scope":{"kind":"interval","startUs":"0","endUs":"1000000","match":"overlaps"},"quantifier":"any","where":{"op":"eq","tag":"user.saved.axis-b","value":6}}
              ]},
              "orderBy":[{"tag":"user.saved.axis-a","direction":"desc","mode":"value","nulls":"first"},{"tag":"user.saved.axis-b","direction":"asc","mode":"value","nulls":"last"}],
              "groupBy":[{"tag":"user.saved.axis-b","mode":"value","facet":""},{"tag":"user.saved.axis-a","mode":"value","facet":""}]}
            """
        );
        async Task<JsonObject> SaveAndRead()
        {
            await engine.SaveViewAsync(
                new()
                {
                    ["id"] = "round-trip",
                    ["name"] = "Complete query",
                    ["query"] = query.DeepClone(),
                }
            );
            var saved = (await repo.ViewsAsync()).Single().Query;
            var loaded = System
                .Text.Json.JsonSerializer.SerializeToNode(
                    saved,
                    new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web)
                )!
                .AsObject();
            Assert.True(JsonNode.DeepEquals(query, loaded), loaded.ToJsonString());
            return loaded;
        }
        var restored = await SaveAndRead();
        Assert.Equal(1, (await engine.QueryAsync(restored)).Number("total"));
        Assert.True(JsonNode.DeepEquals(await engine.QueryAsync(query), await engine.QueryAsync(restored)));
        query["search"] = "a phrase with spaces & 'quotes'";
        await SaveAndRead();
        query["orderBy"] = new JsonArray();
        query["groupBy"] = new JsonArray();
        restored = await SaveAndRead();
        Assert.Empty(restored.List("orderBy"));
        Assert.Empty(restored.List("groupBy"));
    }

    [Fact]
    public async Task WildcardPatternsAreParameterizedAndCanEscapeLiteralCharacters()
    {
        var d = await AddDefinition("user.query.caption");
        d["value"]!["schema"] = new JsonObject { ["type"] = "string" };
        d["input"] = new JsonObject { ["component"] = "text@1" };
        await Publish(d);
        await engine.BatchAsync(
            new()
            {
                ["expectedGeneration"] = (await engine.SnapshotAsync())["generation"]!.DeepClone(),
                ["writes"] = new JsonArray(Write("user.query.caption", JsonValue.Create("oak_50%"))),
            }
        );
        var query = Parse(
            """{"ignoreDefaultQuery":true,"where":{"op":"like","tag":"user.query.caption","value":"oak%"}}"""
        );
        Assert.Equal(1, (await engine.QueryAsync(query)).Number("total"));
        query["where"]!["value"] = "oak\\_50\\%";
        Assert.Equal(1, (await engine.QueryAsync(query)).Number("total"));
        query["where"]!["value"] = "%' OR 1=1 --";
        Assert.Equal(0, (await engine.QueryAsync(query)).Number("total"));
    }

    [Fact]
    public async Task OrderedFieldsTupleGroupsAndQueueUseTheSameEffectiveValues()
    {
        foreach (var key in new[] { "user.query.axis-a", "user.query.axis-b" })
        {
            var d = await AddDefinition(key);
            d["query"]!["groupBy"] = new JsonArray("value");
            await Publish(d);
        }
        var first = film;
        var second = await repo.ImportMediaAsync(
            new()
            {
                LibraryId = "lib",
                Path = Path.Combine(directory, "second.mp4"),
                Size = 20,
            }
        );
        var third = await repo.ImportMediaAsync(
            new()
            {
                LibraryId = "lib",
                Path = Path.Combine(directory, "third.mp4"),
                Size = 30,
            }
        );
        var empty = await repo.ImportMediaAsync(
            new()
            {
                LibraryId = "lib",
                Path = Path.Combine(directory, "empty.mp4"),
                Size = 40,
            }
        );
        foreach (
            var (item, a, b) in new[]
            {
                (first, 1, (int?)2),
                (second, 1, (int?)1),
                (third, 2, (int?)1),
                (empty, 1, (int?)null),
            }
        )
        {
            film = item;
            var writes = new JsonArray(Write("user.query.axis-a", JsonValue.Create(a)));
            if (b.HasValue)
                writes.Add(Write("user.query.axis-b", JsonValue.Create(b.Value)));
            await engine.BatchAsync(
                new()
                {
                    ["expectedGeneration"] = (await engine.SnapshotAsync())["generation"]!.DeepClone(),
                    ["writes"] = writes,
                }
            );
        }
        var query = Parse(
            """{"ignoreDefaultQuery":true,"orderBy":[{"tag":"user.query.axis-a","direction":"asc"},{"tag":"user.query.axis-b","direction":"desc","nulls":"last"}],"groupBy":[{"tag":"user.query.axis-a"},{"tag":"user.query.axis-b"}]}"""
        );
        var result = await engine.QueryAsync(query);
        var expected = new[] { first.Id, second.Id, empty.Id, third.Id };
        Assert.Equal(expected, result.List("films").Select(f => f.Text("id")));
        Assert.Equal(expected, (await engine.QueryIdsAsync(query)).List("ids").Select(v => v!.ToString()));
        var groups = result["groups"]!.AsObject();
        Assert.Equal(4, groups.Count);
        Assert.Equal(1, groups["[1,null]"]!.GetValue<long>());
        Assert.Equal(1, groups["[1,2]"]!.GetValue<long>());
        query["offset"] = 1;
        query["limit"] = 2;
        Assert.Equal(
            expected.Skip(1).Take(2),
            (await engine.QueryAsync(query)).List("films").Select(f => f.Text("id"))
        );
        await engine.SaveViewAsync(
            new()
            {
                ["id"] = "multi-order",
                ["name"] = "Tuple query",
                ["query"] = query.DeepClone(),
            }
        );
        Assert.Equal(2, (await repo.ViewsAsync()).Single().Query.OrderBy!.Length);
        var range = Parse(
            """{"ignoreDefaultQuery":true,"where":{"op":"between","tag":"user.query.axis-b","value":[1,2]}}"""
        );
        Assert.Equal(3, (await engine.QueryAsync(range)).Number("total"));
        range["where"] = Parse("""{"op":"not","arg":{"op":"in","tag":"user.query.axis-b","values":[1,2]}}""");
        Assert.Empty((await engine.QueryAsync(range)).List("films")); // SQL NOT IN preserves unknown for the missing value.
        Assert.Equal(
            "QUERY_SCHEMA_INVALID",
            (
                await Assert.ThrowsAsync<TagException>(() =>
                    engine.QueryAsync(Parse("""{"sort":"user.query.axis-a"}"""))
                )
            ).Code
        );
    }
}
