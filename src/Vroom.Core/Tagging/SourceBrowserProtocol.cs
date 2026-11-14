using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text.Json.Nodes;
using System.Threading.Channels;

namespace Vroom.Core.Tagging;

internal sealed class SourceBrowserProtocolException(int code, string message) : IOException(message)
{
    internal int Code { get; } = code;
}

// Only the private browser process uses this connection. No application RPC bridge is
// installed in a source page, and website content is never evaluated as host code.
internal sealed class SourceBrowserProtocol : IAsyncDisposable
{
    private readonly ClientWebSocket socket = new();
    private readonly SemaphoreSlim sendGate = new(1, 1);
    private readonly CancellationTokenSource stop = new();
    private readonly ConcurrentDictionary<int, TaskCompletionSource<JsonObject>> pending = new();
    private readonly Channel<JsonObject> events = Channel.CreateBounded<JsonObject>(1024);
    private int sequence;
    private Task? reader;
    internal ChannelReader<JsonObject> Events => events.Reader;

    internal async Task ConnectAsync(Uri address, CancellationToken ct)
    {
        if (address.Scheme != "ws" || !address.IsLoopback)
            throw new InvalidOperationException("Invalid local browser endpoint");
        socket.Options.Proxy = null;
        await socket.ConnectAsync(address, ct);
        reader = ReadAsync();
    }

    internal async Task<JsonObject> CallAsync(
        string method,
        object? args = null,
        string? session = null,
        CancellationToken ct = default
    )
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct, stop.Token);
        deadline.CancelAfter(TimeSpan.FromSeconds(15));
        var id = Interlocked.Increment(ref sequence);
        var completion = new TaskCompletionSource<JsonObject>(TaskCreationOptions.RunContinuationsAsynchronously);
        pending[id] = completion;
        try
        {
            var message = new JsonObject
            {
                ["id"] = id,
                ["method"] = method,
                ["params"] = System.Text.Json.JsonSerializer.SerializeToNode(args ?? new { }),
            };
            if (session is not null)
                message["sessionId"] = session;
            await sendGate.WaitAsync(deadline.Token);
            try
            {
                await socket.SendAsync(
                    System.Text.Encoding.UTF8.GetBytes(message.ToJsonString()),
                    WebSocketMessageType.Text,
                    true,
                    deadline.Token
                );
            }
            finally
            {
                sendGate.Release();
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
        Exception failure = new IOException("Browser connection closed");
        try
        {
            var buffer = new byte[65536];
            while (!stop.IsCancellationRequested)
            {
                using var data = new MemoryStream();
                WebSocketReceiveResult part;
                do
                {
                    part = await socket.ReceiveAsync(buffer, stop.Token);
                    if (part.MessageType == WebSocketMessageType.Close)
                        throw new IOException("Browser connection closed");
                    if (data.Length + part.Count > 32 * 1024 * 1024)
                        throw new IOException("Browser message exceeds limit");
                    data.Write(buffer, 0, part.Count);
                } while (!part.EndOfMessage);
                var message = JsonNode.Parse(data.ToArray())!.AsObject();
                if (message["id"] is { } id)
                {
                    if (!pending.TryRemove(id.GetValue<int>(), out var completion))
                        continue;
                    if (message["error"] is { } error)
                        completion.TrySetException(
                            new SourceBrowserProtocolException((int)error.Number("code"), error.Text("message"))
                        );
                    else
                        completion.TrySetResult(message["result"]?.AsObject() ?? new());
                }
                else if (!events.Writer.TryWrite(message))
                    throw new IOException("Browser event queue exceeds limit");
            }
        }
        catch (Exception ex)
        {
            failure = ex;
        }
        finally
        {
            foreach (var item in pending.Values)
                item.TrySetException(failure);
            events.Writer.TryComplete(failure);
        }
    }

    public async ValueTask DisposeAsync()
    {
        stop.Cancel();
        socket.Abort();
        if (reader is not null)
            await reader;
        socket.Dispose();
        stop.Dispose();
        sendGate.Dispose();
    }
}
