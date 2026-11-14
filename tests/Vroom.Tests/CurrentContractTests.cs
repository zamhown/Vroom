using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;
using Vroom.Core.Storage;
using Vroom.Core.Tagging;

namespace Vroom.Tests;

public sealed partial class TaggingTests
{
    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(99)]
    public async Task UnsupportedPackagesAreRejectedWithoutChangingTheCatalog(int version)
    {
        var before = await engine.SnapshotAsync();
        var document = await engine.ExportAsync("bundle", true);
        document["formatVersion"] = version;
        Assert.Equal(
            "FORMAT_UNSUPPORTED",
            (
                await Assert.ThrowsAsync<TagException>(() =>
                    engine.PreviewImportAsync(new() { ["document"] = document })
                )
            ).Code
        );
        Assert.True(JsonNode.DeepEquals(before, await engine.SnapshotAsync()));
    }

    [Fact]
    public async Task NestedImportContractsAreValidatedBeforeBuildingChanges()
    {
        var document = await engine.ExportAsync("bundle");
        document["definitions"]!["formatVersion"] = 2;
        Assert.Equal(
            "IMPORT_SCHEMA_INVALID",
            (
                await Assert.ThrowsAsync<TagException>(() =>
                    engine.PreviewImportAsync(new() { ["document"] = document })
                )
            ).Code
        );
        document = await engine.ExportAsync("definitions");
        document["unrecognizedConfiguration"] = true;
        Assert.Equal(
            "IMPORT_SCHEMA_INVALID",
            (
                await Assert.ThrowsAsync<TagException>(() =>
                    engine.PreviewImportAsync(new() { ["document"] = document })
                )
            ).Code
        );
    }

    [Fact]
    public async Task RemovedDeclarationFieldsAndLiteralCodecsCannotBePublished()
    {
        var d = await AddDefinition();
        foreach (var property in new[] { "temporal", "migration", "options" })
        {
            var invalid = d.DeepClone().AsObject();
            invalid[property] = new JsonObject();
            Assert.Equal("SCHEMA_INVALID", (await Assert.ThrowsAsync<TagException>(() => Publish(invalid))).Code);
        }
        var field = RelationField("user.reference", "core.people");
        field["value"]!["encoding"] = "literal";
        Assert.Equal("SCHEMA_INVALID", (await Assert.ThrowsAsync<TagException>(() => Publish(field))).Code);
        d["targets"] = new JsonArray("film");
        Assert.Equal("SCHEMA_INVALID", (await Assert.ThrowsAsync<TagException>(() => Publish(d))).Code);
    }

    [Fact]
    public void EditorAndExchangeSchemasResolveTheSameAuthoritativeDefinitions()
    {
        var package = TagResources.Json("core.tagdefs.json");
        foreach (var field in package.List("definitions"))
            Assert.True(TagSchemas.Get("tag-definition.schema.json").Evaluate(field).IsValid);
        var fragment = SchemaKnowledge.Fragment("definition");
        Assert.True(
            JsonNode.DeepEquals(
                fragment["properties"],
                CapabilityContract.Expand(
                    TagResources.Json("tag-definitions.schema.json")["$defs"]!["definition"]!["properties"]
                )
            )
        );
        Assert.DoesNotContain(TagResources.Names, n => n.StartsWith("legacy-"));
    }

    [Theory]
    [InlineData("sort")]
    [InlineData("groupBy")]
    public async Task QueriesAndSavedViewsEnforceDeclaredCapabilities(string capability)
    {
        var field = await AddDefinition();
        field["query"] = new JsonObject
        {
            ["filter"] = true,
            ["sort"] = false,
            ["groupBy"] = new JsonArray(),
        };
        await Publish(field);
        var query = new JsonObject
        {
            [capability == "sort" ? "orderBy" : "groupBy"] = new JsonArray(
                new JsonObject { ["tag"] = field.Text("key") }
            ),
        };
        Assert.Equal(
            "QUERY_FIELD_DISABLED",
            (await Assert.ThrowsAsync<TagException>(() => engine.QueryAsync(query))).Code
        );
        Assert.Equal(
            "QUERY_FIELD_DISABLED",
            (
                await Assert.ThrowsAsync<TagException>(() =>
                    engine.SaveViewAsync(
                        new()
                        {
                            ["id"] = "restricted",
                            ["name"] = "Restricted",
                            ["query"] = query.DeepClone(),
                        }
                    )
                )
            ).Code
        );
        Assert.Empty(await repo.ViewsAsync());
        field["query"]!["sort"] = true;
        field["query"]!["groupBy"] = new JsonArray("value");
        await Publish(field);
        Assert.Equal(1, (await engine.QueryAsync(query)).Number("total"));
        await engine.SaveViewAsync(
            new()
            {
                ["id"] = "allowed",
                ["name"] = "Allowed",
                ["query"] = query.DeepClone(),
            }
        );
        Assert.Single(await repo.ViewsAsync());
    }

    [Fact]
    public async Task OlderDatabaseIsRejectedWithoutAddingTablesOrChangingMedia()
    {
        var path = Path.Combine(directory, "unsupported");
        Directory.CreateDirectory(path);
        using (var connection = new SqliteConnection("Data Source=" + Path.Combine(path, "catalog.db")))
        {
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText =
                "CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES('untouched'); PRAGMA user_version=2;";
            command.ExecuteNonQuery();
        }
        using var unsupported = new CatalogDatabase(path);
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            new CatalogRepository(unsupported).InitializeAsync()
        );
        Assert.StartsWith("CATALOG_FORMAT_UNSUPPORTED", error.Message);
        using var verify = new SqliteConnection("Data Source=" + unsupported.DatabasePath);
        verify.Open();
        using var check = verify.CreateCommand();
        check.CommandText = "SELECT COUNT(*) FROM sqlite_master WHERE type='table'";
        Assert.Equal(1L, check.ExecuteScalar());
        check.CommandText = "SELECT value FROM fixture";
        Assert.Equal("untouched", check.ExecuteScalar());
    }

    [Fact]
    public async Task FreshStorageContainsNoTagSpecificColumnsOrOldRelationTables()
    {
        var columns = await db.RunAsync(connection =>
        {
            using var command = connection.CreateCommand();
            command.CommandText = "PRAGMA table_info(films)";
            using var reader = command.ExecuteReader();
            var names = new List<string>();
            while (reader.Read())
                names.Add(reader.GetString(1));
            return names;
        });
        Assert.DoesNotContain(
            columns,
            n => new[] { "rating", "favorite", "watched", "title", "code", "archived" }.Contains(n)
        );
        Assert.DoesNotContain("path", columns);
        var fileColumns = await db.RunAsync(connection =>
        {
            using var command = connection.CreateCommand();
            command.CommandText = "PRAGMA table_info(media_files)";
            using var reader = command.ExecuteReader();
            var names = new List<string>();
            while (reader.Read())
                names.Add(reader.GetString(1));
            return names;
        });
        Assert.Contains("path", fileColumns);
        Assert.DoesNotContain("rating", fileColumns);
    }

    [Theory]
    [InlineData("abp00123-C.mp4", "ABP-123")]
    [InlineData("h_123ssis00123.mkv", "SSIS-123")]
    [InlineData("FC2 PPV 001234567.mp4", "FC2-PPV-1234567")]
    [InlineData("ＡＢＰ－１２３.mp4", "ABP-123")]
    [InlineData("AAC128 ABP-123.mp4", "ABP-123")]
    [InlineData("HEVC265 SSIS00123.mkv", "SSIS-123")]
    [InlineData("1080p h264 AAC.mp4", null)]
    public async Task PathInitializationUsesTheInstalledRuleResource(string name, string? expected)
    {
        var media = await repo.ImportMediaAsync(
            new()
            {
                LibraryId = "lib",
                Path = Path.Combine(directory, name),
                Size = 1,
            }
        );
        await engine.RecordMediaEventAsync("film.discovered", media.Id, new JsonObject { ["relativePath"] = name });
        Assert.Equal(
            expected,
            (await engine.FilmAsync(media.Id))["film"]!["values"]?["core.code"]?["value"]?.ToString()
        );
    }

    [Fact]
    public async Task SchemaSidecarsRejectWrongIdentityAndExternalEntities()
    {
        using var sources = new TagSources(engine);
        var path = Path.ChangeExtension(film.Path, ".nfo");
        await File.WriteAllTextAsync(path, "<movie><id>OTHER-002</id><title>wrong</title></movie>");
        Assert.Contains((await sources.EnrichAsync(film.Id)).Sources, s => s.Status == "identity-mismatch");
        Assert.Empty((await engine.FilmAsync(film.Id)).List("candidates"));
        await File.WriteAllTextAsync(
            path,
            "<!DOCTYPE movie [<!ENTITY x SYSTEM 'file:///nonexistent'>]><movie><title>&x;</title></movie>"
        );
        Assert.Contains((await sources.EnrichAsync(film.Id)).Sources, s => s.Status == "source-error");
        Assert.Empty((await engine.FilmAsync(film.Id)).List("candidates"));
    }

    [Fact]
    public async Task SchemaSidecarsPreserveManualValuesAndKeepTextWhenImageIsMissing()
    {
        var current = (await engine.FilmAsync(film.Id))["film"]!["values"]!["core.title"]!;
        await Put("core.title", JsonValue.Create("Manual title")!, (long)current.Number("revision"));
        await File.WriteAllTextAsync(
            Path.ChangeExtension(film.Path, ".nfo"),
            "<movie><id>TEST-001</id><title>Source title</title><plot>Source description</plot><thumb>missing.jpg</thumb></movie>"
        );
        using var sources = new TagSources(engine);
        Assert.True((await sources.EnrichAsync(film.Id)).Found);
        var values = (await engine.FilmAsync(film.Id))["film"]!["values"]!;
        Assert.Equal("Manual title", values["core.title"]!.Text("value"));
        Assert.Equal("Source description", values["core.description"]!.Text("value"));
        Assert.Null(values["core.poster"]);
    }
}
