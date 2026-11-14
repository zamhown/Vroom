using System.Text.Json.Nodes;
using Vroom.Core.Domain;
using Vroom.Core.Storage;
using Vroom.Core.Tagging;

namespace Vroom.Tests;

public sealed partial class TaggingTests : IAsyncLifetime
{
    private readonly string directory = Path.Combine(
        Path.GetTempPath(),
        "vroom-tag-tests",
        Guid.NewGuid().ToString("N")
    );
    private CatalogDatabase db = null!;
    private CatalogRepository repo = null!;
    private TagEngine engine = null!;
    private Film film = null!;

    public async Task InitializeAsync()
    {
        db = new(directory);
        repo = new(db);
        await repo.InitializeAsync();
        await repo.SaveLibraryAsync(new("lib", "Library", [Path.Combine(directory, "library")], [], false));
        film = await repo.ImportMediaAsync(
            new()
            {
                LibraryId = "lib",
                Path = Path.Combine(directory, "TEST-001.mp4"),
                Size = 10,
                Duration = 60,
            }
        );
        engine = new(repo);
        await engine.InitializeAsync();
        await engine.RecordMediaEventAsync("film.discovered", film.Id);
    }

    public Task DisposeAsync()
    {
        db.Dispose();
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        Directory.Delete(directory, true);
        return Task.CompletedTask;
    }

    private static JsonObject Parse(string s) => JsonNode.Parse(s)!.AsObject();

    private JsonObject Write(string key, JsonNode? value, long revision = 0) =>
        new()
        {
            ["subject"] = new JsonObject { ["kind"] = "film", ["id"] = film.Id },
            ["scope"] = new JsonObject { ["kind"] = "whole" },
            ["tagKey"] = key,
            ["value"] = value,
            ["expectedRevision"] = revision,
        };

    private async Task<JsonObject> AddDefinition(string key = "user.test.progress")
    {
        var definition = Parse(
            """{"key":"user.test.progress","revision":1,"enabled":true,"label":{"en":"Progress"},"parents":[],"targets":["film-whole","film-point","film-interval"],"value":{"cardinality":"one","schema":{"type":"integer","minimum":0,"maximum":100},"semanticVersion":1},"input":{"component":"slider@1","props":{"min":0,"max":100}},"placements":[{"id":"details","slot":"film.details.fields","view":"input","mode":"edit"}],"query":{"filter":true,"sort":true,"deduplicate":true}}"""
        );
        definition["key"] = key;
        await Publish(definition);
        return definition;
    }

    private async Task Publish(JsonObject definition)
    {
        var preview = await engine.PreviewConfigAsync(
            new()
            {
                ["changes"] = new JsonArray(
                    new JsonObject
                    {
                        ["kind"] = "definition",
                        ["key"] = definition.Text("key"),
                        ["value"] = definition.DeepClone(),
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
    }

    [Fact]
    public async Task DefaultsInitializeNewMediaOnlyOnce()
    {
        var detail = await engine.FilmAsync(film.Id);
        Assert.NotNull(detail["film"]!["values"]!["core.visibility"]!["value"]!["term"]);
        var before = (await engine.SnapshotAsync())["generation"]!.GetValue<long>();
        await engine.InitializeAsync();
        Assert.Equal(before, (await engine.SnapshotAsync())["generation"]!.GetValue<long>());
        Assert.Contains("tag-definitions.schema.json", TagResources.Names);
        Assert.Contains("KNOWLEDGE.md", TagResources.Names);
    }

    [Fact]
    public async Task UnknownFieldWorksAndInvalidIntersectionPreservesHistory()
    {
        var d = await AddDefinition();
        var generation = (await engine.SnapshotAsync())["generation"]!.DeepClone();
        await engine.BatchAsync(
            new()
            {
                ["expectedGeneration"] = generation,
                ["writes"] = new JsonArray(Write(d.Text("key"), JsonValue.Create(80))),
            }
        );
        d["value"]!["schema"]!["maximum"] = 50;
        var preview = await engine.PreviewConfigAsync(
            new()
            {
                ["changes"] = new JsonArray(
                    new JsonObject
                    {
                        ["kind"] = "definition",
                        ["key"] = d.Text("key"),
                        ["value"] = d.DeepClone(),
                    }
                ),
            }
        );
        Assert.Equal(1, preview["affectedCount"]!.GetValue<long>());
        await engine.ApplyConfigAsync(new() { ["previewToken"] = preview["previewToken"]!.DeepClone() });
        var entry = (await engine.FilmAsync(film.Id))["film"]!["values"]![d.Text("key")]!;
        Assert.Null(entry["value"]);
        Assert.Equal("VALUE_OUT_OF_DOMAIN", entry.Text("status"));
        var query = await engine.QueryAsync(Parse("""{"where":{"op":"gte","tag":"user.test.progress","value":1}}"""));
        Assert.Equal(0, query["total"]!.GetValue<long>());
        d["value"]!["schema"]!["maximum"] = 100;
        await Publish(d);
        Assert.Equal(
            80,
            (await engine.FilmAsync(film.Id))["film"]!["values"]![d.Text("key")]!["value"]!.GetValue<int>()
        );
    }

    [Fact]
    public async Task CycleAndSystemWritesAreRejected()
    {
        var d = await AddDefinition();
        d["parents"] = new JsonArray(d.Text("key"));
        var ex = await Assert.ThrowsAsync<TagException>(() => Publish(d));
        Assert.Equal("DEFINITION_CYCLE", ex.Code);
        await Assert.ThrowsAsync<TagException>(() =>
            engine.PreviewConfigAsync(Parse("""{"layer":"system","changes":[]}"""))
        );
    }

    [Fact]
    public async Task StaleBatchRollsBackAllFieldsAndIdempotencyDoesNotReplay()
    {
        await AddDefinition();
        var gen = (await engine.SnapshotAsync())["generation"]!.DeepClone();
        var write = new JsonObject
        {
            ["expectedGeneration"] = gen,
            ["idempotencyKey"] = "test-write",
            ["writes"] = new JsonArray(Write("user.test.progress", JsonValue.Create(12))),
        };
        await engine.BatchAsync(write);
        await engine.BatchAsync(write);
        var result = (await engine.FilmAsync(film.Id))["film"]!["values"]!["user.test.progress"]!;
        Assert.Equal(1, result["revision"]!.GetValue<long>());
        await Assert.ThrowsAsync<TagException>(() =>
            engine.BatchAsync(
                new()
                {
                    ["expectedGeneration"] = gen.DeepClone(),
                    ["writes"] = new JsonArray(Write("user.test.progress", JsonValue.Create(13))),
                }
            )
        );
        Assert.Equal(
            12,
            (await engine.FilmAsync(film.Id))["film"]!["values"]!["user.test.progress"]!["value"]!.GetValue<int>()
        );
    }

    [Fact]
    public async Task MalformedBatchMembersAreRejectedWithoutPartialWrites()
    {
        var d = await AddDefinition();
        var gen = (await engine.SnapshotAsync())["generation"]!.DeepClone();
        var error = await Assert.ThrowsAsync<TagException>(() =>
            engine.BatchAsync(
                new()
                {
                    ["expectedGeneration"] = gen,
                    ["writes"] = new JsonArray(Write(d.Text("key"), JsonValue.Create(12)), JsonValue.Create("invalid")),
                }
            )
        );
        Assert.Equal("WRITE_INVALID", error.Code);
        Assert.Null((await engine.FilmAsync(film.Id))["film"]!["values"]![d.Text("key")]);
        var before = (await engine.SnapshotAsync())["generation"]!.DeepClone();
        var configError = await Assert.ThrowsAsync<TagException>(() =>
            engine.PreviewConfigAsync(
                new()
                {
                    ["changes"] = new JsonArray(
                        new JsonObject
                        {
                            ["kind"] = "definition",
                            ["key"] = d.Text("key"),
                            ["value"] = d.DeepClone(),
                        },
                        null
                    ),
                }
            )
        );
        Assert.Equal("CHANGE_INVALID", configError.Code);
        Assert.True(JsonNode.DeepEquals(before, (await engine.SnapshotAsync())["generation"]));
    }

    [Fact]
    public async Task CurrentExportsContainOnlyIntersectionWhileArchivePreservesInvalidValues()
    {
        var d = await AddDefinition();
        var gen = (await engine.SnapshotAsync())["generation"]!.DeepClone();
        await engine.BatchAsync(
            new()
            {
                ["expectedGeneration"] = gen,
                ["writes"] = new JsonArray(Write(d.Text("key"), JsonValue.Create(80))),
            }
        );
        d["value"]!["schema"]!["maximum"] = 50;
        await Publish(d);
        Assert.DoesNotContain(
            (await engine.ExportAsync("annotations")).List("records"),
            r => r.Text("tagKey") == d.Text("key")
        );
        Assert.Contains(
            (await engine.ExportAsync("annotations", true)).List("records"),
            r => r.Text("tagKey") == d.Text("key") && r.Number("value") == 80
        );
    }
}
