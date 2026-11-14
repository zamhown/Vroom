using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using Vroom.Core.Tagging;

namespace Vroom.Tests;

public sealed class SourceProxyTests
{
    private static readonly IPAddress PublicAddress = IPAddress.Parse("93.184.215.14");

    private static Task<IPAddress[]> Resolve(string host, CancellationToken ct) =>
        Task.FromResult(new[] { IPAddress.TryParse(host, out var ip) ? ip : PublicAddress });

    private static async Task<string> Headers(Stream stream, CancellationToken ct)
    {
        var bytes = new List<byte>();
        var next = new byte[1];
        while (bytes.Count < 65536 && await stream.ReadAsync(next, ct) > 0)
        {
            bytes.Add(next[0]);
            if (bytes.Count >= 4 && Encoding.ASCII.GetString(bytes.TakeLast(4).ToArray()) == "\r\n\r\n")
                return Encoding.ASCII.GetString(bytes.ToArray());
        }
        throw new IOException("Incomplete headers");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task PublicHttpUsesConfiguredLocalProxyAndPreservesDestination(bool socks)
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var served = Task.Run(async () =>
        {
            using var peer = await listener.AcceptTcpClientAsync(timeout.Token);
            await using var stream = peer.GetStream();
            if (socks)
            {
                var greeting = new byte[2];
                await stream.ReadExactlyAsync(greeting, timeout.Token);
                Assert.Equal(5, greeting[0]);
                var methods = new byte[greeting[1]];
                await stream.ReadExactlyAsync(methods, timeout.Token);
                await stream.WriteAsync(new byte[] { 5, 0 }, timeout.Token);
                var command = new byte[4];
                await stream.ReadExactlyAsync(command, timeout.Token);
                Assert.Equal(1, command[1]);
                Assert.Equal(3, command[3]);
                var length = new byte[1];
                await stream.ReadExactlyAsync(length, timeout.Token);
                var target = new byte[length[0] + 2];
                await stream.ReadExactlyAsync(target, timeout.Token);
                Assert.Equal("public.example", Encoding.ASCII.GetString(target[..^2]));
                await stream.WriteAsync(new byte[] { 5, 0, 0, 1, 127, 0, 0, 1, 0, 80 }, timeout.Token);
            }
            var request = await Headers(stream, timeout.Token);
            Assert.StartsWith(
                socks ? "GET /record?x=1 HTTP/1.1" : "GET http://public.example/record?x=1 HTTP/1.1",
                request
            );
            Assert.Contains("Host: public.example", request);
            await stream.WriteAsync(
                Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK"),
                timeout.Token
            );
        });
        using var client = new SourceHttpClient(
            new WebProxy($"{(socks ? "socks5" : "http")}://127.0.0.1:{port}"),
            Resolve
        );
        using var response = await client.GetAsync(new("http://public.example/record?x=1"), timeout.Token);
        Assert.Equal("OK", await response.Content.ReadAsStringAsync(timeout.Token));
        await served;
    }

    [Fact]
    public async Task HttpsUsesConnectTunnelAndPreservesProxyFailures()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var served = Task.Run(async () =>
        {
            using var peer = await listener.AcceptTcpClientAsync(timeout.Token);
            await using var stream = peer.GetStream();
            Assert.StartsWith("CONNECT public.example:443 HTTP/1.1", await Headers(stream, timeout.Token));
            // This fixture refuses the tunnel. The caller must preserve the proxy error.
            await stream.WriteAsync(
                Encoding.ASCII.GetBytes("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
                timeout.Token
            );
        });
        using var client = new SourceHttpClient(new WebProxy($"http://127.0.0.1:{port}"), Resolve);
        var error = await Assert.ThrowsAsync<HttpRequestException>(() =>
            client.GetAsync(new("https://public.example/item"), timeout.Token)
        );
        Assert.DoesNotContain("SOURCE_ADDRESS_FORBIDDEN", error.ToString());
        Assert.Contains("502", error.Message);
        await served;
    }

    [Fact]
    public async Task ProxiedHttpsStillRejectsAnUntrustedCertificate()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        using var key = RSA.Create(2048);
        var request = new CertificateRequest(
            "CN=public.example",
            key,
            HashAlgorithmName.SHA256,
            RSASignaturePadding.Pkcs1
        );
        using var temporary = request.CreateSelfSigned(
            DateTimeOffset.UtcNow.AddMinutes(-1),
            DateTimeOffset.UtcNow.AddMinutes(5)
        );
        using var certificate = X509CertificateLoader.LoadPkcs12(temporary.Export(X509ContentType.Pfx), null);
        var served = Task.Run(async () =>
        {
            using var peer = await listener.AcceptTcpClientAsync(timeout.Token);
            await using var stream = peer.GetStream();
            Assert.StartsWith("CONNECT public.example:443 HTTP/1.1", await Headers(stream, timeout.Token));
            await stream.WriteAsync(
                Encoding.ASCII.GetBytes("HTTP/1.1 200 Connection established\r\n\r\n"),
                timeout.Token
            );
            await using var tls = new SslStream(stream);
            try
            {
                await tls.AuthenticateAsServerAsync(
                    new SslServerAuthenticationOptions { ServerCertificate = certificate },
                    timeout.Token
                );
            }
            catch (Exception error) when (error is AuthenticationException or IOException) { }
        });
        using var client = new SourceHttpClient(new WebProxy($"http://127.0.0.1:{port}"), Resolve);
        var error = await Assert.ThrowsAsync<HttpRequestException>(() =>
            client.GetAsync(new("https://public.example/"), timeout.Token)
        );
        Assert.IsType<AuthenticationException>(error.InnerException);
        await served;
    }

    [Theory]
    [InlineData("http://127.0.0.1/private")]
    [InlineData("http://10.0.0.1/private")]
    [InlineData("http://169.254.169.254/private")]
    [InlineData("http://192.168.1.1/private")]
    [InlineData("http://[::1]/private")]
    [InlineData("http://[::ffff:127.0.0.1]/private")]
    [InlineData("http://[fd00::1]/private")]
    [InlineData("http://user:password@public.example/private")]
    public async Task ProxyDoesNotPermitPrivateOrCredentialedSourceUrls(string uri)
    {
        var connected = false;
        using var client = new SourceHttpClient(
            new WebProxy("http://127.0.0.1:12345"),
            Resolve,
            (ip, port, ct) =>
            {
                connected = true;
                throw new InvalidOperationException();
            }
        );
        await Assert.ThrowsAsync<TagException>(() => client.GetAsync(new(uri), CancellationToken.None));
        Assert.False(connected);
    }

    [Fact]
    public async Task ProxyValidatesAllResolvedDestinationsBeforeConnecting()
    {
        using var client = new SourceHttpClient(
            new WebProxy("http://127.0.0.1:12345"),
            (host, ct) => Task.FromResult(new[] { PublicAddress, IPAddress.Loopback })
        );
        await Assert.ThrowsAsync<TagException>(() =>
            client.GetAsync(new("http://public.example/"), CancellationToken.None)
        );
    }

    [Fact]
    public async Task BypassedProxyStillRejectsDnsRebindingAtTheDirectSocket()
    {
        var resolutions = 0;
        var connected = false;
        var proxy = new WebProxy("http://127.0.0.1:12345") { BypassList = ["public.example"] };
        using var client = new SourceHttpClient(
            proxy,
            (host, ct) => Task.FromResult(new[] { ++resolutions == 1 ? PublicAddress : IPAddress.Loopback }),
            (ip, port, ct) =>
            {
                connected = true;
                throw new InvalidOperationException();
            }
        );
        var error = await Assert.ThrowsAsync<HttpRequestException>(() =>
            client.GetAsync(new("http://public.example/"), CancellationToken.None)
        );
        Assert.Contains("SOURCE_ADDRESS_FORBIDDEN", error.ToString());
        Assert.False(connected);
    }

    [Fact]
    public async Task DirectConnectionsTryTheNextPublicAddressAfterFailure()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var attempts = new List<IPAddress>();
        var first = IPAddress.Parse("93.184.215.13");
        var served = Task.Run(async () =>
        {
            using var peer = await listener.AcceptTcpClientAsync(timeout.Token);
            await using var stream = peer.GetStream();
            await Headers(stream, timeout.Token);
            await stream.WriteAsync(
                Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
                timeout.Token
            );
        });
        using var client = new SourceHttpClient(
            new WebProxy(),
            (host, ct) => Task.FromResult(new[] { first, PublicAddress }),
            async (ip, p, ct) =>
            {
                attempts.Add(ip);
                if (ip.Equals(first))
                    throw new SocketException((int)SocketError.NetworkUnreachable);
                var socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
                await socket.ConnectAsync(IPAddress.Loopback, port, ct);
                return new NetworkStream(socket, true);
            }
        );
        using var response = await client.GetAsync(new("http://public.example/"), timeout.Token);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(new[] { first, PublicAddress }, attempts);
        await served;
    }
}
