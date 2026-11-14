using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Vroom.Core.Application;
using Vroom.Core.Domain;
using Vroom.Core.Jobs;
using Vroom.Core.Storage;
using Vroom.Core.Tagging;

namespace Vroom.Core.Media;

public sealed record PlaybackSource(
    string Url,
    bool Transcoded,
    double Offset,
    string? SessionId,
    string? JobId = null,
    string Pipeline = "direct",
    string Description = "host.LocalMediaServer.originalFile",
    double StartupMs = 0
);

public sealed record PlaybackStatus(double ReadyUntil, double Speed, bool Finished, string Pipeline, string? Error);

/// <summary>Loopback-only capability URLs. The client never supplies a filesystem path.</summary>
public sealed class LocalMediaServer : IAsyncDisposable
{
    private readonly CatalogRepository repository;
    private readonly FfmpegService ffmpeg;
    private readonly JobCoordinator? jobs;
    private readonly TagEngine? tagging;

    public LocalMediaServer(
        CatalogRepository repository,
        FfmpegService ffmpeg,
        JobCoordinator? jobs = null,
        TagEngine? tagging = null
    )
    {
        this.repository = repository;
        this.ffmpeg = ffmpeg;
        this.jobs = jobs;
        this.tagging = tagging;
        jobs?.Register(
            "media.transcode",
            async (context, args) =>
            {
                PlaybackSource? source = null;
                try
                {
                    await context.ReportAsync(0, null, "host.LocalMediaServer.preparingFfmpegPlaybackStream");
                    source = (
                        await OpenCoreAsync(
                            args.GetProperty("id").GetString()!,
                            true,
                            args.GetProperty("start").GetDouble(),
                            context.CancellationToken,
                            args.TryGetProperty("forceEncode", out var force) && force.GetBoolean(),
                            args.TryGetProperty("options", out var options)
                                ? options.Deserialize<PlaybackOptions>(CatalogRepository.Json)
                                : null,
                            args.TryGetProperty("partId", out var part) && part.ValueKind == JsonValueKind.String
                                ? part.GetString()
                                : null
                        )
                    ) with
                    {
                        JobId = context.Id,
                    };
                    sessions[source.SessionId!].JobId = context.Id;
                    await context.PublishResultAsync(source);
                    var film = await repository.GetMediaAsync(
                        args.GetProperty("id").GetString()!,
                        context.CancellationToken
                    );
                    while (sessions.TryGetValue(source.SessionId!, out var session) && !session.Process.HasExited)
                    {
                        await context.ReportAsync(
                            (int)(source.Offset + session.Seconds),
                            film.Duration > 0 ? (int)film.Duration : null,
                            UiMessage.Of("host.LocalMediaServer.preparedSeconds", session.Seconds)
                        );
                        await Task.Delay(1000, context.CancellationToken);
                    }
                    if (
                        sessions.TryGetValue(source.SessionId!, out var finished)
                        && finished.Process.HasExited
                        && finished.Process.ExitCode != 0
                    )
                        throw new IOException("host.LocalMediaServer.transcodingProcessExited").Localize(
                            "host.LocalMediaServer.transcodingProcessExited",
                            finished.Error
                        );
                    return source;
                }
                finally
                {
                    if (context.CancellationToken.IsCancellationRequested && source is not null)
                        await StopCoreAsync(source.SessionId);
                }
            },
            usesWorker: false
        );
    }

    private readonly TcpListener listener = new(IPAddress.Loopback, 0);
    private readonly string secret = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
    private readonly CancellationTokenSource lifetime = new();
    private readonly SemaphoreSlim startGate = new(1, 1);
    private readonly SemaphoreSlim connections = new(16, 16);
    private readonly SemaphoreSlim transcodes = new(2, 2);
    private readonly ConcurrentDictionary<string, Transcode> sessions = new();
    private Task? acceptLoop;
    private Task? cleanupLoop;
    public string BaseUrl { get; private set; } = "";

    public async Task StartAsync(CancellationToken ct = default)
    {
        await startGate.WaitAsync(ct);
        try
        {
            if (acceptLoop is not null)
                return;
            listener.Start();
            BaseUrl = $"http://127.0.0.1:{((IPEndPoint)listener.LocalEndpoint).Port}/{secret}";
            acceptLoop = AcceptAsync();
            cleanupLoop = Task.Run(async () =>
            {
                using var timer = new PeriodicTimer(TimeSpan.FromSeconds(30));
                try
                {
                    while (await timer.WaitForNextTickAsync(lifetime.Token))
                        foreach (var item in sessions)
                            if (DateTimeOffset.UtcNow - item.Value.LastAccess > TimeSpan.FromMinutes(3))
                                await StopPlaybackAsync(item.Key);
                }
                catch (OperationCanceledException) { }
            });
        }
        finally
        {
            startGate.Release();
        }
    }

    public string PosterUrl(string filmId) => $"{BaseUrl}/poster/{Uri.EscapeDataString(filmId)}";

    public string ThumbnailUrl(string filmId, double time) =>
        $"{BaseUrl}/thumb/{Uri.EscapeDataString(filmId)}?at={time.ToString(CultureInfo.InvariantCulture)}";

    public async Task<bool> IsAvailableAsync(string filmId, CancellationToken ct = default, string? partId = null)
    {
        var film = await repository.GetMediaPartAsync(filmId, partId, ct);
        try
        {
            // Opening a disconnected mount can block synchronously. Keep it off the UI thread
            // and bound the request; disposal still happens if the OS completes it late.
            return await Task.Run(
                    () =>
                    {
                        using var file = new FileStream(
                            film.Path,
                            FileMode.Open,
                            FileAccess.Read,
                            FileShare.ReadWrite | FileShare.Delete
                        );
                        return true;
                    },
                    ct
                )
                .WaitAsync(TimeSpan.FromSeconds(8), ct);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or TimeoutException)
        {
            return false;
        }
    }

    public async Task<PlaybackSource> OpenAsync(
        string filmId,
        bool transcode,
        double start = 0,
        CancellationToken ct = default,
        string? partId = null
    )
    {
        if (!transcode || jobs is null)
            return await OpenCoreAsync(filmId, transcode, start, ct, partId: partId);
        var jobId = await StartTranscodeAsync(filmId, start, partId: partId);
        try
        {
            while (true)
            {
                var job = jobs.Get(jobId);
                if (job.State is JobState.Failed or JobState.Cancelled or JobState.Interrupted)
                    throw new IOException(job.Error ?? job.Detail);
                if (job.ResultJson is not null)
                    return CatalogRepository.Deserialize<PlaybackSource>(job.ResultJson);
                if (JobCoordinator.IsTerminal(job.State))
                    throw new IOException(job.Error ?? job.Detail);
                await Task.Delay(100, ct);
            }
        }
        catch (OperationCanceledException)
        {
            await jobs.StopAsync(jobId);
            throw;
        }
    }

    public Task<string> StartTranscodeAsync(
        string filmId,
        double start,
        bool forceEncode = false,
        PlaybackOptions? options = null,
        string? partId = null
    ) =>
        jobs?.StartAsync(
            "media.transcode",
            "host.LocalMediaServer.prepareSmoothPlayback",
            new
            {
                id = filmId,
                start,
                forceEncode,
                options,
                partId,
            }
        ) ?? throw new InvalidOperationException("host.LocalMediaServer.taskServiceIsUnavailable");

    public async Task<ProbeResult> InspectAsync(string filmId, CancellationToken ct = default, string? partId = null) =>
        await ffmpeg.ProbeAsync((await repository.GetMediaPartAsync(filmId, partId, ct)).Path, ct);

    private readonly SemaphoreSlim previewReaders = new(2, 2);

    public async Task<string> PreviewAsync(
        string filmId,
        string mediaRevision,
        double position,
        CancellationToken ct = default,
        string? partId = null
    )
    {
        if (!double.IsFinite(position) || position < 0)
            throw new ArgumentException("host.ClientApi.invalidPlaybackPosition");
        var film = await repository.GetMediaPartAsync(filmId, partId, ct);
        if (TagEngine.MediaRevision(film) != mediaRevision)
            throw new TagException("STALE_MEDIA");
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(10));
        await previewReaders.WaitAsync(deadline.Token);
        try
        {
            var settings = await repository.SettingsAsync(deadline.Token);
            var at = film.Duration > 0 ? Math.Min(position, Math.Max(0, film.Duration - .1)) : position;
            using var process = FfmpegService.Start(
                MediaRuntime.Ffmpeg(settings),
                [
                    "-v",
                    "error",
                    "-nostdin",
                    "-ss",
                    at.ToString(CultureInfo.InvariantCulture),
                    "-protocol_whitelist",
                    "file,pipe,crypto",
                    "-i",
                    film.Path,
                    "-an",
                    "-sn",
                    "-frames:v",
                    "1",
                    "-vf",
                    "scale=960:-2",
                    "-threads",
                    "2",
                    "-c:v",
                    "mjpeg",
                    "-q:v",
                    "4",
                    "-f",
                    "image2pipe",
                    "pipe:1",
                ]
            );
            using var stop = deadline.Token.Register(() => FfmpegService.Kill(process));
            var errors = process.StandardError.ReadToEndAsync(deadline.Token);
            try
            {
                using var image = new MemoryStream();
                var buffer = new byte[16384];
                int read;
                while ((read = await process.StandardOutput.BaseStream.ReadAsync(buffer, deadline.Token)) > 0)
                {
                    if (image.Length + read > 3_000_000)
                        throw new IOException("host.ClientApi.requestIsTooLarge");
                    image.Write(buffer, 0, read);
                }
                await process.WaitForExitAsync(deadline.Token);
                if (process.ExitCode != 0 || image.Length == 0)
                    throw new IOException("host.FfmpegService.unableToReadThisFrameChooseAnother");
                if (
                    TagEngine.MediaRevision(await repository.GetMediaPartAsync(filmId, film.PartId, deadline.Token))
                    != mediaRevision
                )
                    throw new TagException("STALE_MEDIA");
                return "data:image/jpeg;base64," + Convert.ToBase64String(image.ToArray());
            }
            finally
            {
                FfmpegService.Kill(process);
                try
                {
                    await errors;
                }
                catch (OperationCanceledException) { }
            }
        }
        finally
        {
            previewReaders.Release();
        }
    }

    public PlaybackStatus Status(string id)
    {
        if (!sessions.TryGetValue(id, out var state))
            throw new KeyNotFoundException("host.LocalMediaServer.playbackCacheWasReleasedStartPlaybackAgain");
        state.LastAccess = DateTimeOffset.UtcNow;
        return new(
            state.Offset + state.ReadySeconds,
            state.Speed,
            state.Process.HasExited && state.Process.ExitCode == 0,
            state.Encoder,
            state.Process.HasExited && state.Process.ExitCode != 0 ? state.Error : null
        );
    }

    private async Task<PlaybackSource> OpenCoreAsync(
        string filmId,
        bool transcode,
        double start = 0,
        CancellationToken ct = default,
        bool forceEncode = false,
        PlaybackOptions? options = null,
        string? partId = null
    )
    {
        options ??= new();
        options.Validate();
        forceEncode |= options.Deinterlace;
        if (!double.IsFinite(start) || start < 0)
            throw new ArgumentException("host.LocalMediaServer.invalidPlaybackPosition");
        await StartAsync(ct);
        var film = await repository.GetMediaPartAsync(filmId, partId, ct);
        if (!await IsAvailableAsync(filmId, ct, film.PartId))
            throw new FileNotFoundException("host.Journey.mediaOffline");
        if (!transcode)
            return new($"{BaseUrl}/media/{film.Id}/{film.PartId}", false, start, null);
        if (!await transcodes.WaitAsync(0, ct))
            throw new InvalidOperationException("host.LocalMediaServer.twoTranscodingSessionsAreAlreadyRunningClose");
        var watch = Stopwatch.StartNew();
        var id = Guid.NewGuid().ToString("N");
        var dir = Path.Combine(repository.Database.DataDirectory, "streams", id);
        Directory.CreateDirectory(dir);
        Process? process = null;
        try
        {
            var settings = await repository.SettingsAsync(ct);
            var probe = await ffmpeg.ProbeAsync(film.Path, ct);
            options.Validate(probe);
            if (options.AudioStream is { } audioIndex)
                probe = probe with { AudioCodec = probe.Tracks!.Single(t => t.Index == audioIndex).Codec };
            if (probe.Duration > 0)
                start = Math.Min(start, Math.Max(0, probe.Duration - 0.1));
            var plan = PlaybackPipeline.Plan(probe, settings.TranscodeHeight, "libx264", forceEncode);
            if (!plan.CopyVideo)
                plan = PlaybackPipeline.Plan(
                    probe,
                    settings.TranscodeHeight,
                    await PlaybackPipeline.HardwareEncoderAsync(MediaRuntime.Ffmpeg(settings), ct),
                    forceEncode
                );
            var offset = plan.CopyVideo ? await ffmpeg.KeyframeBeforeAsync(film.Path, start, ct) : start;
            // A real file may still reject a tested hardware encoder. Retry once with the portable path before publishing a URL.
            for (var attempt = 0; ; attempt++)
            {
                var attemptDir = Path.Combine(dir, attempt.ToString(CultureInfo.InvariantCulture));
                Directory.CreateDirectory(attemptDir);
                process = FfmpegService.Start(
                    MediaRuntime.Ffmpeg(settings),
                    PlaybackPipeline.Arguments(film.Path, attemptDir, offset, probe, plan, options)
                );
                var running = process;
                var state = new Transcode(process, dir, attemptDir, plan.Encoder, offset);
                sessions[id] = state;
                state.Drain = Task.WhenAll(
                    Task.Run(async () =>
                    {
                        while (await running.StandardError.ReadLineAsync() is { } line)
                            state.Error = line.Length > 1000 ? line[..1000] : line;
                    }),
                    Task.Run(async () =>
                    {
                        while (await running.StandardOutput.ReadLineAsync() is { } line)
                        {
                            if (
                                line.StartsWith("out_time_us=")
                                && double.TryParse(line[12..], CultureInfo.InvariantCulture, out var us)
                            )
                                state.Seconds = us / 1_000_000;
                            if (
                                line.StartsWith("speed=")
                                && double.TryParse(line[6..].TrimEnd('x'), CultureInfo.InvariantCulture, out var speed)
                            )
                                state.Speed = speed;
                        }
                    })
                );
                using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
                deadline.CancelAfter(TimeSpan.FromSeconds(60));
                while (true)
                {
                    if (running.HasExited && running.ExitCode != 0)
                        break;
                    var manifest = Path.Combine(attemptDir, "index.m3u8");
                    if (File.Exists(manifest))
                    {
                        var text = await File.ReadAllTextAsync(manifest, deadline.Token);
                        state.ReadySeconds = ManifestDuration(text);
                        // A six-second initial reserve absorbs disk jitter and avoids starting on a single segment.
                        if (state.ReadySeconds >= start - offset + 6 || text.Contains("#EXT-X-ENDLIST"))
                            return new(
                                $"{BaseUrl}/hls/{id}/index.m3u8",
                                true,
                                offset,
                                id,
                                Pipeline: plan.Encoder,
                                Description: plan.Description,
                                StartupMs: watch.Elapsed.TotalMilliseconds
                            );
                    }
                    if (running.HasExited)
                        break;
                    await Task.Delay(60, deadline.Token);
                }
                await state.Drain;
                if (attempt > 0 || plan.Encoder == "libx264")
                    throw new IOException("host.LocalMediaServer.unableToPreparePlayback").Localize(
                        "host.LocalMediaServer.unableToPreparePlayback",
                        state.Error
                    );
                running.Dispose();
                plan = PlaybackPipeline.Plan(probe, settings.TranscodeHeight, "libx264", forceEncode: true);
                offset = start;
            }
        }
        catch
        {
            if (sessions.ContainsKey(id))
                await StopCoreAsync(id);
            else
            {
                if (process is not null)
                {
                    FfmpegService.Kill(process);
                    process.Dispose();
                }
                transcodes.Release();
            }
            throw;
        }
    }

    public async Task StopPlaybackAsync(string? id)
    {
        if (
            id is not null
            && jobs is not null
            && sessions.TryGetValue(id, out var session)
            && session.JobId is not null
            && !JobCoordinator.IsTerminal(jobs.Get(session.JobId).State)
        )
        {
            await jobs.StopAsync(session.JobId);
            await jobs.WaitAsync(session.JobId);
        }
        await StopCoreAsync(id);
    }

    private async Task StopCoreAsync(string? id)
    {
        if (id is null || !sessions.TryRemove(id, out var state))
            return;
        FfmpegService.Kill(state.Process);
        try
        {
            await state.Process.WaitForExitAsync();
            await state.Drain;
        }
        catch (InvalidOperationException) { }
        finally
        {
            state.Process.Dispose();
            transcodes.Release();
            // Only our randomly generated cache directory, never a library source directory.
            try
            {
                Directory.Delete(state.Directory, recursive: true);
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }

    private async Task AcceptAsync()
    {
        try
        {
            while (!lifetime.IsCancellationRequested)
            {
                await connections.WaitAsync(lifetime.Token);
                TcpClient client;
                try
                {
                    client = await listener.AcceptTcpClientAsync(lifetime.Token);
                }
                catch
                {
                    connections.Release();
                    throw;
                }
                _ = Task.Run(async () =>
                {
                    try
                    {
                        await HandleAsync(client, lifetime.Token);
                    }
                    finally
                    {
                        client.Dispose();
                        connections.Release();
                    }
                });
            }
        }
        catch (OperationCanceledException) { }
        catch (SocketException) when (lifetime.IsCancellationRequested) { }
    }

    private async Task HandleAsync(TcpClient client, CancellationToken ct)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromMinutes(30));
        var stream = client.GetStream();
        try
        {
            using var headerTimeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            headerTimeout.CancelAfter(TimeSpan.FromSeconds(10));
            var header = new List<byte>();
            var one = new byte[1];
            while (header.Count < 16384)
            {
                if (await stream.ReadAsync(one, headerTimeout.Token) == 0)
                    return;
                header.Add(one[0]);
                if (header.Count >= 4 && header[^4] == 13 && header[^3] == 10 && header[^2] == 13 && header[^1] == 10)
                    break;
            }
            if (header.Count >= 16384)
            {
                await Error(stream, 431, "Request too large", ct);
                return;
            }
            var lines = Encoding.ASCII.GetString(header.ToArray()).Split("\r\n");
            var request = lines[0].Split(' ');
            if (request.Length != 3 || request[0] is not ("GET" or "HEAD" or "OPTIONS"))
            {
                await Error(stream, 405, "Method not allowed", ct);
                return;
            }
            var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var line in lines.Skip(1))
            {
                var colon = line.IndexOf(':');
                if (colon > 0)
                    headers[line[..colon]] = line[(colon + 1)..].Trim();
            }
            var prefix = $"/{secret}/";
            if (!request[1].StartsWith(prefix, StringComparison.Ordinal))
            {
                await Error(stream, 403, "Forbidden", ct);
                return;
            }
            if (request[0] == "OPTIONS")
            {
                await Header(stream, 204, "No Content", "text/plain", 0, null, ct);
                return;
            }
            var uri = new Uri("http://127.0.0.1" + request[1]);
            var route = uri.AbsolutePath[prefix.Length..].Split('/');
            string path;
            string contentType;
            if (
                (route.Length == 2 && route[0] is "media" or "poster" or "thumb")
                || (route.Length == 3 && route[0] == "media")
            )
            {
                var film = await repository.GetMediaPartAsync(
                    route[1],
                    route.Length == 3 ? route[2] : null,
                    timeout.Token
                );
                if (route[0] == "media")
                {
                    path = film.Path;
                    contentType = Mime(path);
                }
                else if (route[0] == "poster")
                {
                    path = tagging is null ? "" : await tagging.ImagePathAsync(film.Id, timeout.Token) ?? "";
                    contentType = await AssetMimeAsync(path, timeout.Token);
                }
                else
                {
                    double.TryParse(uri.Query.Replace("?at=", ""), CultureInfo.InvariantCulture, out var seconds);
                    path = await ffmpeg.ThumbnailAsync(film, seconds, timeout.Token);
                    contentType = "image/jpeg";
                }
            }
            else if (route.Length == 2 && route[0] == "asset" && tagging is not null)
            {
                path = tagging.AssetPath(route[1]);
                contentType = await AssetMimeAsync(path, timeout.Token);
            }
            else if (route.Length == 3 && route[0] == "hls" && sessions.TryGetValue(route[1], out var session))
            {
                var name = route[2];
                if (
                    name != "index.m3u8"
                    && !(name.Length == 9 && name.EndsWith(".ts") && name[..6].All(char.IsAsciiDigit))
                )
                {
                    await Error(stream, 404, "Not found", ct);
                    return;
                }
                session.LastAccess = DateTimeOffset.UtcNow;
                path = Path.Combine(session.OutputDirectory, name);
                contentType = Mime(path);
                if (name == "index.m3u8" && File.Exists(path))
                    session.ReadySeconds = ManifestDuration(await File.ReadAllTextAsync(path, timeout.Token));
            }
            else
            {
                await Error(stream, 404, "Not found", ct);
                return;
            }
            // FileStream construction can block on a NAS; every request already runs on a worker.
            await using var file = new FileStream(
                path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete,
                1024 * 1024,
                FileOptions.Asynchronous | FileOptions.SequentialScan
            );
            var length = file.Length;
            headers.TryGetValue("Range", out var rawRange);
            if (!ByteRange.TryParse(rawRange, length, out var range))
            {
                await Header(
                    stream,
                    416,
                    "Range Not Satisfiable",
                    contentType,
                    0,
                    $"Content-Range: bytes */{length}\r\n",
                    ct
                );
                return;
            }
            await Header(
                stream,
                rawRange is null ? 200 : 206,
                rawRange is null ? "OK" : "Partial Content",
                contentType,
                Math.Max(0, range.Length),
                rawRange is null ? null : $"Content-Range: bytes {range.Start}-{range.End}/{length}\r\n",
                ct
            );
            if (request[0] == "HEAD")
                return;
            file.Seek(range.Start, SeekOrigin.Begin);
            var remaining = range.Length;
            var buffer = new byte[1024 * 1024];
            while (remaining > 0)
            {
                var read = await file.ReadAsync(
                    buffer.AsMemory(0, (int)Math.Min(buffer.Length, remaining)),
                    timeout.Token
                );
                if (read == 0)
                    break;
                await stream.WriteAsync(buffer.AsMemory(0, read), timeout.Token);
                remaining -= read;
            }
        }
        catch (Exception ex)
            when (ex is FileNotFoundException or DirectoryNotFoundException or KeyNotFoundException or ArgumentException
            )
        {
            try
            {
                await Error(stream, 404, "Not found", ct);
            }
            catch (IOException) { }
        }
        catch (Exception ex)
            when (ex is IOException or OperationCanceledException or SocketException or UnauthorizedAccessException)
        { /* Disconnect cancels this stream only. */
        }
        catch
        {
            try
            {
                await Error(stream, 500, "Media unavailable", ct);
            }
            catch { }
        }
    }

    private static Task Error(Stream stream, int status, string reason, CancellationToken ct) =>
        Header(stream, status, reason, "text/plain", 0, null, ct);

    private static Task Header(
        Stream stream,
        int status,
        string reason,
        string mime,
        long length,
        string? extra,
        CancellationToken ct
    )
    {
        var text =
            $"HTTP/1.1 {status} {reason}\r\nContent-Type: {mime}\r\nContent-Length: {length}\r\nAccept-Ranges: bytes\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: Range\r\nAccess-Control-Expose-Headers: Content-Range,Accept-Ranges,Content-Length\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n{extra}\r\n";
        return stream.WriteAsync(Encoding.ASCII.GetBytes(text), ct).AsTask();
    }

    private static async Task<string> AssetMimeAsync(string path, CancellationToken ct)
    {
        await using var file = new FileStream(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            16,
            FileOptions.Asynchronous
        );
        var bytes = new byte[12];
        var read = await file.ReadAsync(bytes, ct);
        return read >= 3 && bytes[0] == 0xff && bytes[1] == 0xd8 ? "image/jpeg"
            : read >= 8 && bytes[0] == 137 && bytes[1] == 80 ? "image/png"
            : read >= 6 && Encoding.ASCII.GetString(bytes, 0, 3) == "GIF" ? "image/gif"
            : read == 12 && Encoding.ASCII.GetString(bytes, 8, 4) == "WEBP" ? "image/webp"
            : "application/octet-stream";
    }

    private static string Mime(string path) =>
        Path.GetExtension(path).ToLowerInvariant() switch
        {
            ".mp4" or ".m4v" => "video/mp4",
            ".webm" => "video/webm",
            ".mkv" => "video/x-matroska",
            ".mov" => "video/quicktime",
            ".m3u8" => "application/vnd.apple.mpegurl",
            ".ts" => "video/mp2t",
            ".jpg" or ".jpeg" => "image/jpeg",
            ".png" => "image/png",
            ".vtt" => "text/vtt",
            _ => "application/octet-stream",
        };

    public async ValueTask DisposeAsync()
    {
        lifetime.Cancel();
        listener.Stop();
        foreach (var id in sessions.Keys)
            await StopPlaybackAsync(id);
        if (acceptLoop is not null)
            await acceptLoop;
        if (cleanupLoop is not null)
            await cleanupLoop;
        lifetime.Dispose();
    }

    private static double ManifestDuration(string text) =>
        text.Split('\n')
            .Where(l => l.StartsWith("#EXTINF:"))
            .Sum(l =>
                double.TryParse(l[8..].TrimEnd(',', '\r'), CultureInfo.InvariantCulture, out var duration)
                    ? duration
                    : 0
            );

    private sealed class Transcode(
        Process process,
        string directory,
        string outputDirectory,
        string encoder,
        double offset
    )
    {
        public Process Process { get; } = process;
        public string Directory { get; } = directory;
        public string OutputDirectory { get; } = outputDirectory;
        public string Encoder { get; } = encoder;
        public double Offset { get; } = offset;
        public Task Drain { get; set; } = Task.CompletedTask;
        public string Error { get; set; } = "";
        public double Seconds { get; set; }
        public double ReadySeconds { get; set; }
        public double Speed { get; set; }
        public string? JobId { get; set; }
        public DateTimeOffset LastAccess { get; set; } = DateTimeOffset.UtcNow;
    }
}
