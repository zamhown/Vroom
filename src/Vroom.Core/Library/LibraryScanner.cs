using System.Text.Json.Nodes;
using System.Threading.Channels;
using Vroom.Core.Application;
using Vroom.Core.Domain;
using Vroom.Core.Jobs;
using Vroom.Core.Media;
using Vroom.Core.Storage;
using Vroom.Core.Tagging;

namespace Vroom.Core.Catalog;

public sealed record ScanSummary(int Discovered, int Added, int Changed, int Unchanged, int Missing, int Failed);

/// <summary>
/// Incremental library indexing. Unchanged files (same path, size and modification time with a
/// captured fingerprint) cost one directory entry and no database write. New or changed files are
/// written in batches, fingerprinted from small samples and handed to <see cref="MediaPipeline"/>.
/// After a complete pass over a reachable root, files that were not seen are marked missing.
/// </summary>
public sealed class LibraryScanner : IDisposable, IAsyncDisposable
{
    private const int BatchSize = 64;
    private readonly CatalogRepository repository;
    private readonly JobCoordinator jobs;
    private readonly TagEngine tagging;
    private readonly AdjustableInterval scanInterval = new();
    private readonly CancellationTokenSource lifetime = new();
    private Task? scheduler;

    public MediaPipeline Pipeline { get; }

    public LibraryScanner(
        CatalogRepository repository,
        FfmpegService media,
        JobCoordinator jobs,
        TagEngine tagging,
        TagSources sources
    )
    {
        this.repository = repository;
        this.jobs = jobs;
        this.tagging = tagging;
        Pipeline = new MediaPipeline(repository, media, jobs, tagging, sources);
        repository.SettingsChanged += SettingsChanged;
        jobs.Register(
            "library.scan",
            async (context, payload) =>
            {
                var library = CatalogRepository.Deserialize<Library>(payload.GetRawText());
                var summary = await ScanCoreAsync(
                    library,
                    (count, detail) => context.ReportAsync(count, null, detail),
                    context,
                    context.CancellationToken
                );
                return new { libraryId = library.Id, summary };
            },
            canPause: true,
            canRetry: true
        );
        jobs.Register(
            "library.import",
            async (context, payload) =>
            {
                var args = JsonNode.Parse(payload.GetRawText())!;
                var library = (await repository.LibrariesAsync(context.CancellationToken)).Single(l =>
                    l.Id == args.Text("libraryId")
                );
                var paths = args.List("paths").Select(p => p!.ToString()).ToArray();
                var batch = new Batch(this, library, context);
                foreach (var path in paths)
                {
                    await context.CheckpointAsync();
                    try
                    {
                        var info = await Task.Run(() => new FileInfo(path), context.CancellationToken);
                        await batch.AddAsync(info, Path.GetFileName(path), null, context.CancellationToken);
                    }
                    catch (Exception ex) when (ex is not OperationCanceledException)
                    {
                        batch.Fail(path, ex.Message);
                    }
                    await context.ReportAsync(batch.Seen, paths.Length, "host.Journey.importing");
                }
                await batch.FlushAsync(context.CancellationToken);
                await Pipeline.StartAsync(library, context.CancellationToken);
                if (batch.Errors.Count > 0)
                    throw new IOException(string.Join(Environment.NewLine, batch.Errors));
                return new
                {
                    libraryId = library.Id,
                    count = batch.Seen,
                    summary = batch.Summary(0),
                };
            },
            canPause: true,
            canRetry: true
        );
    }

    public static IReadOnlySet<string> Extensions => MediaFormats.VideoExtensions;

    private void SettingsChanged(AppSettings settings) => scanInterval.Change(Interval(settings));

    private static TimeSpan Interval(AppSettings settings) =>
        settings.ScanIntervalMinutes <= 0
            ? Timeout.InfiniteTimeSpan
            : TimeSpan.FromMinutes(Math.Clamp(settings.ScanIntervalMinutes, 15, 10080));

    public Task<string> StartAsync(Library library) =>
        jobs.StartAsync(
            "library.scan",
            UiMessage.Of("host.LibraryScanner.scan", library.Name),
            library,
            "scan:" + library.Id
        );

    public async Task<object> ImportAsync(JsonObject args, CancellationToken ct = default)
    {
        var paths = args.List("paths")
            .Select(p => Path.GetFullPath(p!.ToString()))
            .Distinct(CatalogRepository.PathComparer)
            .ToArray();
        if (paths.Length == 0 || paths.Length > 10000)
            throw new ArgumentException("host.Journey.chooseSources");
        if (args.Text("kind") is not ("files" or "folder"))
            throw new ArgumentException("host.Journey.invalidImportKind");
        var folder = args.Text("kind") == "folder";
        if (!folder && paths.Any(p => !Extensions.Contains(Path.GetExtension(p))))
            throw new ArgumentException("host.Journey.unsupportedFile");
        var existing = (await repository.LibrariesAsync(ct)).FirstOrDefault(l => l.Id == args.Text("libraryId"));
        if (args.Text("libraryId").Length > 0 && existing is null)
            throw new ArgumentException("host.Journey.libraryMissing");
        var library = existing is null
            ? Library.Create(
                args.Text("name", LibraryName(paths, folder)),
                folder ? paths : [],
                args.List("excludes").Select(p => p!.GetValue<string>()),
                args["autoEnrich"] is null ? null : args.Flag("autoEnrich"),
                args["probeOnScan"] is null ? null : args.Flag("probeOnScan")
            )
            : existing with
            {
                Roots = folder
                    ? existing.Roots.Concat(paths).Distinct(CatalogRepository.PathComparer).ToArray()
                    : existing.Roots,
            };
        await repository.SaveLibraryAsync(library, ct);
        var job = folder
            ? await StartAsync(library with { Roots = paths })
            : await jobs.StartAsync(
                "library.import",
                "host.Journey.importing",
                new { libraryId = library.Id, paths },
                "import:" + library.Id
            );
        return new { libraryId = library.Id, jobId = job };
    }

    // A folder library is named after its folder; a set of files after the folder that contains them.
    private static string LibraryName(string[] paths, bool folder) =>
        Path.GetFileName(
            (folder ? paths[0] : Path.GetDirectoryName(paths[0]) ?? paths[0]).TrimEnd(
                Path.DirectorySeparatorChar,
                Path.AltDirectorySeparatorChar
            )
        )
            is { Length: > 0 } name
            ? name
            : paths[0];

    public void StartAutoDiscovery()
    {
        scheduler ??= Task.Run(async () =>
        {
            var settings = await repository.SettingsAsync(lifetime.Token);
            if (settings.ScanOnStartup)
                await ScanAllAsync();
            while (!lifetime.IsCancellationRequested)
            {
                try
                {
                    settings = await repository.SettingsAsync(lifetime.Token);
                    await scanInterval.WaitAsync(Interval(settings), lifetime.Token);
                    await ScanAllAsync();
                }
                catch (OperationCanceledException) when (lifetime.IsCancellationRequested)
                {
                    break;
                }
                catch (Exception)
                {
                    await Task.Delay(TimeSpan.FromMinutes(1), lifetime.Token);
                }
            }
        });
    }

    private async Task ScanAllAsync()
    {
        foreach (var library in (await repository.LibrariesAsync(lifetime.Token)).Where(l => l.Roots.Length > 0))
            if (jobs.ActiveByResource("scan:" + library.Id) is null)
                await StartAsync(library);
    }

    public Task<ScanSummary> ScanAsync(
        Library library,
        IProgress<(int Count, string Detail)> progress,
        CancellationToken ct
    ) =>
        ScanCoreAsync(
            library,
            (count, detail) =>
            {
                progress.Report((count, detail.Id));
                return Task.CompletedTask;
            },
            null,
            ct
        );

    private async Task<ScanSummary> ScanCoreAsync(
        Library library,
        Func<int, UiMessage, Task> report,
        JobContext? context,
        CancellationToken ct
    )
    {
        await tagging.InitializeAsync(ct);
        var excludes = new ExcludeMatcher(library.Excludes);
        var files = Channel.CreateBounded<(string Root, FileInfo File)>(
            new BoundedChannelOptions(256)
            {
                FullMode = BoundedChannelFullMode.Wait,
                SingleWriter = true,
                SingleReader = true,
            }
        );
        using var scope = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var batch = new Batch(this, library, context);
        var completeRoots = new List<string>();
        var producer = Task.Run(
            async () =>
            {
                try
                {
                    var visited = new HashSet<string>(CatalogRepository.PathComparer);
                    foreach (var root in library.Roots)
                    {
                        if (!Directory.Exists(root))
                        {
                            batch.Fail(root, "host.LibraryScanner.rootUnavailable");
                            continue;
                        }
                        var complete = true;
                        var pending = new Stack<DirectoryInfo>();
                        pending.Push(new DirectoryInfo(root));
                        while (pending.TryPop(out var directory))
                        {
                            scope.Token.ThrowIfCancellationRequested();
                            if (context is not null)
                                await context.WaitForPermissionAsync();
                            if (!visited.Add(directory.FullName))
                                continue;
                            try
                            {
                                foreach (var entry in directory.EnumerateFileSystemInfos())
                                {
                                    scope.Token.ThrowIfCancellationRequested();
                                    if ((entry.Attributes & FileAttributes.ReparsePoint) != 0)
                                        continue;
                                    if (excludes.Excludes(Path.GetRelativePath(root, entry.FullName)))
                                        continue;
                                    if (entry is DirectoryInfo child)
                                        pending.Push(child);
                                    else if (entry is FileInfo file && Extensions.Contains(file.Extension))
                                        await files.Writer.WriteAsync((root, file), scope.Token);
                                }
                            }
                            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                            {
                                complete = false;
                                batch.Fail(directory.FullName, ex.Message);
                            }
                        }
                        if (complete)
                            lock (completeRoots)
                                completeRoots.Add(root);
                    }
                    files.Writer.TryComplete();
                }
                catch (Exception ex)
                {
                    files.Writer.TryComplete(ex);
                    throw;
                }
            },
            scope.Token
        );
        try
        {
            await batch.LoadIndexAsync(scope.Token);
            await foreach (var (root, file) in files.Reader.ReadAllAsync(scope.Token))
            {
                if (context is not null)
                    await context.CheckpointAsync();
                try
                {
                    await batch.AddAsync(file, Path.GetRelativePath(root, file.FullName), root, scope.Token);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    batch.Fail(file.FullName, ex.Message);
                }
                if (batch.Seen % 50 == 0)
                    await report(batch.Seen, UiMessage.Of("host.LibraryScanner.progress", batch.Seen, batch.Added));
            }
            await producer;
            await batch.FlushAsync(scope.Token);
            var missing = await batch.MarkMissingAsync(completeRoots, excludes, scope.Token);
            await Pipeline.StartAsync(library, scope.Token);
            var summary = batch.Summary(missing);
            await report(
                batch.Seen,
                UiMessage.Of(
                    "host.LibraryScanner.finished",
                    summary.Discovered,
                    summary.Added + summary.Changed,
                    missing
                )
            );
            if (batch.Errors.Count > 0)
                throw new IOException("host.LibraryScanner.scanSavedRecordsItemsRemainIncomplete").Localize(
                    "host.LibraryScanner.scanSavedRecordsItemsRemainIncomplete",
                    batch.Seen,
                    batch.Errors.Count,
                    string.Join("；", batch.Errors.Take(3))
                );
            return summary;
        }
        finally
        {
            scope.Cancel();
            // Observe producer errors. A blocked NAS kernel enumeration cannot be forcefully cancelled;
            // keep the library gate until it returns rather than accumulating abandoned scan threads.
            try
            {
                await producer;
            }
            catch (OperationCanceledException) { }
            catch when (ct.IsCancellationRequested) { }
        }
    }

    /// <summary>Accumulates discovered files and writes them in batches.</summary>
    private sealed class Batch(LibraryScanner scanner, Library library, JobContext? context)
    {
        private readonly List<(Film Film, bool Known)> pending = [];
        private readonly HashSet<string> seenKeys = new(StringComparer.Ordinal);
        private readonly List<string> reappeared = [];
        private IReadOnlyDictionary<string, IndexedFile>? index;
        public List<string> Errors { get; } = [];
        public int Seen { get; private set; }
        public int Added { get; private set; }
        private int changed,
            unchanged;

        public async Task LoadIndexAsync(CancellationToken ct) =>
            index ??= await scanner.repository.LibraryIndexAsync(library.Id, ct);

        public void Fail(string path, string message)
        {
            lock (Errors)
                Errors.Add(path + ": " + message);
        }

        public async Task AddAsync(FileInfo file, string relativePath, string? root, CancellationToken ct)
        {
            await LoadIndexAsync(ct);
            Seen++;
            if (!file.Exists)
                throw new FileNotFoundException("host.Journey.mediaOffline");
            var key = CatalogRepository.PathKeyOf(file.FullName);
            seenKeys.Add(key);
            var modified = new DateTimeOffset(file.LastWriteTimeUtc, TimeSpan.Zero);
            if (
                index!.TryGetValue(key, out var known)
                && known.Size == file.Length
                && known.Modified == modified
                && known.HasFingerprint
            )
            {
                unchanged++;
                if (known.Missing)
                    reappeared.Add(known.FileId);
                return;
            }
            pending.Add(
                (
                    new Film
                    {
                        LibraryId = library.Id,
                        Path = file.FullName,
                        Size = file.Length,
                        Modified = modified,
                        RelativePath = relativePath,
                    },
                    index.ContainsKey(key)
                )
            );
            if (pending.Count >= BatchSize)
                await FlushAsync(ct);
        }

        public async Task FlushAsync(CancellationToken ct)
        {
            await scanner.repository.SetMissingAsync(reappeared, false, ct);
            reappeared.Clear();
            if (pending.Count == 0)
                return;
            var items = pending.ToArray();
            pending.Clear();
            var films = await scanner.repository.ImportMediaBatchAsync(items.Select(i => i.Film).ToArray(), ct);
            var fingerprints = new List<(string, long, DateTimeOffset, string)>();
            foreach (var film in films)
            {
                if (context is not null)
                    await context.CheckpointAsync();
                try
                {
                    var fingerprint = await ContentFingerprint.ComputeAsync(film.Path, ct);
                    if (fingerprint.Size == film.Size && fingerprint.Modified == film.Modified)
                        fingerprints.Add((film.FileId!, film.Size, film.Modified, fingerprint.Fingerprint));
                }
                catch (Exception ex)
                    when (ex is IOException or UnauthorizedAccessException or InvalidOperationException)
                {
                    // The file stays indexed without identity; the next scan retries the capture.
                }
            }
            await scanner.repository.SetFingerprintsAsync(fingerprints, ct);
            await scanner.tagging.RecordMediaEventsAsync(
                films
                    .Select(film => new MediaEvent(
                        "film.discovered",
                        film.Id,
                        new JsonObject { ["partId"] = film.PartId },
                        "discover:" + film.Id + ":" + TagEngine.MediaRevision(film)
                    ))
                    .ToArray(),
                ct
            );
            var probe = library.ProbeOnScan || await scanner.tagging.RequiresProbeAsync(ct);
            var work = new List<MediaWork>();
            foreach (var film in films)
            {
                if (probe && film.ProbeState != "ready")
                    work.Add(new(film.Id, film.PartId!, MediaPipeline.Probe));
                if (library.AutoEnrich)
                    work.Add(new(film.Id, film.PartId!, MediaPipeline.Enrich));
            }
            await scanner.Pipeline.EnqueueAsync(library, work, ct);
            Added += items.Count(i => !i.Known);
            changed += items.Count(i => i.Known);
        }

        public async Task<int> MarkMissingAsync(
            IReadOnlyCollection<string> completeRoots,
            ExcludeMatcher excludes,
            CancellationToken ct
        )
        {
            if (index is null || completeRoots.Count == 0)
                return 0;
            var comparison = OperatingSystem.IsWindows()
                ? StringComparison.OrdinalIgnoreCase
                : StringComparison.Ordinal;
            var missing = index
                .Where(entry => !entry.Value.Missing && !seenKeys.Contains(entry.Key))
                .Where(entry =>
                    completeRoots.Any(root =>
                        entry.Value.Path.StartsWith(
                            Path.TrimEndingDirectorySeparator(root) + Path.DirectorySeparatorChar,
                            comparison
                        ) && !excludes.Excludes(Path.GetRelativePath(root, entry.Value.Path))
                    )
                )
                .Select(entry => entry.Value.FileId)
                .Distinct()
                .ToArray();
            await scanner.repository.SetMissingAsync(missing, true, ct);
            return missing.Length;
        }

        public ScanSummary Summary(int missing) => new(Seen, Added, changed, unchanged, missing, Errors.Count);
    }

    public void Dispose()
    {
        repository.SettingsChanged -= SettingsChanged;
        lifetime.Cancel();
    }

    public async ValueTask DisposeAsync()
    {
        Dispose();
        if (scheduler is not null)
            try
            {
                await scheduler;
            }
            catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
    }
}
