using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Vroom.Core.Storage;

internal static class FileIdentity
{
    [StructLayout(LayoutKind.Sequential)]
    private struct FileIdInfo
    {
        public ulong Volume;
        public ulong Low;
        public ulong High;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandleEx(
        SafeFileHandle handle,
        int kind,
        out FileIdInfo value,
        uint size
    );

    // Unix identity without a process per file: statx on Linux and lstat on Apple platforms, read from a
    // byte buffer larger than either structure so an unexpected layout can never corrupt memory. The
    // format matches the stat(1) fallback (device:inode:birth seconds).
    [DllImport("libc", EntryPoint = "statx", SetLastError = true)]
    private static extern int Statx(int dirfd, string path, int flags, uint mask, byte[] buffer);

    [DllImport("libc", EntryPoint = "lstat", SetLastError = true)]
    private static extern int LstatArm64(string path, byte[] buffer);

    [DllImport("libc", EntryPoint = "lstat$INODE64", SetLastError = true)]
    private static extern int LstatX64(string path, byte[] buffer);

    private static string? Native(string path)
    {
        try
        {
            var buffer = new byte[512];
            if (OperatingSystem.IsLinux())
            {
                const int AtFdCwd = -100,
                    AtSymlinkNoFollow = 0x100;
                const uint StatxIno = 0x100,
                    StatxBtime = 0x800;
                if (Statx(AtFdCwd, path, AtSymlinkNoFollow, StatxIno | StatxBtime, buffer) != 0)
                    return null;
                var mask = BitConverter.ToUInt32(buffer, 0);
                var inode = BitConverter.ToUInt64(buffer, 32);
                var birth = (mask & StatxBtime) != 0 ? BitConverter.ToInt64(buffer, 80) : 0;
                ulong major = BitConverter.ToUInt32(buffer, 136),
                    minor = BitConverter.ToUInt32(buffer, 140);
                // glibc makedev(), the value stat(1) prints for %d.
                var device =
                    ((major & 0xfffff000) << 32)
                    | ((major & 0xfff) << 8)
                    | ((minor & 0xffffff00) << 12)
                    | (minor & 0xff);
                return inode == 0 ? null : $"unix:{device}:{inode}:{birth}";
            }
            var result =
                RuntimeInformation.ProcessArchitecture == Architecture.Arm64
                    ? LstatArm64(path, buffer)
                    : LstatX64(path, buffer);
            if (result != 0)
                return null;
            var dev = BitConverter.ToInt32(buffer, 0);
            var ino = BitConverter.ToUInt64(buffer, 8);
            var born = BitConverter.ToInt64(buffer, 80);
            return ino == 0 ? null : $"unix:{dev}:{ino}:{born}";
        }
        catch (Exception e) when (e is DllNotFoundException or EntryPointNotFoundException)
        {
            return null;
        }
    }

    internal static string? Read(string path)
    {
        try
        {
            if (!File.Exists(path))
                return null;
            if (OperatingSystem.IsWindows())
            {
                using var handle = File.OpenHandle(
                    path,
                    FileMode.Open,
                    FileAccess.Read,
                    FileShare.ReadWrite | FileShare.Delete
                );
                if (!GetFileInformationByHandleEx(handle, 18, out var id, 24) || id.Low == 0 && id.High == 0)
                    return null;
                return $"win:{id.Volume:x16}:{id.High:x16}{id.Low:x16}:{File.GetCreationTimeUtc(path).Ticks}";
            }
            if (!OperatingSystem.IsMacOS() && !OperatingSystem.IsMacCatalyst() && !OperatingSystem.IsLinux())
                return null;
            if (Native(path) is { } native)
                return native;
            var info = new ProcessStartInfo("/usr/bin/stat")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            foreach (
                var arg in OperatingSystem.IsLinux()
                    ? new[] { "--printf=%d:%i:%W", "--", path }
                    : new[] { "-f", "%d:%i:%B", path }
            )
                info.ArgumentList.Add(arg);
            using var process = Process.Start(info);
            if (process is null)
                return null;
            var output = process.StandardOutput.ReadToEndAsync();
            var error = process.StandardError.ReadToEndAsync();
            if (!process.WaitForExit(2000))
            {
                process.Kill(entireProcessTree: true);
                return null;
            }
            var value = output.GetAwaiter().GetResult().Trim();
            error.GetAwaiter().GetResult();
            return
                process.ExitCode == 0
                && value.Length < 128
                && value.Split(':').Length == 3
                && value.All(c => char.IsAsciiDigit(c) || c == ':')
                ? "unix:" + value
                : null;
        }
        catch (Exception e)
            when (e is IOException or UnauthorizedAccessException or System.ComponentModel.Win32Exception)
        {
            return null;
        }
    }
}
