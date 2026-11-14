using Vroom.Core.Catalog;
using Vroom.Core.Domain;
using Vroom.Core.Jobs;
using Vroom.Core.Media;
using Vroom.Core.Storage;
using Vroom.Core.Tagging;

namespace Vroom.Tests;

public sealed class IncrementalScanTests : IAsyncLifetime
{
    private readonly string directory = Path.Combine(Path.GetTempPath(), "vroom-tests", Guid.NewGuid().ToString("N"));
    private CatalogDatabase db = null!;
    private CatalogRepository repo = null!;
    private Library library = null!;

    public async Task InitializeAsync()
    {
        Directory.CreateDirectory(directory);
        db = new(Path.Combine(directory, "data"));
        repo = new(db);
        await repo.InitializeAsync();
        library = new("lib", "Library", [Path.Combine(directory, "media")], [], AutoEnrich: false, ProbeOnScan: false);
        Directory.CreateDirectory(library.Roots[0]);
        await repo.SaveLibraryAsync(library);
    }

    public Task DisposeAsync()
    {
        db.Dispose();
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        Directory.Delete(directory, true);
        return Task.CompletedTask;
    }

    private LibraryScanner Scanner(JobCoordinator jobs)
    {
        var engine = new TagEngine(repo);
        return new(repo, new FfmpegService(repo), jobs, engine, new TagSources(engine));
    }

    private Task<ScanSummary> Scan(LibraryScanner scanner) =>
        scanner.ScanAsync(library, new InlineProgress<(int, string)>(_ => { }), CancellationToken.None);

    private async Task<long> HistoryCount() =>
        await db.ReadAsync(c => Convert.ToInt64(c.Scalar("SELECT COUNT(*) FROM tag_history")));

    [Fact]
    public async Task UnchangedFilesAreNotRewrittenAndOnlyChangedFilesAreReindexed()
    {
        var root = library.Roots[0];
        await File.WriteAllTextAsync(Path.Combine(root, "a.mp4"), "first");
        Directory.CreateDirectory(Path.Combine(root, "nested"));
        await File.WriteAllTextAsync(Path.Combine(root, "nested", "b.mp4"), "second");
        var engine = new TagEngine(repo);
        await using var jobs = new JobCoordinator(db);
        using var scanner = new LibraryScanner(repo, new FfmpegService(repo), jobs, engine, new TagSources(engine));

        var first = await Scan(scanner);
        Assert.Equal(2, first.Added);
        var history = await HistoryCount();
        var events = await db.ReadAsync(c => Convert.ToInt64(c.Scalar("SELECT COUNT(*) FROM tag_events")));

        var second = await Scan(scanner);
        Assert.Equal(2, second.Unchanged);
        Assert.Equal(0, second.Added + second.Changed);
        Assert.Equal(history, await HistoryCount());
        Assert.Equal(events, await db.ReadAsync(c => Convert.ToInt64(c.Scalar("SELECT COUNT(*) FROM tag_events"))));

        await File.WriteAllTextAsync(Path.Combine(root, "a.mp4"), "first, but longer");
        var third = await Scan(scanner);
        Assert.Equal(1, third.Changed);
        Assert.Equal(1, third.Unchanged);
    }

    [Fact]
    public async Task FilesAbsentFromACompleteRootAreMarkedMissingAndRecoverWhenTheyReturn()
    {
        var path = Path.Combine(library.Roots[0], "gone.mp4");
        await File.WriteAllTextAsync(path, "content");
        await using var jobs = new JobCoordinator(db);
        using var scanner = Scanner(jobs);
        await Scan(scanner);
        var stash = Path.Combine(directory, "stash.mp4");
        File.Move(path, stash);
        Assert.Equal(1, (await Scan(scanner)).Missing);
        var index = await repo.LibraryIndexAsync(library.Id);
        Assert.True(Assert.Single(index.Values).Missing);
        File.Move(stash, path);
        Assert.Equal(0, (await Scan(scanner)).Missing);
        Assert.False(Assert.Single((await repo.LibraryIndexAsync(library.Id)).Values).Missing);
    }

    [Fact]
    public async Task UnreachableRootNeverMarksFilesMissing()
    {
        await File.WriteAllTextAsync(Path.Combine(library.Roots[0], "kept.mp4"), "content");
        await using var jobs = new JobCoordinator(db);
        using var scanner = Scanner(jobs);
        await Scan(scanner);
        Directory.Move(library.Roots[0], library.Roots[0] + "-offline");
        await Assert.ThrowsAsync<IOException>(() => Scan(scanner));
        Assert.False(Assert.Single((await repo.LibraryIndexAsync(library.Id)).Values).Missing);
        Directory.Move(library.Roots[0] + "-offline", library.Roots[0]);
    }

    [Fact]
    public async Task RelativePathFactIsTheSameForScanAndRecalculation()
    {
        var nested = Path.Combine(library.Roots[0], "Studio Name", "clip.mp4");
        Directory.CreateDirectory(Path.GetDirectoryName(nested)!);
        await File.WriteAllTextAsync(nested, "content");
        await using var jobs = new JobCoordinator(db);
        using var scanner = Scanner(jobs);
        await Scan(scanner);
        var film = (await repo.LibraryIndexAsync(library.Id)).Values.Single();
        var facts = TagEngine.Facts(await repo.GetMediaAsync(film.FilmId));
        Assert.Equal(Path.Combine("Studio Name", "clip.mp4"), facts["file"]!["relativePath"]!.GetValue<string>());
    }

    [Fact]
    public async Task SampledFingerprintCoversSmallFilesCompletelyAndDetectsContentChanges()
    {
        var path = Path.Combine(directory, "sample.bin");
        await File.WriteAllBytesAsync(path, new byte[1024 * 1024]);
        var original = await ContentFingerprint.ComputeAsync(path);
        Assert.StartsWith("s1:", original.Fingerprint);
        await using (var stream = new FileStream(path, FileMode.Open))
        {
            stream.Position = 512 * 1024;
            stream.WriteByte(1);
        }
        Assert.NotEqual(original.Fingerprint, (await ContentFingerprint.ComputeAsync(path)).Fingerprint);
        Assert.Equal([0L, 524288L - 32768L, 1048576L - 65536L], ContentFingerprint.Offsets(1024 * 1024).ToArray());
        Assert.Equal([0L, 65536L], ContentFingerprint.Offsets(100_000).ToArray());
    }

    [Theory]
    [InlineData("$RECYCLE.BIN", "$recycle.bin/a.mp4", true)]
    [InlineData("temp", "Contemporary/a.mp4", false)]
    [InlineData("temp", "Movies/Temp/a.mp4", true)]
    [InlineData("*.part.mp4", "x/y/z.part.mp4", true)]
    [InlineData("samples/**", "samples/a/b.mp4", true)]
    [InlineData("samples/*", "other/samples-x.mp4", false)]
    public void ExclusionRulesMatchSegmentsAndGlobsRelativeToTheRoot(string rule, string path, bool excluded) =>
        Assert.Equal(excluded, new ExcludeMatcher([rule]).Excludes(path));

    [Fact]
    public void RuntimeToolsResolveAtUseTimeAndIgnoreMissingCustomPaths()
    {
        var runtime = Path.Combine(directory, "runtime");
        var ffmpeg = Path.Combine(runtime, "ffmpeg", OperatingSystem.IsWindows() ? "ffmpeg.exe" : "ffmpeg");
        Directory.CreateDirectory(Path.GetDirectoryName(ffmpeg)!);
        File.WriteAllText(ffmpeg, "");
        var previous = MediaRuntime.Directory;
        try
        {
            MediaRuntime.Directory = runtime;
            Assert.Equal(ToolSource.Bundled, MediaRuntime.Resolve(new AppSettings()).Ffmpeg.Source);
            var stale = new AppSettings { FfmpegPath = Path.Combine(directory, "old-release", "ffmpeg.exe") };
            Assert.Equal(Path.GetFullPath(ffmpeg), MediaRuntime.Resolve(stale).Ffmpeg.Path);
            Assert.Equal(ToolSource.SystemPath, MediaRuntime.Resolve(new AppSettings()).Ffprobe.Source);
            Assert.Equal(ToolSource.Missing, MediaRuntime.Resolve(new AppSettings()).Model.Source);
        }
        finally
        {
            MediaRuntime.Directory = previous;
        }
    }
}

public sealed class LibraryRootTests : IAsyncLifetime
{
    private readonly string directory = Path.Combine(Path.GetTempPath(), "vroom-tests", Guid.NewGuid().ToString("N"));
    private CatalogDatabase db = null!;
    private CatalogRepository repo = null!;

    public async Task InitializeAsync()
    {
        db = new(directory);
        repo = new(db);
        await repo.InitializeAsync();
    }

    public Task DisposeAsync()
    {
        db.Dispose();
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        Directory.Delete(directory, true);
        return Task.CompletedTask;
    }

    [Fact]
    public async Task LibraryRootsMustBeAbsoluteAndMayNotOverlapAnotherLibrary()
    {
        var media = Path.Combine(directory, "media");
        await repo.SaveLibraryAsync(new("a", "A", [media], []));
        var relative = await Assert.ThrowsAsync<ArgumentException>(() =>
            repo.SaveLibraryAsync(new("b", "B", ["videos"], []))
        );
        Assert.Equal("host.CatalogRepository.libraryRootNotAbsolute", relative.Message);
        foreach (var root in new[] { media, Path.Combine(media, "nested"), directory })
            Assert.Equal(
                "host.CatalogRepository.libraryRootsOverlap",
                (
                    await Assert.ThrowsAsync<ArgumentException>(() => repo.SaveLibraryAsync(new("b", "B", [root], [])))
                ).Message
            );
        await repo.SaveLibraryAsync(new("b", "B", [Path.Combine(directory, "media-other")], []));
        // Re-saving a library with its own roots is not an overlap.
        await repo.SaveLibraryAsync(new("a", "Renamed", [media], []));
    }
}
