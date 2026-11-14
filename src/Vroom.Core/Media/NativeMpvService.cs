using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Nodes;
using Vroom.Core.Application;
using Vroom.Core.Storage;
using Vroom.Core.Tagging;

namespace Vroom.Core.Media;

public sealed record NativeVideoBounds(
    double Left,
    double Top,
    double Width,
    double Height,
    double Scale,
    bool Visible
);

public interface INativeVideoSurface
{
    bool Embedded { get; }
    bool Fullscreen => false;
    Task<long> CreateAsync(string id);
    Task UpdateAsync(string id, NativeVideoBounds bounds);
    Task DestroyAsync(string id);
    void SendInput(string id, MpvInput input) { }
    Task<bool> FullscreenAsync(bool? enabled) => Task.FromResult(false);
}

public sealed class DetachedVideoSurface : INativeVideoSurface
{
    public bool Embedded => false;

    public Task<long> CreateAsync(string id) => Task.FromResult(0L);

    public Task UpdateAsync(string id, NativeVideoBounds bounds) => Task.CompletedTask;

    public Task DestroyAsync(string id) => Task.CompletedTask;
}

public sealed class NativeMpvService(CatalogRepository repository, INativeVideoSurface surface, LocalDiagnostics log)
    : IAsyncDisposable
{
    private readonly ConcurrentDictionary<string, Session> sessions = new();
    private readonly SemaphoreSlim admission = new(1, 1);
    private readonly SemaphoreSlim presentation = new(1, 1);
    private string? fullscreenSession;
    private readonly CancellationTokenSource lifetime = new();
    private Task? cleanup;
    private int disposed;

    private sealed class Session(string filmId, string directory, MpvProcess process)
    {
        public string FilmId = filmId,
            Directory = directory;
        public MpvProcess Process = process;
        public SemaphoreSlim Commands = new(1, 1);
        public DateTimeOffset Seen = DateTimeOffset.UtcNow;
    }

    public static void ValidateSettings(JsonObject settings)
    {
        if (!TagSchemas.Get("native-playback.schema.json").Evaluate(settings).IsValid)
            throw new ArgumentException("host.Mpv.invalidSettings");
    }

    private async Task<string?> ExecutableAsync()
    {
        var path = MediaRuntime.Resolve(await repository.SettingsAsync()).Mpv.Path;
        return Path.IsPathRooted(path) && File.Exists(path) ? path : null;
    }

    public async Task<object> CapabilitiesAsync() =>
        new
        {
            available = await ExecutableAsync() is not null,
            embedded = surface.Embedded,
            engine = "mpv",
            contract = TagResources.Json("playback-capabilities.json")["nativePlayback"],
        };

    public async Task<object?> DispatchAsync(string method, JsonObject args)
    {
        if (
            !TagSchemas
                .Get("native-playback-command.schema.json")
                .Evaluate(new JsonObject { ["method"] = method, ["args"] = args.DeepClone() })
                .IsValid
        )
            throw new ArgumentException("host.Mpv.invalidSettings");
        if (method == "native.capabilities")
            return await CapabilitiesAsync();
        if (method == "native.open")
            return await OpenAsync(
                args.Text("filmId"),
                args.Number("position"),
                args["settings"]?.AsObject() ?? new(),
                args["partId"]?.ToString()
            );
        var id = args.Text("sessionId");
        if (method == "native.stop")
        {
            await StopAsync(id);
            return true;
        }
        if (!sessions.TryGetValue(id, out var session))
        {
            if (method == "native.surface")
                return false;
            throw new KeyNotFoundException("host.Mpv.sessionClosed");
        }
        session.Seen = DateTimeOffset.UtcNow;
        if (method == "native.status")
        {
            var status = session.Process.Snapshot();
            status["exited"] = session.Process.Exited;
            if (surface.Embedded)
                status["fullscreen"] = surface.Fullscreen;
            return status;
        }
        if (method == "native.fullscreen" && surface.Embedded)
        {
            await presentation.WaitAsync(lifetime.Token);
            try
            {
                if (!sessions.ContainsKey(id))
                    throw new KeyNotFoundException("host.Mpv.sessionClosed");
                var next = await surface.FullscreenAsync(args["enabled"]?.GetValue<bool>());
                fullscreenSession = next ? id : null;
                return next;
            }
            finally
            {
                presentation.Release();
            }
        }
        if (method == "native.surface")
        {
            var bounds = args["bounds"]!.Deserialize<NativeVideoBounds>(CatalogRepository.Json)!;
            if (
                new[] { bounds.Left, bounds.Top, bounds.Width, bounds.Height, bounds.Scale }.Any(v =>
                    !double.IsFinite(v)
                )
                || bounds.Width < 0
                || bounds.Height < 0
                || bounds.Scale is < .5 or > 8
            )
                throw new ArgumentException("host.Mpv.invalidSettings");
            await surface.UpdateAsync(id, bounds);
            return true;
        }
        if (!await session.Commands.WaitAsync(TimeSpan.FromSeconds(5)))
            throw new TimeoutException("host.Mpv.commandTimeout");
        try
        {
            var process = session.Process;
            switch (method)
            {
                case "native.fullscreen":
                    var fullscreen =
                        args["enabled"]?.GetValue<bool>()
                        ?? !((await process.CommandAsync(["get_property", "fullscreen"]))?.GetValue<bool>() ?? false);
                    await process.CommandAsync(["set_property", "fullscreen", fullscreen]);
                    return fullscreen;
                case "native.settings":
                    await ApplySettingsAsync(process, args["values"]!.AsObject());
                    return true;
                case "native.pause":
                    return await process.CommandAsync(["set_property", "pause", args["paused"]!.GetValue<bool>()]);
                case "native.seek":
                    var at = args.Number("position");
                    if (!double.IsFinite(at) || at < 0)
                        throw new ArgumentException("host.ClientApi.invalidPlaybackPosition");
                    var duration = process.Snapshot()["duration"]?.GetValue<double>() ?? 0;
                    return await process.CommandAsync([
                        "seek",
                        duration > 0 ? Math.Min(at, Math.Max(0, duration - .001)) : at,
                        args.Text("precision") == "keyframe" ? "absolute+keyframes" : "absolute+exact",
                    ]);
                case "native.frame":
                    return await process.CommandAsync([
                        args.Number("direction") < 0 ? "frame-back-step" : "frame-step",
                    ]);
                case "native.chapter":
                    var chapters = process.Snapshot()["chapter-list"]?.AsArray() ?? new();
                    var chapter = args["index"]!.GetValue<int>();
                    if (chapter < 0 || chapter >= chapters.Count)
                        throw new ArgumentException("host.Mpv.invalidTrack");
                    return await process.CommandAsync(["set_property", "chapter", chapter]);
                case "native.track":
                    var kind = args.Text("kind");
                    var track = args["track"]!;
                    var type = kind switch
                    {
                        "aid" => "audio",
                        "sid" or "secondary-sid" => "sub",
                        "vid" => "video",
                        _ => throw new ArgumentException("host.Mpv.invalidTrack"),
                    };
                    if (
                        track.ToJsonString() is not ("\"auto\"" or "\"no\"")
                        && !(process.Snapshot()["track-list"]?.AsArray() ?? new()).Any(t =>
                            t?["type"]?.GetValue<string>() == type && JsonNode.DeepEquals(t?["id"], track)
                        )
                    )
                        throw new ArgumentException("host.Mpv.invalidTrack");
                    return await process.CommandAsync(["set_property", kind, track]);
                case "native.device":
                    var device = args.Text("device");
                    if (
                        !(process.Snapshot()["audio-device-list"]?.AsArray() ?? new()).Any(d =>
                            d?["name"]?.GetValue<string>() == device
                        )
                    )
                        throw new ArgumentException("host.Mpv.invalidTrack");
                    return await process.CommandAsync(["set_property", "audio-device", device]);
                case "native.loop":
                    var start = args.Number("start");
                    var end = args.Number("end");
                    var enabled = args["enabled"]!.GetValue<bool>();
                    if (enabled && (!double.IsFinite(start) || !double.IsFinite(end) || start < 0 || end <= start))
                        throw new ArgumentException("host.Mpv.invalidSettings");
                    await process.CommandAsync(["set_property", "ab-loop-b", enabled ? end : "no"]);
                    return await process.CommandAsync(["set_property", "ab-loop-a", enabled ? start : "no"]);
                case "native.subtitle":
                    var extension = Path.GetExtension(args.Text("name")).ToLowerInvariant();
                    if (extension is not (".srt" or ".vtt" or ".ass" or ".ssa" or ".sup"))
                        throw new ArgumentException("host.Mpv.subtitleFormat");
                    var bytes = Convert.FromBase64String(args.Text("data"));
                    if (bytes.Length > 5_000_000)
                        throw new ArgumentException("host.ClientApi.requestIsTooLarge");
                    var subtitle = Path.Combine(session.Directory, Guid.NewGuid().ToString("N") + extension);
                    await File.WriteAllBytesAsync(subtitle, bytes);
                    return await process.CommandAsync(["sub-add", subtitle, "select"]);
                case "native.screenshot":
                    var file = Path.Combine(session.Directory, Guid.NewGuid().ToString("N") + ".png");
                    try
                    {
                        await process.CommandAsync([
                            "screenshot-to-file",
                            file,
                            args["subtitles"]?.GetValue<bool>() == true ? "subtitles" : "video",
                        ]);
                        if (new FileInfo(file).Length > 12_000_000)
                            throw new IOException("host.Mpv.screenshotTooLarge");
                        return "data:image/png;base64," + Convert.ToBase64String(await File.ReadAllBytesAsync(file));
                    }
                    finally
                    {
                        if (File.Exists(file))
                            File.Delete(file);
                    }
                default:
                    throw new ArgumentException("host.ClientApi.unknownClientOperation");
            }
        }
        finally
        {
            session.Commands.Release();
        }
    }

    private async Task<object> OpenAsync(string filmId, double position, JsonObject settings, string? partId = null)
    {
        ValidateSettings(settings);
        if (!double.IsFinite(position) || position < 0)
            throw new ArgumentException("host.ClientApi.invalidPlaybackPosition");
        var executable = await ExecutableAsync() ?? throw new FileNotFoundException("host.Mpv.notInstalled");
        var film = await repository.GetMediaPartAsync(filmId, partId);
        if (!File.Exists(film.Path))
            throw new FileNotFoundException("host.Journey.mediaOffline");
        await admission.WaitAsync(lifetime.Token);
        var id = Guid.NewGuid().ToString("N");
        var directory = Path.Combine(repository.Database.DataDirectory, "native-playback", id);
        var session = new Session(
            filmId,
            directory,
            new MpvProcess(log, Vroom.Core.Domain.TaskOrigin.Current.Value?.TabId)
        );
        try
        {
            if (sessions.Count >= 8)
                throw new InvalidOperationException("host.Mpv.sessionLimit");
            Directory.CreateDirectory(directory);
            var window = await surface.CreateAsync(id);
            session.Process.InputReceived += input => surface.SendInput(id, input);
            await session.Process.StartAsync(executable, film.Path, position, directory, window, ct: lifetime.Token);
            var properties = TagResources.Json("playback-capabilities.json")["nativePlayback"]!["settings"]![
                "properties"
            ]!.AsObject();
            var initial = new JsonObject(
                properties.Select(p => KeyValuePair.Create(p.Key, p.Value!["default"]?.DeepClone()))
            );
            foreach (var (key, value) in settings)
                initial[key] = value?.DeepClone();
            await ApplySettingsAsync(session.Process, initial);
            sessions[id] = session;
            cleanup ??= CleanupAsync();
            return new { sessionId = id, embedded = surface.Embedded };
        }
        catch
        {
            await session.Process.DisposeAsync();
            await surface.DestroyAsync(id);
            if (Directory.Exists(directory))
                Directory.Delete(directory, true);
            throw;
        }
        finally
        {
            admission.Release();
        }
    }

    private static async Task ApplySettingsAsync(MpvProcess process, JsonObject values)
    {
        ValidateSettings(values);
        var previous = new List<(string Key, JsonNode? Value)>();
        try
        {
            foreach (var (key, value) in values)
            {
                var old = await process.CommandAsync(["get_property", key]);
                await process.CommandAsync(["set_property", key, value]);
                previous.Add((key, old));
            }
        }
        catch
        {
            foreach (var old in previous.AsEnumerable().Reverse())
                try
                {
                    await process.CommandAsync(["set_property", old.Key, old.Value]);
                }
                catch (Exception ex) when (ex is IOException or OperationCanceledException or ObjectDisposedException)
                { }
            throw;
        }
    }

    public async Task StopAsync(string id)
    {
        if (!sessions.TryRemove(id, out var session))
            return;
        session.Process.Terminate();
        // The host owns presentation lifetime, even if React unmounts after its
        // controller/session has already been released. A background session
        // must never take another player's full-screen window away.
        await presentation.WaitAsync();
        try
        {
            if (fullscreenSession == id)
            {
                try
                {
                    await surface.FullscreenAsync(false);
                }
                catch (Exception ex)
                {
                    log.Error("mpv.fullscreen.close", ex);
                }
                fullscreenSession = null;
            }
        }
        finally
        {
            presentation.Release();
        }
        await session.Commands.WaitAsync();
        try
        {
            var status = session.Process.Snapshot();
            var position =
                status["eof-reached"]?.GetValue<bool>() == true ? 0 : status["time-pos"]?.GetValue<double>() ?? 0;
            try
            {
                await repository.UpdateMediaAsync(session.FilmId, f => f with { Position = Math.Max(0, position) });
            }
            catch (Exception ex)
            {
                log.Error("mpv.persist", ex);
            }
            await session.Process.DisposeAsync();
            await surface.DestroyAsync(id);
            try
            {
                Directory.Delete(session.Directory, true);
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
        finally
        {
            session.Commands.Release();
        }
    }

    public async Task StopAllAsync()
    {
        foreach (var id in sessions.Keys)
            await StopAsync(id);
    }

    private async Task CleanupAsync()
    {
        try
        {
            using var timer = new PeriodicTimer(TimeSpan.FromSeconds(15));
            while (await timer.WaitForNextTickAsync(lifetime.Token))
                foreach (var (id, session) in sessions)
                    if (DateTimeOffset.UtcNow - session.Seen > TimeSpan.FromSeconds(90))
                        try
                        {
                            await StopAsync(id);
                        }
                        catch (Exception ex)
                        {
                            log.Error("mpv.cleanup", ex);
                        }
        }
        catch (OperationCanceledException) { }
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0)
            return;
        lifetime.Cancel();
        await admission.WaitAsync();
        try
        {
            foreach (var id in sessions.Keys)
                await StopAsync(id);
            if (cleanup is not null)
                await cleanup;
        }
        finally
        {
            admission.Release();
            lifetime.Dispose();
        }
    }
}
