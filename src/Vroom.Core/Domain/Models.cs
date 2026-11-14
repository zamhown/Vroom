namespace Vroom.Core.Domain;

/// <summary>Persisted and exchanged as camelCase names ("queued", "completed", …), never as ordinals.</summary>
[System.Text.Json.Serialization.JsonConverter(typeof(JobStateConverter))]
public enum JobState
{
    Queued,
    Running,
    Cancelling,
    Completed,
    Cancelled,
    Failed,
    Pausing,
    Paused,
    Interrupted,
}

public sealed class JobStateConverter()
    : System.Text.Json.Serialization.JsonStringEnumConverter<JobState>(System.Text.Json.JsonNamingPolicy.CamelCase)
{
    public static string Name(JobState state) =>
        System.Text.Json.JsonNamingPolicy.CamelCase.ConvertName(state.ToString());
}

/// <summary>A library and its indexing policy. Every entry point creates libraries through <see cref="Create"/>.</summary>
public sealed record Library(
    string Id,
    string Name,
    string[] Roots,
    string[] Excludes,
    bool AutoEnrich = Library.DefaultAutoEnrich,
    bool ProbeOnScan = Library.DefaultProbeOnScan
)
{
    public const bool DefaultAutoEnrich = true;
    public const bool DefaultProbeOnScan = true;

    public static Library Create(
        string name,
        IEnumerable<string> roots,
        IEnumerable<string>? excludes = null,
        bool? autoEnrich = null,
        bool? probeOnScan = null
    ) =>
        new(
            Guid.NewGuid().ToString("N"),
            name,
            roots.ToArray(),
            (excludes ?? []).Select(e => e.Trim()).Where(e => e.Length > 0).ToArray(),
            autoEnrich ?? DefaultAutoEnrich,
            probeOnScan ?? DefaultProbeOnScan
        );
}

public sealed record Film
{
    public string Id { get; init; } = Guid.NewGuid().ToString("N");
    public required string LibraryId { get; init; }
    public required string Path { get; init; }
    public string? FileId { get; init; }
    public string? VersionId { get; init; }
    public string? PartId { get; init; }
    public long StructureRevision { get; init; } = 1;
    public long Size { get; init; }
    public double Duration { get; init; }
    public string ProbeState { get; init; } = "unknown";
    public string? ProbeError { get; init; }
    public int Width { get; init; }
    public int Height { get; init; }
    public double FrameRate { get; init; }
    public string? VideoCodec { get; init; }
    public string? AudioCodec { get; init; }
    public DateTimeOffset Added { get; init; } = DateTimeOffset.UtcNow;
    public DateTimeOffset Modified { get; init; } = DateTimeOffset.UtcNow;
    public double Position { get; init; }

    /// <summary>Path below the library root where the file was found (file name for direct imports).</summary>
    public string? RelativePath { get; init; }

    /// <summary>Set when a complete scan of a reachable root no longer finds the file.</summary>
    public DateTimeOffset? MissingSince { get; init; }
}

public sealed record SavedView(string Id, string Name, QuerySpec Query);

public sealed record QueryOrder(string Tag, string Direction = "desc", string Mode = "value", string Nulls = "last");

public sealed record QueryGroup(string Tag, string Mode = "value", string Facet = "");

[System.Text.Json.Serialization.JsonUnmappedMemberHandling(
    System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow
)]
public sealed record QuerySpec(
    string? LibraryId = null,
    [property: System.Text.Json.Serialization.JsonIgnore(
        Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull
    )]
        QueryOrder[]? OrderBy = null,
    [property: System.Text.Json.Serialization.JsonIgnore(
        Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull
    )]
        QueryGroup[]? GroupBy = null,
    int Offset = 0,
    int Limit = 60,
    bool IgnoreDefaultQuery = false,
    System.Text.Json.Nodes.JsonObject? Where = null,
    string Search = "",
    [property: System.Text.Json.Serialization.JsonIgnore(
        Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull
    )]
        string? Scope = null,
    string Locale = ""
);

public sealed record ProbeResult(
    double Duration,
    int Width,
    int Height,
    string? VideoCodec,
    string? AudioCodec,
    double FrameRate = 0,
    string? PixelFormat = null,
    Vroom.Core.Media.PlaybackTrack[]? Tracks = null,
    Vroom.Core.Media.PlaybackChapter[]? Chapters = null
);

public sealed record ScanProgress(int Discovered, int Imported, string Current, IReadOnlyList<string> Errors);

public sealed record JobInfo(
    string Id,
    string Name,
    JobState State,
    int Completed,
    string Detail,
    DateTimeOffset Started,
    string? Error = null
)
{
    public TaskOrigin? Origin { get; init; }

    /// <summary>The task that started this one (for example a scan that queued media processing).</summary>
    public string? ParentId { get; init; }
    public IReadOnlyDictionary<string, object?>? NameArgs { get; init; }
    public IReadOnlyDictionary<string, object?>? DetailArgs { get; init; }
    public IReadOnlyDictionary<string, object?>? ErrorArgs { get; init; }
    public string Kind { get; init; } = "";
    public string Payload { get; init; } = "{}";
    public string? ResourceKey { get; init; }
    public int? Total { get; init; }
    public DateTimeOffset Updated { get; init; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? Finished { get; init; }
    public bool CanPause { get; init; }
    public bool CanStop { get; init; } = true;
    public bool CanRetry { get; init; }
    public int Attempt { get; init; } = 1;
    public string? ResultJson { get; init; }
    public string? CheckpointJson { get; init; }
    public string WorkerClass { get; init; } = "default";
    public int Priority { get; init; }
    public DateTimeOffset? NotBefore { get; init; }
    public DateTimeOffset? ExecutionStarted { get; init; }
    public JobTelemetry? Telemetry { get; init; }
}

public sealed record JobTelemetry(
    string Phase,
    double? FramesPerSecond = null,
    double? AverageFramesPerSecond = null,
    double? EtaSeconds = null,
    int? Pass = null,
    int? PassCount = null
);

public sealed record JobSchedule(int Priority = 0, DateTimeOffset? NotBefore = null);

public sealed record SchedulerPolicy(int MaxWorkers = 3, int MaxEncoders = 1, bool Paused = false);

public sealed record JobPage(IReadOnlyList<JobInfo> Items, int Total, int Active, int Paused, int Failed);

/// <summary>
/// User settings. Tool paths are optional overrides: an empty value means the bundled runtime
/// (or the system PATH) is resolved at use time, so moving or upgrading the app keeps working.
/// </summary>
public sealed record AppSettings
{
    public IReadOnlyDictionary<string, string> ExternalPlayerPaths { get; init; } = new Dictionary<string, string>();
    public Vroom.Core.Network.NetworkOptions Network { get; init; } = new();
    public string SourceBrowserPath { get; init; } = "";
    public string MpvPath { get; init; } = "";
    public string FfmpegPath { get; init; } = "";
    public string FfprobePath { get; init; } = "";
    public string HandBrakePath { get; init; } = "";
    public string ModelPath { get; init; } = "";
    public bool OnlineMetadata { get; init; }

    /// <summary>Minutes between automatic scans; 0 disables periodic scanning.</summary>
    public int ScanIntervalMinutes { get; init; } = 360;
    public bool ScanOnStartup { get; init; } = true;
    public int TranscodeHeight { get; init; } = 1080;

    // Value equality over the canonical serialized form, so new properties never need hand-written comparers.
    public bool Equals(AppSettings? other) =>
        other is not null
        && System.Text.Json.JsonSerializer.Serialize(Canonical())
            == System.Text.Json.JsonSerializer.Serialize(other.Canonical());

    public override int GetHashCode() =>
        System.Text.Json.JsonSerializer.Serialize(Canonical()).GetHashCode(StringComparison.Ordinal);

    private AppSettings Canonical() =>
        this with
        {
            ExternalPlayerPaths = new SortedDictionary<string, string>(
                ExternalPlayerPaths.ToDictionary(p => p.Key, p => p.Value),
                StringComparer.Ordinal
            ),
        };
}
