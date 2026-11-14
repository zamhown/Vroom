using System.Text.Json.Nodes;
using Vroom.Core.Storage;
using Vroom.Core.Tagging;

namespace Vroom.Tests;

public sealed partial class TaggingTests
{
    [Fact]
    public async Task RemovingALibraryArchivesAndRemovesItsAnnotationsWithoutOrphans()
    {
        var field = await AddDefinition("user.removal.score");
        await Batch(Write(field.Text("key"), JsonValue.Create(7)));
        var library = film.LibraryId;
        var removal = await engine.RemoveLibraryAsync(library);
        var archive = removal["archive"]!.GetValue<string>();
        Assert.True(File.Exists(archive));
        var bundle = JsonNode.Parse(await File.ReadAllTextAsync(archive))!;
        Assert.Equal("tag-bundle", bundle.Text("kind"));
        Assert.Contains(bundle["annotations"].List("records"), r => r!["subject"].Text("id") == film.Id);
        foreach (
            var table in new[] { "tag_heads", "tag_effective", "tag_reference_edges", "tag_scope_index", "tag_issues" }
        )
            Assert.Equal(
                0L,
                await db.ReadAsync(c =>
                    Convert.ToInt64(c.Scalar($"SELECT COUNT(*) FROM {table} WHERE subject_id=@id", ("@id", film.Id)))
                )
            );
        Assert.Empty((await engine.QueryAsync(new() { ["ignoreDefaultQuery"] = true })).List("films"));
    }
}

public sealed partial class TaggingTests
{
    [Fact]
    public async Task RemovingSingleFilmsArchivesAndCleansTheirAnnotations()
    {
        var field = await AddDefinition("user.removal.single");
        await Batch(Write(field.Text("key"), JsonValue.Create(3)));
        var result = await engine.RemoveFilmsAsync([film.Id]);
        Assert.Equal(1, result["films"]!.GetValue<int>());
        Assert.True(File.Exists(result["archive"]!.GetValue<string>()));
        Assert.Equal(
            0L,
            await db.ReadAsync(c =>
                Convert.ToInt64(c.Scalar("SELECT COUNT(*) FROM tag_heads WHERE subject_id=@id", ("@id", film.Id)))
            )
        );
        Assert.Equal(1, (await repo.LibrariesAsync()).Count(l => l.Id == film.LibraryId));
    }
}
