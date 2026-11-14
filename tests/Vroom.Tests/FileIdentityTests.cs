using Vroom.Core.Storage;

namespace Vroom.Tests;

/// <summary>Runs on every CI platform: Windows handles, Linux statx and Apple lstat.</summary>
public sealed class FileIdentityTests : IDisposable
{
    private readonly string directory = Path.Combine(Path.GetTempPath(), "vroom-tests", Guid.NewGuid().ToString("N"));

    public FileIdentityTests() => Directory.CreateDirectory(directory);

    public void Dispose() => Directory.Delete(directory, true);

    [Fact]
    public void IdentityIsStableForAFileAndDistinctAcrossFiles()
    {
        var first = Path.Combine(directory, "a.mp4");
        var second = Path.Combine(directory, "b.mp4");
        File.WriteAllText(first, "a");
        File.WriteAllText(second, "b");
        var identity = FileIdentity.Read(first);
        Assert.NotNull(identity);
        Assert.Equal(identity, FileIdentity.Read(first));
        Assert.NotEqual(identity, FileIdentity.Read(second));
        var moved = Path.Combine(directory, "moved.mp4");
        File.Move(first, moved);
        Assert.Equal(identity, FileIdentity.Read(moved));
        Assert.Null(FileIdentity.Read(first));
    }
}
