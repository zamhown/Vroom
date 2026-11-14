using System.Net;
using System.Text.Json.Serialization;
using Vroom.Core.Domain;
using Vroom.Core.Storage;
using Vroom.Core.Tagging;

namespace Vroom.Core.Network;

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record NetworkOptions(string Mode = "system", string ProxyUrl = "", bool RetryOnReconnect = true)
{
    public void Validate()
    {
        if (
            Mode is not ("system" or "direct" or "custom")
            || ProxyUrl.Length > 2048
            || (
                ProxyUrl.Length > 0
                && (
                    !Uri.TryCreate(ProxyUrl, UriKind.Absolute, out var uri)
                    || uri.Scheme is not ("http" or "https" or "socks4" or "socks5")
                    || uri.Host.Length == 0
                    || uri.UserInfo.Length > 0
                    || uri.AbsolutePath != "/"
                    || uri.Query.Length > 0
                    || uri.Fragment.Length > 0
                )
            )
            || (Mode == "custom" && ProxyUrl.Length == 0)
        )
            throw new ArgumentException("host.Network.invalidProxy");
    }
}

public sealed record NetworkStatus(string State, DateTimeOffset? CheckedAt, string Mode, long Revision);

// One host-owned routing policy for public HTTP and browser traffic. Loopback RPC,
// media streaming, and browser control do not use this service.
public sealed class NetworkService : IDisposable
{
    private readonly CatalogRepository repository;
    private readonly Func<IWebProxy, CancellationToken, Task<bool>> probe;
    private readonly SemaphoreSlim gate = new(1, 1);
    private NetworkOptions options = new();
    private NetworkStatus status = new("unknown", null, "system", 0);
    private long revision;
    private bool onlineAllowed;
    public NetworkStatus Status => Volatile.Read(ref status);
    public NetworkOptions Options => Volatile.Read(ref options);
    public event Action? Changed;

    public NetworkService(CatalogRepository repository)
        : this(repository, ProbeAsync) { }

    internal NetworkService(CatalogRepository repository, Func<IWebProxy, CancellationToken, Task<bool>> probe)
    {
        this.repository = repository;
        this.probe = probe;
        repository.SettingsChanged += SettingsChanged;
    }

    public async Task InitializeAsync(CancellationToken ct = default) =>
        SettingsChanged(await repository.SettingsAsync(ct));

    private void SettingsChanged(AppSettings settings)
    {
        settings.Network.Validate();
        var permissionChanged = onlineAllowed != settings.OnlineMetadata;
        onlineAllowed = settings.OnlineMetadata;
        var previous = Interlocked.Exchange(ref options, settings.Network);
        if (previous == settings.Network)
        {
            if (permissionChanged)
                Changed?.Invoke();
            return;
        }
        var next = Interlocked.Increment(ref revision);
        Volatile.Write(ref status, new("unknown", null, settings.Network.Mode, next));
        Changed?.Invoke();
    }

    // Consumers capture a route for one operation; changing settings never tears down
    // an in-flight request or mixes proxy choices within a browser navigation.
    internal IWebProxy CaptureProxy() => ProxyFor(Options);

    internal static IWebProxy ProxyFor(NetworkOptions value) =>
        value.Mode switch
        {
            "direct" => new WebProxy(),
            "custom" => new WebProxy(value.ProxyUrl),
            _ => HttpClient.DefaultProxy,
        };

    public async Task<NetworkStatus> CheckAsync(CancellationToken ct = default)
    {
        await gate.WaitAsync(ct);
        try
        {
            var selected = Options;
            var currentRevision = Volatile.Read(ref revision);
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
            deadline.CancelAfter(TimeSpan.FromSeconds(10));
            bool online;
            try
            {
                online = await probe(ProxyFor(selected), deadline.Token);
            }
            catch (Exception e)
                when (!ct.IsCancellationRequested
                    && e is HttpRequestException or IOException or OperationCanceledException or TagException
                )
            {
                online = false;
            }
            ct.ThrowIfCancellationRequested();
            if (currentRevision == Volatile.Read(ref revision))
                Volatile.Write(
                    ref status,
                    new(online ? "online" : "offline", DateTimeOffset.UtcNow, selected.Mode, currentRevision)
                );
            return Status;
        }
        finally
        {
            gate.Release();
        }
    }

    private static async Task<bool> ProbeAsync(IWebProxy route, CancellationToken ct)
    {
        using var client = new SourceHttpClient(route);
        // Exact small bodies distinguish an Internet response from a captive portal.
        var probes = new[]
        {
            ("https://www.msftconnecttest.com/connecttest.txt", "Microsoft Connect Test"),
            (
                "https://captive.apple.com/hotspot-detect.html",
                "<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>"
            ),
        };
        var results = await Task.WhenAll(
            probes.Select(async item =>
            {
                try
                {
                    using var response = await client.GetAsync(new(item.Item1), ct);
                    if (!response.IsSuccessStatusCode || response.Content.Headers.ContentLength > 4096)
                        return false;
                    await using var stream = await response.Content.ReadAsStreamAsync(ct);
                    using var output = new MemoryStream();
                    var buffer = new byte[1024];
                    int read;
                    while ((read = await stream.ReadAsync(buffer, ct)) > 0)
                    {
                        if (output.Length + read > 4096)
                            return false;
                        output.Write(buffer, 0, read);
                    }
                    return System.Text.Encoding.UTF8.GetString(output.ToArray()).Trim() == item.Item2;
                }
                catch (Exception e)
                    when (e is HttpRequestException or IOException or OperationCanceledException or TagException)
                {
                    return false;
                }
            })
        );
        return results.Any(value => value);
    }

    public void Dispose()
    {
        repository.SettingsChanged -= SettingsChanged;
    }
}
