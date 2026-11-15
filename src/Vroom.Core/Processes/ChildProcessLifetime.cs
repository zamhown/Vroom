using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Vroom.Core.Processes;

/// <summary>Windows closes the job handle even after a host crash, terminating the owned process tree.</summary>
internal static class ChildProcessLifetime
{
    internal static Process? Start(ProcessStartInfo info)
    {
        if (OperatingSystem.IsMacOS() || OperatingSystem.IsMacCatalyst())
        {
            var driver = Path.Combine(Media.MediaRuntime.Directory, "share", "vulkan", "icd.d", "MoltenVK_icd.json");
            if (File.Exists(driver))
                info.Environment["VK_DRIVER_FILES"] = driver;
            var supervisor = Path.Combine(Media.MediaRuntime.Directory, "host", "vroom-process-host");
            if (File.Exists(supervisor))
            {
                // ArgumentList preserves spaces, Unicode and shell metacharacters literally.
                // Inherited stdio belongs to the tool; the supervisor uses kqueue, not stdin.
                info.ArgumentList.Insert(0, info.FileName);
                info.FileName = supervisor;
            }
        }
        return Process.Start(info);
    }

    internal static SafeFileHandle? Attach(Process process)
    {
        if (!OperatingSystem.IsWindows())
            return null;
        var job = CreateJobObjectW(0, null);
        var limits = new ExtendedLimits { Basic = new BasicLimits { Flags = 0x2000 } };
        if (
            job.IsInvalid
            || !SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf<ExtendedLimits>())
            || !AssignProcessToJobObject(job, process.Handle)
        )
        {
            var error = Marshal.GetLastWin32Error();
            job.Dispose();
            throw new System.ComponentModel.Win32Exception(error);
        }
        return job;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits
    {
        public long ProcessTime,
            JobTime;
        public uint Flags;
        public nuint MinWorkingSet,
            MaxWorkingSet;
        public uint ActiveProcesses;
        public nuint Affinity;
        public uint Priority,
            Scheduling;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOps,
            WriteOps,
            OtherOps,
            ReadBytes,
            WriteBytes,
            OtherBytes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits
    {
        public BasicLimits Basic;
        public IoCounters Io;
        public nuint ProcessMemory,
            JobMemory,
            PeakProcessMemory,
            PeakJobMemory;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateJobObjectW(nint attributes, string? name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        SafeFileHandle job,
        int infoClass,
        ref ExtendedLimits info,
        uint length
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(SafeFileHandle job, nint process);
}
