using System.Text.Json.Nodes;
using Vroom.Core.Tagging;

namespace Vroom.Tests;

public sealed partial class TaggingTests
{
    [Fact]
    public async Task ContinueWatchingListsPartlyWatchedFilmsUntilTheyAreFinished()
    {
        JsonObject Scope(string scope) => new() { ["scope"] = scope, ["ignoreDefaultQuery"] = true };
        Assert.Empty((await engine.QueryAsync(Scope("continue-watching"))).List("films"));
        await repo.SavePositionAsync(film.Id, film.PartId, 120);
        Assert.Equal(
            film.Id,
            Assert.Single((await engine.QueryAsync(Scope("continue-watching"))).List("films"))!.Text("id")
        );
        await repo.SavePositionAsync(film.Id, film.PartId, 0, ended: true);
        Assert.Empty((await engine.QueryAsync(Scope("continue-watching"))).List("films"));
        Assert.Single((await engine.QueryAsync(Scope("recently-played"))).List("films"));
        Assert.NotEmpty((await engine.QueryAsync(Scope("recently-added"))).List("films"));
    }
}
