namespace Vroom.Core.Domain;

// Physical facts have exactly one persisted representation, independent of work tags.
public sealed record MediaFile
{
    public required string Id { get; init; }
    public required string LibraryId { get; init; }
    public required string Path { get; init; }
    public string? FileSystemIdentity { get; init; }
    public string? RelativePath { get; init; }
    public string? ContentFingerprint { get; init; }
    public DateTimeOffset? MissingSince { get; init; }
    public long Size { get; init; }
    public DateTimeOffset Modified { get; init; }
    public string ProbeState { get; init; } = "unknown";
    public string? ProbeError { get; init; }
    public double Duration { get; init; }
    public int Width { get; init; }
    public int Height { get; init; }
    public double FrameRate { get; init; }
    public string? VideoCodec { get; init; }
    public string? AudioCodec { get; init; }
}

public sealed record MediaPart(string Id, string FileId, int Ordinal, double Position, MediaFile File);

public sealed record MediaVersion(string Id, string Name, int Ordinal, IReadOnlyList<MediaPart> Parts);

public sealed record ResourceSet(
    string Id,
    string Name,
    string? VersionId,
    string? PartId,
    IReadOnlyList<MediaFile> Files
);

public sealed record MediaStructure(
    string FilmId,
    long Revision,
    string? SelectedPartId,
    IReadOnlyList<MediaVersion> Versions,
    IReadOnlyList<ResourceSet> ResourceSets
);
