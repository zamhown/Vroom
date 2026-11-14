using Vroom.Core.Domain;
using Vroom.Core.Media;

namespace Vroom.Tests;

public class PlaybackPipelineTests
{
    [Fact]
    public void SelectedAudioUsesItsAbsoluteStreamAndFiltersForceAudioEncoding()
    {
        var probe = new ProbeResult(
            120,
            1920,
            1080,
            "h264",
            "aac",
            30,
            "yuv420p",
            [new(0, "video", "h264", null, null, 0), new(2, "audio", "aac", "fr", "Alternate", 6)]
        );
        var options = new PlaybackOptions(2, .35, "mono", true);
        var args = PlaybackPipeline.Arguments(
            "movie.mkv",
            "cache",
            10,
            probe,
            PlaybackPipeline.Plan(probe, 720, "libx264", options.Deinterlace),
            options
        );
        Assert.Contains("0:2", args);
        Assert.DoesNotContain("0:a:0?", args);
        Assert.Contains("adelay=350:all=1", args);
        Assert.Equal("aac", args[Array.IndexOf(args, "-c:a") + 1]);
        Assert.Equal("1", args[Array.IndexOf(args, "-ac") + 1]);
        Assert.Contains("yadif,scale=-2:min(720\\,ih),format=yuv420p", args);
        Assert.Throws<ArgumentException>(() => new PlaybackOptions(0).Validate(probe));
        Assert.Throws<ArgumentException>(() => new PlaybackOptions(1).Validate(probe));
    }

    [Fact]
    public void RejectsNonFiniteAndUnregisteredOptions()
    {
        foreach (var delay in new[] { double.NaN, double.PositiveInfinity, -5.01, 5.01 })
            Assert.Throws<ArgumentException>(() => new PlaybackOptions(AudioDelay: delay).Validate());
        Assert.Throws<ArgumentException>(() => new PlaybackOptions(Channels: "arbitrary-filter").Validate());
        Assert.Throws<ArgumentException>(() => new PlaybackOptions(-1).Validate());
        Assert.Equal("atrim=start=0.5,asetpts=PTS-STARTPTS", new PlaybackOptions(AudioDelay: -.5).AudioFilter);
    }

    [Fact]
    public void PersistentJobsRoundTripOnlyThePublicOptionsContract()
    {
        var options = new PlaybackOptions(2, .25, "mono", true);
        var settings = new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web);
        var json = System.Text.Json.JsonSerializer.Serialize(options, settings);
        Assert.DoesNotContain("needsProcessing", json);
        Assert.DoesNotContain("audioFilter", json);
        Assert.Equal(options, System.Text.Json.JsonSerializer.Deserialize<PlaybackOptions>(json, settings));
        Assert.Throws<System.Text.Json.JsonException>(() =>
            System.Text.Json.JsonSerializer.Deserialize<PlaybackOptions>("{\"rawFlags\":\"unsafe\"}", settings)
        );
    }

    [Theory]
    [InlineData("h264", "yuv420p", "aac", true, true)]
    [InlineData("h264", "yuv420p", "ac3", true, false)]
    [InlineData("h264", "yuv420p10le", "aac", false, true)]
    [InlineData("hevc", "yuv420p", "dts", false, false)]
    [InlineData("av1", "yuv420p10le", "opus", false, false)]
    public void ChoosesOnlyPortableStreamsForLosslessRemux(
        string codec,
        string pixels,
        string audio,
        bool copyVideo,
        bool copyAudio
    )
    {
        var plan = PlaybackPipeline.Plan(new(120, 1920, 1080, codec, audio, 30, pixels), 1080, "h264_nvenc");
        Assert.Equal(copyVideo, plan.CopyVideo);
        Assert.Equal(copyAudio, plan.CopyAudio);
        Assert.Equal(copyVideo ? "copy" : "h264_nvenc", plan.Encoder);
    }

    [Fact]
    public void ExplicitRecoveryCanEncodeAnOtherwiseCompatibleFile()
    {
        var probe = new ProbeResult(120, 3840, 2160, "h264", "aac", 60, "yuv420p");
        var plan = PlaybackPipeline.Plan(probe, 1080, "libx264", forceEncode: true);
        Assert.False(plan.CopyVideo);
        var args = PlaybackPipeline.Arguments("example.mkv", "cache", 63.125, probe, plan);
        Assert.DoesNotContain("-re", args);
        Assert.Contains("90", args);
        Assert.Contains("event", args);
        Assert.DoesNotContain("delete_segments", string.Join(' ', args));
        Assert.Contains("63.125", args);
        Assert.Contains("ultrafast", args);
        Assert.Contains("scale=-2:min(1080\\,ih),format=yuv420p", args);
    }
}
