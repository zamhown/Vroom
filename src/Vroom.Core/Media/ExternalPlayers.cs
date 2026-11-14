using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using Vroom.Core.Application;
using Vroom.Core.Storage;
using Vroom.Core.Tagging;

namespace Vroom.Core.Media;

public sealed record ExternalPlayer(string Id, string Name, string Path, bool TracksProgress);

public sealed class ExternalPlayers(CatalogRepository repository, TagEngine tagging, LocalDiagnostics log, bool enabled)
    : IAsyncDisposable
{
    private readonly CancellationTokenSource stop = new();
    private readonly ConcurrentDictionary<string, (MpvProcess Process, Task Monitor)> sessions = new();
    public static readonly string[] Profiles = TagResources
        .Json("playback-capabilities.json")["externalPlayers"]
        .List("profiles")
        .Select(p => p.Text("id"))
        .ToArray();

    public static void ValidatePaths(IReadOnlyDictionary<string, string> paths)
    {
        if (
            paths is null
            || paths.Any(p =>
                !Profiles.Contains(p.Key)
                || p.Value is null
                || p.Value.Length > 32768
                || p.Value.Length > 0 && !Path.IsPathFullyQualified(p.Value)
            )
        )
            throw new ArgumentException("host.ExternalPlayers.invalidPath");
    }

    public async Task<IReadOnlyList<ExternalPlayer>> ListAsync()
    {
        if (!enabled)
            return [];
        var settings = await repository.SettingsAsync();
        var list = new List<ExternalPlayer>();
        var mac = OperatingSystem.IsMacOS() || OperatingSystem.IsMacCatalyst();
        foreach (var id in Profiles)
        {
            if (id == "iina" && !mac || id == "potplayer" && !OperatingSystem.IsWindows())
                continue;
            var candidates = new List<string>();
            if (settings.ExternalPlayerPaths.TryGetValue(id, out var custom) && custom.Length > 0)
                candidates.Add(custom);
            else
            {
                if (id == "mpv")
                    candidates.Add(MediaRuntime.Resolve(settings).Mpv.Path);
                var relatives = id switch
                {
                    "vlc" => new[] { "VideoLAN/VLC/vlc.exe" },
                    "potplayer" => new[] { "DAUM/PotPlayer/PotPlayerMini64.exe", "PotPlayer/PotPlayerMini64.exe" },
                    _ => new[] { "mpv/mpv.exe" },
                };
                if (OperatingSystem.IsWindows())
                    foreach (
                        var root in new[]
                        {
                            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
                            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                        }
                    )
                    foreach (var relative in relatives)
                        candidates.Add(Path.Combine(root, relative));
                if (mac)
                {
                    var app =
                        id == "vlc" ? "VLC"
                        : id == "iina" ? "IINA"
                        : "mpv";
                    var binary = id == "iina" ? "iina-cli" : id;
                    foreach (
                        var root in new[]
                        {
                            "/Applications",
                            Path.Combine(
                                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                                "Applications"
                            ),
                        }
                    )
                        candidates.Add(Path.Combine(root, app + ".app", "Contents", "MacOS", binary));
                    if (id == "mpv")
                    {
                        candidates.Add("/opt/homebrew/bin/mpv");
                        candidates.Add("/usr/local/bin/mpv");
                    }
                }
            }
            var path = candidates.FirstOrDefault(p => Path.IsPathFullyQualified(p) && File.Exists(p));
            if (path is not null)
                list.Add(
                    new(
                        id,
                        id switch
                        {
                            "vlc" => "VLC",
                            "iina" => "IINA",
                            "potplayer" => "PotPlayer",
                            _ => "mpv",
                        },
                        path,
                        id == "mpv"
                    )
                );
        }
        return list;
    }

    internal static string[] Arguments(string id, string file, double position) =>
        id switch
        {
            "vlc" =>
            [
                "--no-one-instance",
                "--start-time=" + position.ToString(CultureInfo.InvariantCulture),
                "--",
                file,
            ],
            "iina" => ["--no-stdin", "--mpv-start=" + position.ToString(CultureInfo.InvariantCulture), "--", file],
            "potplayer" =>
            [
                file,
                "/new",
                "/seek=" + TimeSpan.FromSeconds(position).ToString(@"hh\:mm\:ss", CultureInfo.InvariantCulture),
            ],
            _ => throw new ArgumentException("host.ExternalPlayers.unavailable"),
        };

    public async Task<object> OpenAsync(string filmId, string? partId, string playerId)
    {
        var player =
            (await ListAsync()).SingleOrDefault(p => p.Id == playerId)
            ?? throw new InvalidOperationException("host.ExternalPlayers.unavailable");
        var film = await repository.GetMediaPartAsync(filmId, partId);
        var file = new FileInfo(film.Path);
        if (!file.Exists || !Vroom.Core.Domain.MediaFormats.VideoExtensions.Contains(file.Extension))
            throw new IOException("host.Journey.mediaOffline");
        var position = film.Duration > 0 && film.Position >= film.Duration - 1 ? 0 : film.Position;
        if (player.Id != "mpv")
        {
            var start = new ProcessStartInfo(player.Path) { UseShellExecute = false, CreateNoWindow = true };
            foreach (var argument in Arguments(player.Id, file.FullName, position))
                start.ArgumentList.Add(argument);
            using var process = Process.Start(start) ?? throw new IOException("host.Mpv.startFailed");
            await repository.AuditAsync(
                "playback.external.open",
                CatalogRepository.Serialize(
                    new
                    {
                        filmId,
                        partId = film.PartId,
                        player = player.Id,
                        tracksProgress = false,
                    }
                )
            );
            return new { tracksProgress = false };
        }
        var id = Guid.NewGuid().ToString("N");
        var directory = Path.Combine(repository.Database.DataDirectory, "external-playback", id);
        Directory.CreateDirectory(directory);
        var mpv = new MpvProcess(log, Vroom.Core.Domain.TaskOrigin.Current.Value?.TabId);
        try
        {
            await mpv.StartAsync(player.Path, file.FullName, position, directory, ct: stop.Token);
            await mpv.CommandAsync(["set_property", "pause", false], stop.Token);
            var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var monitor = Task.Run(async () =>
            {
                await gate.Task;
                await MonitorAsync(id, mpv, film);
            });
            sessions[id] = (mpv, monitor);
            gate.SetResult();
            await repository.AuditAsync(
                "playback.external.open",
                CatalogRepository.Serialize(
                    new
                    {
                        filmId,
                        partId = film.PartId,
                        player = player.Id,
                        tracksProgress = true,
                    }
                )
            );
            return new { sessionId = id, tracksProgress = true };
        }
        catch
        {
            await mpv.DisposeAsync();
            throw;
        }
    }

    private async Task MonitorAsync(string id, MpvProcess mpv, Vroom.Core.Domain.Film film)
    {
        bool? paused = null;
        var ended = false;
        var revision = TagEngine.MediaRevision(film);
        try
        {
            while (!mpv.Exited && !stop.IsCancellationRequested)
            {
                // An external window permits drag/drop and playlists. Stop tracking
                // if its actual media changes; never attribute another file's clock.
                var path = (await mpv.CommandAsync(["get_property", "path"], stop.Token))?.ToString();
                if (
                    path is null
                    || !Path.IsPathFullyQualified(path)
                    || !CatalogRepository.PathComparer.Equals(Path.GetFullPath(path), film.Path)
                )
                    break;
                var state = mpv.Snapshot();
                var at = state.Number("time-pos");
                var finished = state.Flag("eof-reached");
                await repository.SavePositionAsync(
                    film.Id,
                    film.PartId,
                    finished ? 0 : Math.Max(0, at),
                    revision,
                    stop.Token,
                    ended: finished && !ended
                );
                if (paused != state.Flag("pause"))
                {
                    paused = state.Flag("pause");
                    await tagging.RecordMediaEventAsync(
                        paused.Value ? "playback.paused" : "playback.started",
                        film.Id,
                        new()
                        {
                            ["partId"] = film.PartId,
                            ["mediaRevision"] = revision,
                            ["position"] = at,
                        },
                        ct: stop.Token
                    );
                }
                if (finished && !ended)
                    await tagging.RecordMediaEventAsync(
                        "playback.ended",
                        film.Id,
                        new() { ["partId"] = film.PartId, ["mediaRevision"] = revision },
                        ct: stop.Token
                    );
                ended = finished;
                await Task.Delay(2000, stop.Token);
            }
        }
        catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
        catch (Exception e)
        {
            log.Error("playback.external.monitor", e);
        }
        finally
        {
            // Keep a window whose user changed the media alive until it exits.
            try
            {
                while (!mpv.Exited && !stop.IsCancellationRequested)
                    await Task.Delay(1000, stop.Token);
            }
            catch (OperationCanceledException) { }
            await mpv.DisposeAsync();
            sessions.TryRemove(id, out _);
        }
    }

    public async ValueTask DisposeAsync()
    {
        stop.Cancel();
        await Task.WhenAll(sessions.Values.Select(s => s.Monitor));
        stop.Dispose();
    }
}
