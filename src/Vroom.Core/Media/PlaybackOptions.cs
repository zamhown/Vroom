using System.Globalization;
using Vroom.Core.Domain;

namespace Vroom.Core.Media;

public sealed record PlaybackTrack(
    int Index,
    string Kind,
    string? Codec,
    string? Language,
    string? Title,
    int Channels
);

public sealed record PlaybackChapter(double Start, double End, string? Title);

[System.Text.Json.Serialization.JsonUnmappedMemberHandling(
    System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow
)]
public sealed record PlaybackOptions(
    int? AudioStream = null,
    double AudioDelay = 0,
    string Channels = "source",
    bool Deinterlace = false
)
{
    [System.Text.Json.Serialization.JsonIgnore]
    public bool NeedsProcessing => AudioStream is not null || AudioDelay != 0 || Channels != "source" || Deinterlace;

    public void Validate(ProbeResult? probe = null)
    {
        if (
            !double.IsFinite(AudioDelay)
            || Math.Abs(AudioDelay) > 5
            || Channels is not ("source" or "mono" or "stereo")
            || AudioStream < 0
        )
            throw new ArgumentException("host.Playback.invalidOptions");
        if (
            AudioStream is { } index
            && probe is not null
            && !(probe.Tracks ?? []).Any(t => t.Index == index && t.Kind == "audio")
        )
            throw new ArgumentException("host.Playback.invalidTrack");
    }

    [System.Text.Json.Serialization.JsonIgnore]
    public string? AudioFilter =>
        AudioDelay > 0 ? $"adelay={Math.Round(AudioDelay * 1000).ToString(CultureInfo.InvariantCulture)}:all=1"
        : AudioDelay < 0 ? $"atrim=start={(-AudioDelay).ToString(CultureInfo.InvariantCulture)},asetpts=PTS-STARTPTS"
        : null;
}
