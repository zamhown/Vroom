using Vroom.Core.Domain;
using Vroom.Core.Media;
using Vroom.Core.Storage;

namespace Vroom.Tests;

public sealed class CatalogTests : IAsyncLifetime
{
    private readonly string directory = Path.Combine(Path.GetTempPath(), "vroom-tests", Guid.NewGuid().ToString("N"));
    private CatalogDatabase db = null!;
    private CatalogRepository repo = null!;

    public async Task InitializeAsync()
    {
        db = new(directory);
        repo = new(db);
        await repo.InitializeAsync();
        await repo.SaveLibraryAsync(new("lib", "Test", [directory], []));
    }

    public Task DisposeAsync()
    {
        db.Dispose();
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        Directory.Delete(directory, true);
        return Task.CompletedTask;
    }

    private Task<Film> Add() =>
        repo.ImportMediaAsync(
            new()
            {
                LibraryId = "lib",
                Path = Path.Combine(directory, "one.mp4"),
                Size = 100,
                Duration = 60,
            }
        );

    [Fact]
    public async Task RescanPreservesIdentityAndPlaybackProgress()
    {
        var original = await Add();
        await repo.UpdateMediaAsync(original.Id, f => f with { Position = 12 });
        var rescanned = await Add();
        Assert.Equal(original.Id, rescanned.Id);
        Assert.Equal(12, rescanned.Position);
    }

    [Fact]
    public async Task MediaUpdatesCannotChangeIdentity()
    {
        var f = await Add();
        await Assert.ThrowsAsync<ArgumentException>(() =>
            repo.UpdateMediaAsync(f.Id, x => x with { Path = "different.mp4" })
        );
        Assert.Equal(f.Path, (await repo.GetMediaAsync(f.Id)).Path);
    }

    [Fact]
    public async Task RemoveLibraryDoesNotDeleteMedia()
    {
        var f = await Add();
        await File.WriteAllTextAsync(f.Path, "data");
        var removal = await new Vroom.Core.Tagging.TagEngine(repo).RemoveLibraryAsync("lib");
        Assert.True(File.Exists(removal["archive"]!.GetValue<string>()));
        await Assert.ThrowsAsync<KeyNotFoundException>(() => repo.GetMediaAsync(f.Id));
        Assert.True(File.Exists(f.Path));
    }
}

public sealed class ByteRangeTests
{
    [Theory]
    [InlineData("bytes=0-0", 100, 0, 0)]
    [InlineData("bytes=90-", 100, 90, 99)]
    [InlineData("bytes=-10", 100, 90, 99)]
    [InlineData("bytes=0-999", 100, 0, 99)]
    [InlineData("bytes=-999", 100, 0, 99)]
    public void SupportsBrowserRanges(string header, long length, long start, long end)
    {
        Assert.True(ByteRange.TryParse(header, length, out var range));
        Assert.Equal(start, range.Start);
        Assert.Equal(end, range.End);
    }

    [Theory]
    [InlineData("bytes=100-", 100)]
    [InlineData("bytes=-0", 100)]
    [InlineData("bytes=10-5", 100)]
    [InlineData("bytes=0-1,3-4", 100)]
    [InlineData("bytes=0-", 0)]
    public void InvalidRangesAreRejected(string header, long length) =>
        Assert.False(ByteRange.TryParse(header, length, out _));
}
