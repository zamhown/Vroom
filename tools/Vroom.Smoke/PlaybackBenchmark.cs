using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Vroom.Core.Domain;
using Vroom.Core.Jobs;
using Vroom.Core.Media;
using Vroom.Core.Storage;

internal static class PlaybackBenchmark
{
    public static async Task RunAsync(string root, IServiceProvider services, CancellationToken ct)
    {
        var repo = services.GetRequiredService<CatalogRepository>();
        var ffmpeg = services.GetRequiredService<FfmpegService>();
        var media = services.GetRequiredService<LocalMediaServer>();
        var jobs = services.GetRequiredService<JobCoordinator>();
        var settings = await repo.SettingsAsync(ct);
        var dir = Path.Combine(root, "artifacts", "playback-benchmark");
        Directory.CreateDirectory(dir);
        var clip = Path.Combine(dir, "BENCH-001 1080p motion.mp4");
        var encoder = await PlaybackPipeline.HardwareEncoderAsync(MediaRuntime.Ffmpeg(settings), ct);
        if (!File.Exists(clip))
        {
            Console.WriteLine("Generating 120s 1080p/30 motion fixture with " + encoder);
            await FfmpegService.CaptureAsync(
                MediaRuntime.Ffmpeg(settings),
                [
                    "-v",
                    "error",
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc2=size=1920x1080:rate=30",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=220:sample_rate=48000",
                    "-t",
                    "120",
                    "-c:v",
                    encoder,
                    "-b:v",
                    "6M",
                    "-g",
                    "60",
                    "-bf",
                    "0",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "aac",
                    "-movflags",
                    "+faststart",
                    clip,
                ],
                TimeSpan.FromMinutes(2),
                ct
            );
        }
        var probe = await ffmpeg.ProbeAsync(clip, ct);
        var lib = new Library("playback-benchmark", "播放性能测试", [dir], [], false, true);
        await repo.SaveLibraryAsync(lib, ct);
        var film = await repo.ImportMediaAsync(
            new Film
            {
                LibraryId = lib.Id,
                Path = clip,
                Size = new FileInfo(clip).Length,
                Duration = probe.Duration,
                Width = probe.Width,
                Height = probe.Height,
                FrameRate = probe.FrameRate,
                VideoCodec = probe.VideoCodec,
                AudioCodec = probe.AudioCodec,
            },
            ct
        );
        await services
            .GetRequiredService<Vroom.Core.Tagging.TagEngine>()
            .RecordMediaEventAsync("film.discovered", film.Id, ct: ct);
        var baseline = await Baseline(MediaRuntime.Ffmpeg(settings), clip, Path.Combine(dir, "baseline"), ct);
        var remux = await Optimized(false);
        var accelerated = await Optimized(true);
        var aligned = await media.OpenAsync(film.Id, true, 47.3, ct);
        if (aligned.Offset > 47.3 || 47.3 - aligned.Offset > 2.1)
            throw new Exception("Keyframe-aligned seek is inaccurate");
        await media.StopPlaybackAsync(aligned.SessionId);
        var report = new
        {
            measuredAt = DateTimeOffset.UtcNow,
            fixture = new
            {
                path = clip,
                probe.Width,
                probe.Height,
                probe.FrameRate,
                probe.Duration,
                size = film.Size,
            },
            hardwareEncoder = encoder,
            baseline,
            remux,
            accelerated,
            seek = new { requested = 47.3, aligned.Offset },
            filmId = film.Id,
        };
        var json = JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true });
        await File.WriteAllTextAsync(Path.Combine(dir, "results.json"), json, ct);
        Console.WriteLine(json);
        if (remux.BufferAt10Seconds < 30 || accelerated.BufferAt10Seconds < 15)
            throw new Exception("Insufficient playback reserve on this machine");
        Console.WriteLine("PASS 1080p benchmark, loopback segment decode and keyframe-aligned seek");

        async Task<Measurement> Optimized(bool forceEncode)
        {
            var timer = Stopwatch.StartNew();
            var id = await media.StartTranscodeAsync(film.Id, 0, forceEncode);
            PlaybackSource source;
            while (true)
            {
                var job = jobs.Get(id);
                if (job.State is JobState.Failed or JobState.Cancelled)
                    throw new Exception(job.Error ?? job.Detail);
                if (job.ResultJson is not null)
                {
                    source = JsonSerializer.Deserialize<PlaybackSource>(
                        job.ResultJson,
                        new JsonSerializerOptions { PropertyNameCaseInsensitive = true }
                    )!;
                    break;
                }
                await Task.Delay(20, ct);
            }
            var first = timer.Elapsed.TotalSeconds;
            var prepared = 0d;
            string playlist = "";
            using var client = new HttpClient();
            try
            {
                while (timer.Elapsed.TotalSeconds < 10)
                {
                    playlist = await client.GetStringAsync(source.Url, ct);
                    prepared = Duration(playlist);
                    await Task.Delay(200, ct);
                }
                var firstSegment = playlist.Split('\n').First(l => l.Trim().EndsWith(".ts")).Trim();
                var segment = new Uri(new Uri(source.Url), firstSegment);
                // Independently decode video AND audio from a served segment, not just a successful HTTP request.
                await FfmpegService.CaptureAsync(
                    MediaRuntime.Ffmpeg(settings),
                    ["-v", "error", "-i", segment.ToString(), "-t", "1", "-f", "null", "-"],
                    TimeSpan.FromSeconds(20),
                    ct
                );
                return new(
                    source.Pipeline,
                    Math.Round(first, 3),
                    Math.Round(first, 3),
                    Math.Round(prepared, 2),
                    Math.Round(prepared - (10 - first), 2)
                );
            }
            finally
            {
                await media.StopPlaybackAsync(source.SessionId);
            }
        }
    }

    private static async Task<Measurement> Baseline(string executable, string clip, string dir, CancellationToken ct)
    {
        // A new path prevents an old manifest from contaminating first-frame measurements.
        dir = Path.Combine(dir, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var manifest = Path.Combine(dir, "index.m3u8");
        var timer = Stopwatch.StartNew();
        using var process = FfmpegService.Start(
            executable,
            [
                "-v",
                "error",
                "-nostdin",
                "-y",
                "-re",
                "-i",
                clip,
                "-map",
                "0:v:0",
                "-map",
                "0:a:0?",
                "-sn",
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "23",
                "-pix_fmt",
                "yuv420p",
                "-force_key_frames",
                "expr:gte(t,n_forced*2)",
                "-c:a",
                "aac",
                "-ac",
                "2",
                "-b:a",
                "160k",
                "-f",
                "hls",
                "-hls_time",
                "2",
                "-hls_list_size",
                "12",
                "-hls_flags",
                "delete_segments+independent_segments+temp_file",
                "-hls_segment_filename",
                Path.Combine(dir, "%06d.ts"),
                manifest,
            ]
        );
        var errors = process.StandardError.ReadToEndAsync(ct);
        var output = process.StandardOutput.ReadToEndAsync(ct);
        double first = 0,
            six = 0,
            prepared = 0;
        try
        {
            while (timer.Elapsed.TotalSeconds < 10)
            {
                if (process.HasExited)
                    throw new Exception(await errors);
                if (File.Exists(manifest))
                {
                    prepared = Duration(await File.ReadAllTextAsync(manifest, ct));
                    if (first == 0 && prepared > 0)
                        first = timer.Elapsed.TotalSeconds;
                    if (six == 0 && prepared >= 6)
                        six = timer.Elapsed.TotalSeconds;
                }
                await Task.Delay(100, ct);
            }
            return new(
                "libx264 / veryfast / -re",
                Math.Round(first, 3),
                Math.Round(six, 3),
                Math.Round(prepared, 2),
                Math.Round(prepared - (10 - first), 2)
            );
        }
        finally
        {
            if (!process.HasExited)
                process.Kill(true);
            await process.WaitForExitAsync(ct);
            await Task.WhenAll(errors, output);
        }
    }

    private static double Duration(string playlist) =>
        playlist
            .Split('\n')
            .Where(l => l.StartsWith("#EXTINF:"))
            .Sum(l => double.Parse(l[8..].TrimEnd(',', '\r'), CultureInfo.InvariantCulture));

    private sealed record Measurement(
        string Pipeline,
        double FirstAvailableSeconds,
        double SixSecondReserveReadyAt,
        double PreparedAt10Seconds,
        double BufferAt10Seconds
    );
}
