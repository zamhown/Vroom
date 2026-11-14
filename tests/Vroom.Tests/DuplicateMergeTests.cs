using System.Text.Json;
using System.Text.Json.Nodes;
using Vroom.Core.Tagging;

namespace Vroom.Tests;

public sealed partial class TaggingTests
{
    [Fact]
    public async Task KeepingSeveralDuplicatesMergesThemIntoOneFilmAsVersions()
    {
        async Task<string> Add(string name) =>
            (
                await repo.ImportMediaAsync(
                    new()
                    {
                        LibraryId = film.LibraryId,
                        Path = Path.Combine(directory, name),
                        Size = 5,
                    }
                )
            ).Id;
        var second = await Add("second-copy.mp4");
        var hidden = await Add("third-copy.mp4");
        var result = JsonSerializer.SerializeToNode(
            await engine.ResolveDuplicatesAsync(
                new()
                {
                    ["candidateIds"] = new JsonArray(film.Id, second, hidden),
                    ["keepIds"] = new JsonArray(film.Id, second),
                    ["expectedGeneration"] = (await engine.SnapshotAsync())["generation"]!.DeepClone(),
                    ["expectedRevisions"] = new JsonObject
                    {
                        [film.Id] = 0,
                        [second] = 0,
                        [hidden] = 0,
                    },
                }
            )
        )!;
        Assert.Equal(film.Id, result.Text("primaryId"));
        Assert.Equal(2, (await repo.ResourcesAsync(film.Id)).Versions.Count);
        await Assert.ThrowsAsync<KeyNotFoundException>(() => repo.GetMediaAsync(second));
        Assert.True(File.Exists(result.Text("archive")));
        Assert.NotNull(await repo.GetMediaAsync(hidden));
    }
}
