using System.Buffers.Binary;
using System.Security.Cryptography;
using Vroom.Core.Storage;

namespace Vroom.Core.Media;

public sealed record FileFingerprint(
    string Path,
    long Size,
    DateTimeOffset Modified,
    string? FileSystemIdentity,
    string Fingerprint
);

/// <summary>
/// Sampled content identity: SHA-256 over the length and three fixed 64 KiB windows (start, middle, end).
/// Files up to three windows long are hashed completely. Reading at most 192 KiB per file keeps
/// identity capture affordable on network storage; it is combined with the exact size and filesystem
/// identity, and every relink re-reads the target before committing.
/// </summary>
public static class ContentFingerprint
{
    public const string Scheme = "s1";
    private const int Window = 64 * 1024;

    public static async Task<FileFingerprint> ComputeAsync(string path, CancellationToken ct = default)
    {
        if (!System.IO.Path.IsPathFullyQualified(path))
            throw new ArgumentException("host.MediaStructure.invalidFiles");
        var before = new FileInfo(System.IO.Path.GetFullPath(path));
        if (!before.Exists || before.LinkTarget is not null)
            throw new IOException("host.Journey.mediaOffline");
        var size = before.Length;
        var modified = before.LastWriteTimeUtc;
        var identity = FileIdentity.Read(before.FullName);
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var header = new byte[8];
        BinaryPrimitives.WriteInt64LittleEndian(header, size);
        hash.AppendData(header);
        await using (
            var input = new FileStream(
                before.FullName,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read,
                Window,
                FileOptions.Asynchronous | FileOptions.RandomAccess
            )
        )
        {
            var buffer = new byte[Window];
            foreach (var offset in Offsets(size))
            {
                ct.ThrowIfCancellationRequested();
                input.Position = offset;
                var wanted = (int)Math.Min(Window, size - offset);
                var read = 0;
                while (read < wanted)
                {
                    var count = await input.ReadAsync(buffer.AsMemory(read, wanted - read), ct);
                    if (count == 0)
                        throw new InvalidOperationException("host.MediaStructure.fileChanged");
                    read += count;
                }
                hash.AppendData(buffer, 0, read);
            }
        }
        before.Refresh();
        if (
            !before.Exists
            || before.Length != size
            || before.LastWriteTimeUtc != modified
            || FileIdentity.Read(before.FullName) != identity
        )
            throw new InvalidOperationException("host.MediaStructure.fileChanged");
        return new(
            before.FullName,
            size,
            modified,
            identity,
            Scheme + ":" + Convert.ToHexStringLower(hash.GetHashAndReset())
        );
    }

    internal static IEnumerable<long> Offsets(long size)
    {
        if (size <= 3L * Window)
        {
            for (long offset = 0; offset < size; offset += Window)
                yield return offset;
            yield break;
        }
        yield return 0;
        yield return size / 2 - Window / 2;
        yield return size - Window;
    }
}
