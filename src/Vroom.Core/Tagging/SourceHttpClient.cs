using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;

namespace Vroom.Core.Tagging;

// The proxy is host configuration, never part of a source definition. The OS proxy is
// trusted to route public destinations; source URLs must still pass destination checks.
internal sealed class SourceHttpClient : IDisposable
{
    internal const int MaximumRedirects = 10;

    internal SourceHttpClient CreateSession(IWebProxy? route = null) => new(route ?? proxy, resolve, connect);

    private readonly IWebProxy proxy;
    private readonly Func<string, CancellationToken, Task<IPAddress[]>> resolve;
    private readonly Func<IPAddress, int, CancellationToken, ValueTask<Stream>> connect;
    private readonly HttpClient direct;
    private readonly CookieContainer cookies = new();
    private readonly ConcurrentDictionary<Uri, Lazy<HttpClient>> proxied = new();

    internal SourceHttpClient(
        IWebProxy? proxy = null,
        Func<string, CancellationToken, Task<IPAddress[]>>? resolve = null,
        Func<IPAddress, int, CancellationToken, ValueTask<Stream>>? connect = null,
        HttpMessageHandler? handler = null
    )
    {
        this.proxy = proxy ?? HttpClient.DefaultProxy;
        this.resolve = resolve ?? ((host, ct) => Dns.GetHostAddressesAsync(host, ct));
        this.connect = connect ?? ConnectAsync;
        direct = handler is null ? Create(null) : new HttpClient(handler);
    }

    internal async Task<HttpResponseMessage> GetAsync(Uri uri, CancellationToken ct, Uri? referrer = null)
    {
        for (var hop = 0; ; hop++)
        {
            ct.ThrowIfCancellationRequested();
            var response = await SendAsync(uri, ct, referrer);
            if ((int)response.StatusCode is not (301 or 302 or 303 or 307 or 308))
                return response;
            using (response)
            {
                if (hop >= MaximumRedirects)
                    throw new TagException("SOURCE_REDIRECT_LIMIT", detail: "host.SourceHttp.redirectLimit");
                uri = RedirectTarget(uri, response);
            }
        }
    }

    internal static Uri RedirectTarget(Uri current, HttpResponseMessage response)
    {
        var locations = response.Headers.TryGetValues("Location", out var values) ? values.ToArray() : [];
        if (
            locations.Length != 1
            || string.IsNullOrWhiteSpace(locations[0])
            || !Uri.TryCreate(current, locations[0], out var next)
        )
            throw new TagException("SOURCE_REDIRECT_INVALID", detail: "host.SourceHttp.redirectInvalid");
        if (current.Scheme == "https" && next.Scheme == "http")
            throw new TagException("SOURCE_REDIRECT_DOWNGRADE", detail: "host.SourceHttp.redirectDowngrade");
        return next;
    }

    // Credential-bearing APIs use one request and reject redirects at their caller.
    internal Task<HttpResponseMessage> SendOnceAsync(
        Uri uri,
        HttpMethod method,
        string? json,
        IReadOnlyDictionary<string, string> headers,
        CancellationToken ct
    ) => SendAsync(uri, ct, null, method, json, headers);

    private async Task<HttpResponseMessage> SendAsync(
        Uri uri,
        CancellationToken ct,
        Uri? referrer,
        HttpMethod? method = null,
        string? json = null,
        IReadOnlyDictionary<string, string>? headers = null
    )
    {
        if (!uri.IsAbsoluteUri || uri.Scheme is not ("https" or "http") || uri.IsLoopback || uri.UserInfo.Length > 0)
            throw new TagException("SOURCE_ADDRESS_FORBIDDEN");
        // Check every request, including reused proxy connections, before sending data.
        var addresses = await resolve(uri.IdnHost, ct);
        if (addresses.Length == 0)
            throw new HttpRequestException("SOURCE_HOST_UNAVAILABLE");
        foreach (var address in addresses)
            ValidateAddress(address);
        var route = proxy.IsBypassed(uri) ? null : proxy.GetProxy(uri);
        var client =
            route is null || route == uri ? direct : proxied.GetOrAdd(route, key => new(() => Create(key))).Value;
        using var request = new HttpRequestMessage(method ?? HttpMethod.Get, uri);
        if (headers is null || !headers.Keys.Any(k => k.Equals("User-Agent", StringComparison.OrdinalIgnoreCase)))
            request.Headers.UserAgent.ParseAdd("Vroom/3.0.0");
        if (json is not null)
            request.Content = new StringContent(json, System.Text.Encoding.UTF8, "application/json");
        if (headers is not null)
            foreach (var header in headers)
                request.Headers.Add(header.Key, header.Value);
        if (
            referrer is not null
            && referrer.Scheme is "http" or "https"
            && !(referrer.Scheme == "https" && uri.Scheme == "http")
        )
            request.Headers.Referrer =
                referrer.GetLeftPart(UriPartial.Authority) == uri.GetLeftPart(UriPartial.Authority)
                    ? referrer
                    : new Uri(referrer.GetLeftPart(UriPartial.Authority) + "/");
        return await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
    }

    private HttpClient Create(Uri? route) =>
        new(
            new SocketsHttpHandler
            {
                AllowAutoRedirect = false,
                UseProxy = route is not null,
                CookieContainer = cookies,
                Proxy = route is null ? null : new WebProxy(route) { Credentials = proxy.Credentials },
                ConnectTimeout = TimeSpan.FromSeconds(15),
                PooledConnectionLifetime = TimeSpan.FromMinutes(2),
                ConnectCallback = async (context, ct) =>
                {
                    var endpoint = context.DnsEndPoint;
                    if (
                        route is not null
                        && (
                            !endpoint.Host.Equals(route.IdnHost, StringComparison.OrdinalIgnoreCase)
                            || endpoint.Port != route.Port
                        )
                    )
                        throw new TagException("SOURCE_ADDRESS_FORBIDDEN");
                    var addresses = await resolve(endpoint.Host, ct);
                    // Direct connections validate their actual socket address, preventing DNS rebinding.
                    // Local addresses are allowed only for the selected, host-configured proxy endpoint.
                    if (route is null)
                        foreach (var address in addresses)
                            ValidateAddress(address);
                    Exception? last = null;
                    foreach (var address in addresses)
                    {
                        ct.ThrowIfCancellationRequested();
                        try
                        {
                            return await connect(address, endpoint.Port, ct);
                        }
                        catch (Exception error) when (error is SocketException or IOException)
                        {
                            last = error;
                        }
                    }
                    throw new HttpRequestException("SOURCE_HOST_UNAVAILABLE", last);
                },
            }
        )
        {
            Timeout = TimeSpan.FromSeconds(20),
        };

    internal static void ValidateAddress(IPAddress address)
    {
        if (address.IsIPv4MappedToIPv6)
            address = address.MapToIPv4();
        if (
            IPAddress.IsLoopback(address)
            || address.IsIPv6LinkLocal
            || address.IsIPv6Multicast
            || address.IsIPv6SiteLocal
        )
            throw new TagException("SOURCE_ADDRESS_FORBIDDEN");
        if (address.AddressFamily == AddressFamily.InterNetworkV6)
        {
            if ((address.GetAddressBytes()[0] & 0xfe) == 0xfc || address.Equals(IPAddress.IPv6Any))
                throw new TagException("SOURCE_ADDRESS_FORBIDDEN");
            return;
        }
        var b = address.GetAddressBytes();
        if (
            b[0] is 0 or 10 or 127
            || b[0] >= 224
            || b[0] == 169 && b[1] == 254
            || b[0] == 192 && b[1] == 168
            || b[0] == 172 && b[1] >= 16 && b[1] <= 31
        )
            throw new TagException("SOURCE_ADDRESS_FORBIDDEN");
    }

    private static async ValueTask<Stream> ConnectAsync(IPAddress address, int port, CancellationToken ct)
    {
        var socket = new Socket(address.AddressFamily, SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
        try
        {
            await socket.ConnectAsync(address, port, ct);
            return new NetworkStream(socket, true);
        }
        catch
        {
            socket.Dispose();
            throw;
        }
    }

    public void Dispose()
    {
        direct.Dispose();
        foreach (var client in proxied.Values)
            if (client.IsValueCreated)
                client.Value.Dispose();
    }
}
