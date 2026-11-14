using System.Text.Json;
using System.Text.RegularExpressions;

namespace Vroom.Core.Application;

/// <summary>Bounded, synchronous crash breadcrumbs, independent of the catalog and its transactions.</summary>
public sealed class LocalDiagnostics : IDisposable
{
    private readonly object gate = new();
    private readonly long maxBytes;
    public string FilePath { get; }

    public LocalDiagnostics(string dataDirectory, long maxBytes = 2 * 1024 * 1024)
    {
        this.maxBytes = Math.Max(1024, maxBytes);
        FilePath = Path.Combine(dataDirectory, "logs", $"vroom-{Environment.ProcessId}.jsonl");
    }

    public bool Write(string source, string message, string? stack = null, string? tabId = null)
    {
        try
        {
            var record = JsonSerializer.Serialize(
                new
                {
                    time = DateTimeOffset.UtcNow,
                    source = Clean(source, 200),
                    message = Clean(message, 4000),
                    stack = Clean(stack, 12000),
                    tabId = Clean(tabId, 200),
                }
            );
            lock (gate)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
                foreach (
                    var old in new DirectoryInfo(Path.GetDirectoryName(FilePath)!)
                        .GetFiles("vroom-*.jsonl*")
                        .OrderByDescending(f => f.LastWriteTimeUtc)
                        .Skip(19)
                )
                    if (old.FullName != FilePath)
                        old.Delete();
                if (
                    File.Exists(FilePath)
                    && new FileInfo(FilePath).Length + System.Text.Encoding.UTF8.GetByteCount(record) > maxBytes
                )
                {
                    for (var i = 4; i >= 1; i--)
                    {
                        var previous = i == 1 ? FilePath : FilePath + "." + (i - 1);
                        if (File.Exists(previous))
                            File.Move(previous, FilePath + "." + i, true);
                    }
                }
                File.AppendAllText(FilePath, record + Environment.NewLine);
            }
            return true;
        }
        catch (Exception ex)
            when (ex is IOException or UnauthorizedAccessException or System.Security.SecurityException)
        {
            return false;
        }
    }

    public void Error(string source, Exception error, string? tabId = null)
    {
        try
        {
            Write(source, error.Message, error + "\n" + JsonSerializer.Serialize(HostMessages.Arguments(error)), tabId);
        }
        catch (Exception)
        { /* Even malformed diagnostic arguments must not replace the original failure. */
        }
    }

    private static string? Clean(string? text, int limit)
    {
        if (text is null)
            return null;
        text = text[..Math.Min(text.Length, limit)];
        // Capability URLs must never be persisted in diagnostics.
        return Regex.Replace(text, @"https?://[^\s""<>]+", "[url]", RegexOptions.IgnoreCase);
    }

    public void ObserveProcess()
    {
        AppDomain.CurrentDomain.UnhandledException += OnUnhandled;
        TaskScheduler.UnobservedTaskException += OnUnobserved;
    }

    private void OnUnhandled(object sender, UnhandledExceptionEventArgs e) =>
        Error("process.unhandled", e.ExceptionObject as Exception ?? new Exception("Unhandled host failure"));

    private void OnUnobserved(object? sender, UnobservedTaskExceptionEventArgs e)
    {
        Error("process.task", e.Exception);
        e.SetObserved();
    }

    public void Dispose()
    {
        AppDomain.CurrentDomain.UnhandledException -= OnUnhandled;
        TaskScheduler.UnobservedTaskException -= OnUnobserved;
    }
}
