using System.Collections.Concurrent;
using System.Globalization;
using Vroom.Core.Domain;

namespace Vroom.Core.Media;

public sealed record PlaybackPlan(string Encoder, bool CopyVideo, bool CopyAudio, int Height, string Description);

/// <summary>Choose the least expensive compatible pipeline. Encoder presence alone is not a hardware capability test.</summary>
public static class PlaybackPipeline
{
    private static readonly ConcurrentDictionary<string, string> Encoders = new();
    private static readonly SemaphoreSlim ProbeGate = new(1, 1);

    public static PlaybackPlan Plan(ProbeResult probe, int maxHeight, string hardwareEncoder, bool forceEncode = false)
    {
        var height = Math.Clamp(maxHeight, 360, 2160);
        // AVC 8-bit 4:2:0 is portable in MSE. 10-bit / 4:4:4 AVC still needs conversion.
        var copy = !forceEncode && probe.VideoCodec == "h264" && probe.PixelFormat is "yuv420p" or "yuvj420p";
        var audio = probe.AudioCodec is null or "aac" or "mp3";
        return new(
            copy ? "copy" : hardwareEncoder,
            copy,
            audio,
            height,
            copy
                ? audio
                    ? "host.PlaybackPipeline.originalVideoPassthrough"
                    : "host.PlaybackPipeline.originalVideoAudioConversion"
                : hardwareEncoder == "libx264"
                    ? "host.PlaybackPipeline.fastSoftwareTranscoding"
                    : "host.PlaybackPipeline.hardwareAcceleratedTranscoding"
        );
    }

    public static async Task<string> HardwareEncoderAsync(string executable, CancellationToken ct)
    {
        if (Encoders.TryGetValue(executable, out var found))
            return found;
        await ProbeGate.WaitAsync(ct);
        try
        {
            if (Encoders.TryGetValue(executable, out found))
                return found;
            var candidates =
                OperatingSystem.IsMacOS() || OperatingSystem.IsMacCatalyst()
                    ? new[] { "h264_videotoolbox" }
                    : new[] { "h264_nvenc", "h264_qsv", "h264_amf" };
            foreach (var encoder in candidates)
            {
                try
                {
                    await FfmpegService.CaptureAsync(
                        executable,
                        [
                            "-v",
                            "error",
                            "-nostdin",
                            "-f",
                            "lavfi",
                            "-i",
                            "color=s=256x144:r=30:d=0.1",
                            "-frames:v",
                            "3",
                            "-pix_fmt",
                            "yuv420p",
                            "-c:v",
                            encoder,
                            "-f",
                            "null",
                            "-",
                        ],
                        TimeSpan.FromSeconds(8),
                        ct
                    );
                    Encoders[executable] = encoder;
                    return encoder;
                }
                catch (Exception ex) when (ex is IOException or TimeoutException) { }
            }
            return Encoders[executable] = "libx264";
        }
        finally
        {
            ProbeGate.Release();
        }
    }

    public static string[] Arguments(
        string path,
        string directory,
        double start,
        ProbeResult probe,
        PlaybackPlan plan,
        PlaybackOptions? options = null
    )
    {
        options ??= new();
        options.Validate(probe);
        var args = new List<string>
        {
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-y",
            "-progress",
            "pipe:1",
            "-nostats",
            "-ss",
            start.ToString(CultureInfo.InvariantCulture),
            // Burst ahead immediately, then maintain a reserve without saturating a NAS for the whole film.
            "-readrate",
            "5",
            "-readrate_initial_burst",
            "90",
            "-protocol_whitelist",
            "file,pipe,crypto",
            "-i",
            path,
            "-map",
            "0:v:0",
            "-map",
            options.AudioStream is { } audioIndex ? $"0:{audioIndex}" : "0:a:0?",
            "-sn",
            "-dn",
            "-c:v",
            plan.Encoder,
        };
        if (!plan.CopyVideo)
        {
            args.AddRange([
                "-vf",
                (options.Deinterlace ? "yadif," : "") + $"scale=-2:min({plan.Height}\\,ih),format=yuv420p",
                "-force_key_frames",
                "expr:gte(t,n_forced*2)",
                "-g",
                Math.Clamp((int)Math.Round(probe.FrameRate * 2), 24, 240).ToString(CultureInfo.InvariantCulture),
            ]);
            args.AddRange(
                plan.Encoder switch
                {
                    "h264_nvenc" =>
                    [
                        "-preset",
                        "p2",
                        "-tune",
                        "hq",
                        "-rc",
                        "vbr",
                        "-cq",
                        "23",
                        "-b:v",
                        "5M",
                        "-maxrate",
                        "8M",
                        "-bufsize",
                        "16M",
                    ],
                    "h264_qsv" => ["-preset", "veryfast", "-global_quality", "24"],
                    "h264_amf" => ["-quality", "speed", "-b:v", "5M", "-maxrate", "8M"],
                    "h264_videotoolbox" => ["-b:v", "5M", "-allow_sw", "0"],
                    _ => new[]
                    {
                        "-preset",
                        "ultrafast",
                        "-crf",
                        "23",
                        "-threads",
                        Math.Clamp(Environment.ProcessorCount / 2, 2, 12).ToString(CultureInfo.InvariantCulture),
                        "-maxrate",
                        "8M",
                        "-bufsize",
                        "16M",
                    },
                }
            );
        }
        if (options.AudioFilter is { } filter)
            args.AddRange(["-af", filter]);
        if (options.Channels != "source")
            args.AddRange(["-ac", options.Channels == "mono" ? "1" : "2"]);
        args.AddRange(
            plan.CopyAudio && options.AudioFilter is null && options.Channels == "source"
                ? ["-c:a", "copy"]
                : ["-c:a", "aac", "-b:a", "160k"]
        );
        // EVENT retains earlier segments: pause, rewind and A/B loops do not destroy and recreate the encoder.
        args.AddRange([
            "-avoid_negative_ts",
            "make_zero",
            "-max_muxing_queue_size",
            "2048",
            "-f",
            "hls",
            "-hls_time",
            "2",
            "-hls_playlist_type",
            "event",
            "-hls_list_size",
            "0",
            "-hls_flags",
            "independent_segments+temp_file",
            "-hls_segment_filename",
            Path.Combine(directory, "%06d.ts"),
            Path.Combine(directory, "index.m3u8"),
        ]);
        return args.ToArray();
    }
}
