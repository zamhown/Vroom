using System.Diagnostics;
using Vroom.Core.Processes;

namespace Vroom.Tests;

public sealed class WindowsProcessFactAttribute : FactAttribute
{
    public WindowsProcessFactAttribute()
    {
        if (!OperatingSystem.IsWindows())
            Skip = "Windows process ownership uses a kernel job object.";
    }
}

public sealed class ChildProcessLifetimeTests
{
    [WindowsProcessFact]
    public async Task ClosingTheHostOwnedHandleTerminatesItsChildProcess()
    {
        using var process = Process.Start(
            new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "ping.exe"))
            {
                ArgumentList = { "-n", "60", "127.0.0.1" },
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardOutput = true,
            }
        )!;
        try
        {
            using var ownership = ChildProcessLifetime.Attach(process);
            Assert.NotNull(ownership);
            Assert.False(process.HasExited);
            ownership.Dispose();
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            await process.WaitForExitAsync(timeout.Token);
        }
        finally
        {
            if (!process.HasExited)
                process.Kill(true);
        }
    }
}
