using System.Text.Json.Nodes;
using Vroom.Core.Storage;
using Vroom.Core.Tagging;

namespace Vroom.Tests;

public sealed partial class TaggingTests
{
    [Fact]
    public async Task SharedFileClocksStaySeparateInQueriesAndExchangeAndVersionReorderingIsAtomic()
    {
        var d = await AddDefinition("user.unfamiliar.clock");
        var path = Path.Combine(directory, "shared.mp4");
        await File.WriteAllTextAsync(path, "synthetic content");
        var before = await repo.ResourcesAsync(film.Id);
        var structure = await repo.AddVersionAsync(film.Id, before.Revision, "one", [path]);
        var one = structure.Versions.Last();
        structure = await repo.AddVersionAsync(film.Id, structure.Revision, "two", [path]);
        var two = structure.Versions.Last();
        Assert.Equal(one.Parts[0].FileId, two.Parts[0].FileId);
        Assert.NotEqual(one.Parts[0].Id, two.Parts[0].Id);
        var point = Write(d.Text("key"), JsonValue.Create(55));
        point["scope"] = new JsonObject
        {
            ["kind"] = "point",
            ["scopeId"] = "shared-file-one-clock",
            ["partId"] = one.Parts[0].Id,
            ["startUs"] = "1000000",
        };
        await Batch(point);
        foreach (var part in new[] { one.Parts[0], two.Parts[0] })
        {
            var query = new JsonObject
            {
                ["ignoreDefaultQuery"] = true,
                ["where"] = new JsonObject
                {
                    ["op"] = "scoped",
                    ["scope"] = new JsonObject { ["kind"] = "point", ["partId"] = part.Id },
                    ["quantifier"] = "any",
                    ["where"] = new JsonObject
                    {
                        ["op"] = "eq",
                        ["tag"] = d.Text("key"),
                        ["value"] = 55,
                    },
                },
            };
            Assert.Equal(part.Id == one.Parts[0].Id ? 1 : 0, (await engine.QueryAsync(query)).Number("total"));
        }
        var preview = await engine.PreviewImportAsync(
            new() { ["document"] = await engine.ExportAsync("annotations", true) }
        );
        Assert.True(preview.Flag("canCommit"));
        await engine.CommitImportAsync(new() { ["previewToken"] = preview["previewToken"].Copy() });
        Assert.Single((await engine.FilmAsync(film.Id, partId: one.Parts[0].Id)).List("annotations"));
        Assert.Empty((await engine.FilmAsync(film.Id, partId: two.Parts[0].Id)).List("annotations"));
        var reordered = await engine.ChangeMediaStructureAsync(
            film.Id,
            structure.Revision,
            "reorder-versions",
            film.Id,
            order: structure.Versions.Reverse().Select(v => v.Id).ToArray()
        );
        Assert.Equal(two.Id, reordered.Versions[0].Id);
        await Assert.ThrowsAsync<ArgumentException>(() =>
            engine.ChangeMediaStructureAsync(
                film.Id,
                reordered.Revision,
                "reorder-versions",
                film.Id,
                order: [one.Id, one.Id, two.Id]
            )
        );
        Assert.Equal(reordered.Revision, (await repo.ResourcesAsync(film.Id)).Revision);
        var text = Path.Combine(directory, "attachment.txt");
        await File.WriteAllTextAsync(text, "notes");
        await Assert.ThrowsAsync<ArgumentException>(() =>
            repo.AddResourceFilesAsync(film.Id, reordered.Revision, one.Id, true, [text])
        );
    }

    [Fact]
    public async Task PartsKeepIndependentPositionsAndScopesAcrossSelectionAndDetachment()
    {
        var d = await AddDefinition("user.unfamiliar.segment");
        var path = Path.Combine(db.DataDirectory, "second.mp4");
        await File.WriteAllTextAsync(path, "fixture second part");
        var before = await repo.ResourcesAsync(film.Id);
        var structure = await repo.AddVersionAsync(film.Id, before.Revision, "another edit", [path]);
        var first = before.Versions.Single().Parts.Single();
        var second = structure.Versions.Last().Parts.Single();
        await repo.SavePositionAsync(film.Id, first.Id, 11);
        await repo.SavePositionAsync(film.Id, second.Id, 27);
        var point = Write(d.Text("key"), JsonValue.Create(61));
        point["scope"] = new JsonObject
        {
            ["kind"] = "point",
            ["scopeId"] = "different-clock",
            ["startUs"] = "1000000",
            ["partId"] = second.Id,
        };
        await Batch(point);
        Assert.Empty((await engine.FilmAsync(film.Id)).List("annotations"));
        Assert.Single((await engine.FilmAsync(film.Id, partId: second.Id)).List("annotations"));
        var selected = await engine.ChangeMediaStructureAsync(film.Id, structure.Revision, "select-part", second.Id);
        Assert.Equal(27, (await repo.GetMediaAsync(film.Id)).Position);
        await repo.SavePositionAsync(film.Id, first.Id, 13);
        Assert.Equal(27, (await repo.GetMediaAsync(film.Id)).Position);
        Assert.Equal(13, (await repo.GetMediaPartAsync(film.Id, first.Id)).Position);
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            repo.ChangeResourcesAsync(film.Id, structure.Revision, "select-part", first.Id)
        );
        var exported = await engine.ExportAsync("annotations", true);
        var original = exported.List("records").Single(r => r.Text("tagKey") == d.Text("key"))!.ToJsonString();
        await engine.ChangeMediaStructureAsync(
            film.Id,
            selected.Revision,
            "remove-version",
            structure.Versions.Last().Id
        );
        Assert.Empty((await engine.FilmAsync(film.Id)).List("annotations"));
        Assert.Equal(
            original,
            (await engine.ExportAsync("annotations", true))
                .List("records")
                .Single(r => r.Text("tagKey") == d.Text("key"))!
                .ToJsonString()
        );
        Assert.Equal(
            0L,
            await db.ReadAsync(db =>
                db.Scalar("SELECT count(*) FROM tag_effective WHERE tag_key='user.unfamiliar.segment'")
            )
        );
        Assert.Equal(
            1L,
            await db.ReadAsync(db =>
                db.Scalar("SELECT count(*) FROM tag_issues WHERE tag_key='user.unfamiliar.segment'")
            )
        );
        Assert.True(File.Exists(path));
    }

    [Fact]
    public async Task ArbitraryResourcesCanBeSharedDetachedAndCannotCrossWorkOwnership()
    {
        var path = Path.Combine(db.DataDirectory, "notes.txt");
        await File.WriteAllTextAsync(path, "fixture attachment");
        var before = await repo.ResourcesAsync(film.Id);
        var version = before.Versions.Single();
        var part = version.Parts.Single();
        var structure = await repo.AddResourceSetAsync(film.Id, before.Revision, "supplement", [path], partId: part.Id);
        var set = Assert.Single(structure.ResourceSets);
        Assert.Equal(version.Id, set.VersionId);
        Assert.Equal(part.Id, set.PartId);
        var other = await repo.ImportMediaAsync(
            new() { LibraryId = film.LibraryId, Path = Path.Combine(db.DataDirectory, "another.mp4") }
        );
        await Assert.ThrowsAsync<ArgumentException>(() => repo.ResourceFileAsync(other.Id, set.Files[0].Id));
        await Assert.ThrowsAsync<KeyNotFoundException>(() =>
            repo.AddResourceSetAsync(other.Id, 1, "invalid", [path], partId: part.Id)
        );
        var detached = await engine.ChangeMediaStructureAsync(film.Id, structure.Revision, "remove-part", part.Id);
        Assert.Null(detached.ResourceSets[0].PartId);
        Assert.Single(detached.ResourceSets[0].Files);
        var removed = await engine.ChangeMediaStructureAsync(film.Id, detached.Revision, "remove-set", set.Id);
        Assert.Empty(removed.ResourceSets);
        Assert.True(File.Exists(path));
    }
}
