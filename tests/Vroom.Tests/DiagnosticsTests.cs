using System.Text.Json;
using Vroom.Core.Application;

namespace Vroom.Tests;

public sealed class DiagnosticsTests
{
    [Fact]
    public async Task ConcurrentErrorsRemainParseableBoundedAndRedactCapabilityUrls()
    {
        var directory = Path.Combine(Path.GetTempPath(), "vroom-diagnostics-" + Guid.NewGuid().ToString("N"));
        try
        {
            using var log = new LocalDiagnostics(directory, 2048);
            await Task.WhenAll(
                Enumerable
                    .Range(0, 80)
                    .Select(i =>
                        Task.Run(() =>
                            Assert.True(
                                log.Write(
                                    "client",
                                    "failure\nhttp://127.0.0.1:8000/secret/media",
                                    new string('x', 100),
                                    "tab-" + i
                                )
                            )
                        )
                    )
            );
            var files = Directory.GetFiles(Path.Combine(directory, "logs"));
            Assert.InRange(files.Length, 2, 5);
            foreach (var path in files)
            {
                Assert.InRange(new FileInfo(path).Length, 1, 2048);
                foreach (var line in await File.ReadAllLinesAsync(path))
                {
                    using var json = JsonDocument.Parse(line);
                    Assert.StartsWith("tab-", json.RootElement.GetProperty("tabId").GetString());
                    Assert.DoesNotContain("secret", line);
                }
            }
        }
        finally
        {
            if (Directory.Exists(directory))
                Directory.Delete(directory, true);
        }
    }

    [Fact]
    public void UnwritableLogDoesNotCrashTheCaller()
    {
        var file = Path.GetTempFileName();
        try
        {
            using var log = new LocalDiagnostics(file);
            Assert.False(log.Write("test", "failure"));
        }
        finally
        {
            File.Delete(file);
        }
    }

    [Fact]
    public void MalformedDiagnosticArgumentsDoNotReplaceTheOriginalFailure()
    {
        using var log = new LocalDiagnostics(Path.GetTempPath());
        var cyclic = new Dictionary<string, object?>();
        cyclic["self"] = cyclic;
        var error = new InvalidOperationException("fixture");
        error.Data["messageArgs"] = cyclic;
        log.Error("fixture", error);
    }
}
