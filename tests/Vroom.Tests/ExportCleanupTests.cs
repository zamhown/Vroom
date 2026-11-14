using Vroom.Core.Media;

namespace Vroom.Tests;

public sealed class WindowsFileLockFactAttribute : FactAttribute
{
    public WindowsFileLockFactAttribute()
    {
        if (!OperatingSystem.IsWindows())
            Skip = "Windows sharing violations are required for this test.";
    }
}

public sealed class ExportCleanupTests : IDisposable
{
    private readonly string directory = Path.Combine(
        Path.GetTempPath(),
        "vroom-cleanup-" + Guid.NewGuid().ToString("N")
    );

    public ExportCleanupTests() => Directory.CreateDirectory(directory);

    [WindowsFileLockFact]
    public async Task TemporaryEncoderLockIsRetriedWithoutRemovingPublishedOutput()
    {
        var staged = Path.Combine(directory, "staged.mp4");
        var published = Path.Combine(directory, "published.mp4");
        await File.WriteAllTextAsync(published, "keep this existing output");
        using var held = new FileStream(staged, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None);
        var cleanup = VideoExportService.DeleteStagingFileAsync(staged);
        await Task.Delay(100);
        Assert.False(cleanup.IsCompleted);
        held.Dispose();
        await cleanup.WaitAsync(TimeSpan.FromSeconds(3));
        Assert.False(File.Exists(staged));
        Assert.Equal("keep this existing output", await File.ReadAllTextAsync(published));
    }

    [WindowsFileLockFact]
    public async Task PersistentLockReportsFailureAndPreservesTheFile()
    {
        var staged = Path.Combine(directory, "staged.mp4");
        using var held = new FileStream(staged, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None);
        await Assert.ThrowsAsync<IOException>(() => VideoExportService.DeleteStagingFileAsync(staged));
        Assert.True(File.Exists(staged));
    }

    public void Dispose() => Directory.Delete(directory, recursive: true);
}
