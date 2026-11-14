using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO.Pipes;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Vroom.Core.Application;
using Vroom.Core.Tagging;

namespace Vroom.Core.Media;

/// <summary>One decoder process and one private IPC connection per playback session.</summary>
public sealed class MpvProcess : IAsyncDisposable
{
    private readonly ConcurrentDictionary<long, TaskCompletionSource<JsonNode?>> pending = new();
    private readonly SemaphoreSlim writeGate = new(1, 1);
    private readonly CancellationTokenSource lifetime = new();
    private readonly object stateGate = new();
    private readonly JsonObject state = new();
    private readonly TaskCompletionSource loaded = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly LocalDiagnostics? log;
    private readonly string? tabId;
    private Microsoft.Win32.SafeHandles.SafeFileHandle? processJob;
    private Process? process;
    private Stream? pipe;
    private Task? reader,
        stderr,
        stdout;
    private string? socketPath,
        socketDirectory;
    private long sequence;
    private int disposed;
    private int stopping;
    public event Action<MpvInput>? InputReceived;

    public MpvProcess(LocalDiagnostics? log = null, string? tabId = null)
    {
        this.log = log;
        this.tabId = tabId;
    }

    public JsonObject Snapshot()
    {
        lock (stateGate)
            return state.DeepClone().AsObject();
    }

    public bool Exited
    {
        get
        {
            try
            {
                return disposed != 0 || process?.HasExited != false;
            }
            catch (InvalidOperationException)
            {
                return true;
            }
        }
    }
    public int ProcessId => process?.Id ?? 0;

    public async Task StartAsync(
        string executable,
        string file,
        double start,
        string directory,
        long windowId = 0,
        bool headless = false,
        CancellationToken ct = default
    )
    {
        var endpoint = "vroom-mpv-" + Guid.NewGuid().ToString("N");
        // Darwin's sockaddr_un path is only 104 bytes; TMPDIR often already consumes most of it.
        // A private, short directory also protects the socket before the client connects.
        if (!OperatingSystem.IsWindows())
        {
            socketDirectory = Path.Combine("/tmp", endpoint);
            Directory.CreateDirectory(
                socketDirectory,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
            );
            socketPath = Path.Combine(socketDirectory, "ipc");
        }
        try
        {
            var info = new ProcessStartInfo(executable)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            var embeddedInput = windowId != 0 || headless;
            foreach (
                var arg in new[]
                {
                    "--no-config",
                    "--load-scripts=no",
                    "--ytdl=no",
                    "--access-references=no",
                    "--idle=yes",
                    "--keep-open=yes",
                    "--pause=yes",
                    "--input-terminal=no",
                    "--terminal=yes",
                    "--msg-level=all=warn",
                    "--term-status-msg=",
                    "--osc=" + (embeddedInput ? "no" : "yes"),
                    "--input-default-bindings=" + (embeddedInput ? "no" : "yes"),
                    "--input-vo-keyboard=yes",
                    "--input-cursor-passthrough=no",
                    "--input-media-keys=no",
                    "--volume-max=200",
                    "--hwdec=auto-safe",
                    "--vo=" + (headless ? "null" : "gpu-next"),
                    "--input-ipc-server=" + (socketPath ?? endpoint),
                }
            )
                info.ArgumentList.Add(arg);
            if (embeddedInput)
            {
                var bindings = Path.Combine(directory, endpoint + ".input.conf");
                await File.WriteAllTextAsync(bindings, MpvInput.Bindings, ct);
                info.ArgumentList.Add("--input-conf=" + bindings);
                info.ArgumentList.Add("--window-dragging=no");
                info.ArgumentList.Add("--input-doubleclick-time=300");
            }
            if (windowId != 0)
                info.ArgumentList.Add("--wid=" + unchecked((uint)windowId));
            if (headless)
                info.ArgumentList.Add("--ao=null");
            else if (windowId == 0)
                info.ArgumentList.Add("--force-window=yes");
            info.WorkingDirectory = directory;
            process = Process.Start(info) ?? throw new IOException("host.Mpv.startFailed");
            stderr = DrainAsync(process.StandardError);
            stdout = DrainAsync(process.StandardOutput);
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct, lifetime.Token);
            deadline.CancelAfter(TimeSpan.FromSeconds(15));
            processJob = Vroom.Core.Processes.ChildProcessLifetime.Attach(process);
            if (OperatingSystem.IsWindows())
            {
                var stream = new NamedPipeClientStream(".", endpoint, PipeDirection.InOut, PipeOptions.Asynchronous);
                pipe = stream;
                await stream.ConnectAsync(deadline.Token);
            }
            else
            {
                while (!File.Exists(socketPath))
                {
                    deadline.Token.ThrowIfCancellationRequested();
                    if (process.HasExited)
                        throw new IOException("host.Mpv.startFailed");
                    await Task.Delay(30, deadline.Token);
                }
                File.SetUnixFileMode(socketPath!, UnixFileMode.UserRead | UnixFileMode.UserWrite);
                var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
                try
                {
                    await socket.ConnectAsync(new UnixDomainSocketEndPoint(socketPath!), deadline.Token);
                    pipe = new NetworkStream(socket, true);
                }
                catch
                {
                    socket.Dispose();
                    throw;
                }
            }
            reader = ReadAsync();
            var properties = new[]
            {
                "mpv-version",
                "time-pos",
                "duration",
                "pause",
                "seeking",
                "eof-reached",
                "paused-for-cache",
                "track-list",
                "chapter-list",
                "chapter",
                "audio-device-list",
                "audio-device",
                "aid",
                "sid",
                "secondary-sid",
                "vid",
                "video-params",
                "audio-params",
                "hwdec-current",
                "estimated-vf-fps",
                "frame-drop-count",
                "decoder-frame-drop-count",
                "avsync",
                "demuxer-cache-duration",
                "sub-text",
            };
            var observed = properties
                .Concat(
                    TagResources.Json("playback-capabilities.json")["nativePlayback"]!["settings"]!["properties"]!
                        .AsObject()
                        .Select(p => p.Key)
                )
                .Distinct()
                .ToArray();
            for (var i = 0; i < observed.Length; i++)
                await CommandAsync(["observe_property", i, observed[i]], deadline.Token);
            await CommandAsync(
                [
                    "loadfile",
                    file,
                    "replace",
                    -1,
                    new { start = start.ToString(System.Globalization.CultureInfo.InvariantCulture) },
                ],
                deadline.Token
            );
            await loaded.Task.WaitAsync(deadline.Token);
        }
        catch
        {
            await DisposeAsync();
            throw;
        }
    }

    public async Task<JsonNode?> CommandAsync(object?[] command, CancellationToken ct = default)
    {
        ObjectDisposedException.ThrowIf(disposed != 0 || stopping != 0, this);
        var id = Interlocked.Increment(ref sequence);
        var completion = new TaskCompletionSource<JsonNode?>(TaskCreationOptions.RunContinuationsAsynchronously);
        pending[id] = completion;
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct, lifetime.Token);
        deadline.CancelAfter(TimeSpan.FromSeconds(8));
        try
        {
            var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { command, request_id = id }) + "\n");
            await writeGate.WaitAsync(deadline.Token);
            try
            {
                await pipe!.WriteAsync(bytes, deadline.Token);
                await pipe.FlushAsync(deadline.Token);
            }
            finally
            {
                writeGate.Release();
            }
            return await completion.Task.WaitAsync(deadline.Token);
        }
        finally
        {
            pending.TryRemove(id, out _);
        }
    }

    private async Task ReadAsync()
    {
        try
        {
            using var input = new StreamReader(pipe!, Encoding.UTF8, false, 8192, leaveOpen: true);
            while (await input.ReadLineAsync(lifetime.Token) is { } line)
            {
                if (line.Length > 2_000_000)
                    throw new IOException("host.Mpv.invalidReply");
                var message = JsonNode.Parse(line)!.AsObject();
                if (message["request_id"]?.GetValue<long>() is { } id && pending.TryRemove(id, out var request))
                {
                    if (message["error"]?.GetValue<string>() == "success")
                        request.TrySetResult(message["data"]?.DeepClone());
                    else
                        request.TrySetException(
                            new IOException("host.Mpv.commandFailed").Localize(
                                "host.Mpv.commandFailed",
                                message["error"]?.ToString()
                            )
                        );
                }
                if (
                    message["event"]?.GetValue<string>() == "property-change"
                    && message["name"]?.GetValue<string>() is { } name
                )
                    lock (stateGate)
                        state[name] = message["data"]?.DeepClone();
                if (message["event"]?.GetValue<string>() == "file-loaded")
                    loaded.TrySetResult();
                if (
                    message["event"]?.GetValue<string>() == "client-message"
                    && MpvInput.Parse(message["args"]) is { } gesture
                )
                {
                    try
                    {
                        InputReceived?.Invoke(gesture);
                    }
                    catch (Exception ex)
                    {
                        log?.Error("mpv.input", ex, tabId);
                    }
                }
                if (
                    message["event"]?.GetValue<string>() == "end-file"
                    && message["reason"]?.GetValue<string>() == "error"
                )
                {
                    var failure = new IOException("host.Mpv.loadFailed");
                    loaded.TrySetException(failure);
                    log?.Write("mpv.load", message["file_error"]?.ToString() ?? failure.Message, tabId: tabId);
                    lock (stateGate)
                        state["failure"] = failure.Message;
                }
            }
            if (!lifetime.IsCancellationRequested)
                throw new IOException("host.Mpv.disconnected");
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            if (!lifetime.IsCancellationRequested)
            {
                log?.Error("mpv.ipc", ex, tabId);
                lock (stateGate)
                    state["failure"] = "host.Mpv.disconnected";
            }
            loaded.TrySetException(ex);
            foreach (var request in pending.Values)
                request.TrySetException(ex);
        }
    }

    private async Task DrainAsync(StreamReader input)
    {
        try
        {
            while (await input.ReadLineAsync(lifetime.Token) is { } line)
                if (line.Length > 0)
                    log?.Write("mpv.process", line, tabId: tabId);
        }
        catch (OperationCanceledException) { }
    }

    public void Terminate()
    {
        if (Interlocked.Exchange(ref stopping, 1) != 0)
            return;
        lifetime.Cancel();
        pipe?.Dispose();
        foreach (var request in pending.Values)
            request.TrySetCanceled();
        if (process is not null)
            FfmpegService.Kill(process);
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0)
            return;
        Terminate();
        if (process is not null)
        {
            FfmpegService.Kill(process);
            try
            {
                await process.WaitForExitAsync();
            }
            catch (InvalidOperationException) { }
            process.Dispose();
        }
        processJob?.Dispose();
        try
        {
            await Task.WhenAll(new[] { reader, stderr, stdout }.Where(t => t is not null).Cast<Task>());
        }
        catch (Exception ex) when (ex is IOException or OperationCanceledException or ObjectDisposedException) { }
        if (socketPath is not null)
            try
            {
                File.Delete(socketPath);
            }
            catch (IOException) { }
        if (socketDirectory is not null)
            try
            {
                Directory.Delete(socketDirectory);
            }
            catch (IOException) { }
        lifetime.Dispose();
    }
}
