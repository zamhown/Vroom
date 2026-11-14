using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;
using Vroom.Core.Application;
using Vroom.Core.Domain;
using Vroom.Core.Storage;

namespace Vroom.Core.Media;

public sealed class FfmpegService(CatalogRepository repository)
{
    private readonly SemaphoreSlim probeGate = new(2, 2);

    public async Task<ProbeResult> ProbeAsync(string path, CancellationToken ct = default)
    {
        await probeGate.WaitAsync(ct);
        try
        {
            var settings = await repository.SettingsAsync(ct);
            var output = await CaptureAsync(
                MediaRuntime.Ffprobe(settings),
                [
                    "-v",
                    "error",
                    "-protocol_whitelist",
                    "file,pipe,crypto",
                    "-show_format",
                    "-show_streams",
                    "-show_chapters",
                    "-of",
                    "json",
                    path,
                ],
                TimeSpan.FromSeconds(45),
                ct
            );
            using var json = JsonDocument.Parse(output);
            var streams = json.RootElement.GetProperty("streams").EnumerateArray().ToArray();
            var video = streams.FirstOrDefault(s =>
                s.TryGetProperty("codec_type", out var type) && type.GetString() == "video"
            );
            var audio = streams.FirstOrDefault(s =>
                s.TryGetProperty("codec_type", out var type) && type.GetString() == "audio"
            );
            double duration = 0;
            if (
                json.RootElement.TryGetProperty("format", out var format)
                && format.TryGetProperty("duration", out var d)
            )
                double.TryParse(d.GetString(), CultureInfo.InvariantCulture, out duration);
            var rateParts = (Text(video, "avg_frame_rate") ?? "0/1").Split('/');
            var rate =
                rateParts.Length == 2
                && double.TryParse(rateParts[0], CultureInfo.InvariantCulture, out var numerator)
                && double.TryParse(rateParts[1], CultureInfo.InvariantCulture, out var denominator)
                && denominator > 0
                    ? numerator / denominator
                    : 0;
            return new(
                duration,
                Number(video, "width"),
                Number(video, "height"),
                Text(video, "codec_name"),
                Text(audio, "codec_name"),
                rate > 0 ? rate : 0,
                Text(video, "pix_fmt"),
                streams
                    .Select(s => new PlaybackTrack(
                        Number(s, "index"),
                        Text(s, "codec_type") ?? "",
                        Text(s, "codec_name"),
                        s.TryGetProperty("tags", out var tags) ? Text(tags, "language") : null,
                        s.TryGetProperty("tags", out tags) ? Text(tags, "title") : null,
                        Number(s, "channels")
                    ))
                    .ToArray(),
                json.RootElement.TryGetProperty("chapters", out var chapters)
                    ? chapters
                        .EnumerateArray()
                        .Select(c => new PlaybackChapter(
                            double.Parse(Text(c, "start_time") ?? "0", CultureInfo.InvariantCulture),
                            double.Parse(Text(c, "end_time") ?? "0", CultureInfo.InvariantCulture),
                            c.TryGetProperty("tags", out var tags) ? Text(tags, "title") : null
                        ))
                        .ToArray()
                    : []
            );
        }
        finally
        {
            probeGate.Release();
        }
    }

    private static int Number(JsonElement e, string key) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(key, out var v) ? v.GetInt32() : 0;

    private static string? Text(JsonElement e, string key) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(key, out var v) ? v.GetString() : null;

    public async Task<string> ThumbnailAsync(Film film, double seconds, CancellationToken ct = default)
    {
        if (!double.IsFinite(seconds) || seconds < 0)
            throw new ArgumentException("host.FfmpegService.invalidTime");
        seconds = Math.Min(seconds, film.Duration > 0 ? Math.Max(0, film.Duration - 0.1) : seconds);
        var directory = Path.Combine(repository.Database.DataDirectory, "thumbnails");
        Directory.CreateDirectory(directory);
        var target = Path.Combine(directory, $"{film.Id}-{(long)(seconds * 1000)}.jpg");
        if (File.Exists(target))
            return target;
        var settings = await repository.SettingsAsync(ct);
        await CaptureAsync(
            MediaRuntime.Ffmpeg(settings),
            [
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-y",
                "-ss",
                seconds.ToString(CultureInfo.InvariantCulture),
                "-protocol_whitelist",
                "file,pipe,crypto",
                "-i",
                film.Path,
                "-frames:v",
                "1",
                "-vf",
                "scale=480:-2",
                target,
            ],
            TimeSpan.FromSeconds(45),
            ct
        );
        if (!File.Exists(target))
            throw new IOException("host.FfmpegService.unableToReadThisFrameChooseAnother");
        return target;
    }

    public async Task<double> KeyframeBeforeAsync(string path, double at, CancellationToken ct)
    {
        if (at <= 0)
            return 0;
        var settings = await repository.SettingsAsync(ct);
        var json = await CaptureAsync(
            MediaRuntime.Ffprobe(settings),
            [
                "-v",
                "error",
                "-protocol_whitelist",
                "file,pipe,crypto",
                "-select_streams",
                "v:0",
                "-read_intervals",
                at.ToString(CultureInfo.InvariantCulture) + "%+5",
                "-show_packets",
                "-show_entries",
                "packet=pts_time,flags",
                "-of",
                "json",
                path,
            ],
            TimeSpan.FromSeconds(15),
            ct
        );
        using var parsed = JsonDocument.Parse(json);
        return parsed
            .RootElement.GetProperty("packets")
            .EnumerateArray()
            .Where(p => Text(p, "flags")?.Contains('K') == true)
            .Select(p => double.TryParse(Text(p, "pts_time"), CultureInfo.InvariantCulture, out var t) ? t : -1)
            .Where(t => t >= 0 && t <= at)
            .DefaultIfEmpty(0)
            .Max();
    }

    public static Process Start(string executable, IEnumerable<string> arguments)
    {
        if (OperatingSystem.IsIOS() || OperatingSystem.IsAndroid())
            throw new PlatformNotSupportedException(
                "host.FfmpegService.mobileDevicesSupportSystemFormatsDirectlyFfmpeg"
            );
        var info = new ProcessStartInfo(executable)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            // FFmpeg emits UTF-8 even when a Windows host uses a legacy console code page.
            // Decoding with that code page can consume JSON's escape bytes after Unicode paths.
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        foreach (var argument in arguments)
            info.ArgumentList.Add(argument);
        return Process.Start(info) ?? throw new IOException("host.FfmpegService.unableToStartTheMediaProcess");
    }

    public static async Task<string> CaptureAsync(
        string executable,
        string[] args,
        TimeSpan timeout,
        CancellationToken ct
    )
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(timeout);
        using var process = Start(executable, args);
        using var registration = deadline.Token.Register(() => Kill(process));
        var output = process.StandardOutput.ReadToEndAsync(deadline.Token);
        var errors = process.StandardError.ReadToEndAsync(deadline.Token);
        try
        {
            await process.WaitForExitAsync(deadline.Token);
            var error = await errors;
            if (process.ExitCode != 0)
                throw new IOException("host.FfmpegService.mediaProcessingFailed").Localize(
                    "host.FfmpegService.mediaProcessingFailed",
                    error[..Math.Min(1500, error.Length)]
                );
            return await output;
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new TimeoutException("host.FfmpegService.mediaReadingTimedOutCheckTheDisk");
        }
        finally
        {
            Kill(process);
            try
            {
                await Task.WhenAll(output, errors);
            }
            catch (OperationCanceledException) { }
        }
    }

    internal static void Kill(Process process)
    {
        try
        {
            if (!process.HasExited)
                process.Kill(entireProcessTree: true);
        }
        catch (InvalidOperationException) { }
        catch (System.ComponentModel.Win32Exception) { }
    }
}
