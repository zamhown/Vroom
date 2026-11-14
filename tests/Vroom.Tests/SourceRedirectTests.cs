using System.Net;
using System.Net.Sockets;
using System.Text;
using Vroom.Core.Tagging;

namespace Vroom.Tests;

internal sealed class SourceProxyFixture(Func<Uri, string, (int Status, string Headers, string Body)> reply)
    : IAsyncDisposable
{
    private readonly TcpListener listener = new(IPAddress.Loopback, 0);
    private readonly CancellationTokenSource stop = new(TimeSpan.FromSeconds(15));
    private Task? server;
    internal readonly List<Uri> Requests = [];
    internal Uri Address
    {
        get
        {
            listener.Start();
            server ??= RunAsync();
            return new($"http://127.0.0.1:{((IPEndPoint)listener.LocalEndpoint).Port}");
        }
    }

    internal static Task<IPAddress[]> Resolve(string host, CancellationToken ct) =>
        Task.FromResult(
            new[]
            {
                IPAddress.TryParse(host, out var ip) ? ip
                : host == "internal.example" ? IPAddress.Loopback
                : IPAddress.Parse("93.184.215.14"),
            }
        );

    internal SourceHttpClient Client(IWebProxy? proxy = null) => new(proxy ?? new WebProxy(Address), Resolve);

    private async Task RunAsync()
    {
        try
        {
            while (!stop.IsCancellationRequested)
            {
                using var peer = await listener.AcceptTcpClientAsync(stop.Token);
                await using var stream = peer.GetStream();
                var buffer = new List<byte>();
                var next = new byte[1];
                while (buffer.Count < 65536 && await stream.ReadAsync(next, stop.Token) > 0)
                {
                    buffer.Add(next[0]);
                    if (buffer.Count >= 4 && Encoding.ASCII.GetString(buffer.TakeLast(4).ToArray()) == "\r\n\r\n")
                        break;
                }
                var request = Encoding.ASCII.GetString(buffer.ToArray());
                var uri = new Uri(request.Split(' ')[1]);
                Requests.Add(uri);
                var result = reply(uri, request);
                var body = Encoding.UTF8.GetBytes(result.Body);
                var header = Encoding.ASCII.GetBytes(
                    $"HTTP/1.1 {result.Status} Fixture\r\n{result.Headers}Content-Length: {body.Length}\r\nConnection: close\r\n\r\n"
                );
                await stream.WriteAsync(header, stop.Token);
                await stream.WriteAsync(body, stop.Token);
            }
        }
        catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
    }

    public async ValueTask DisposeAsync()
    {
        stop.Cancel();
        if (server is not null)
            await server;
        listener.Stop();
        stop.Dispose();
    }
}

public sealed class SourceRedirectTests
{
    [Theory]
    [InlineData(301)]
    [InlineData(302)]
    [InlineData(303)]
    [InlineData(307)]
    [InlineData(308)]
    public async Task RelativeRedirectsReturnFinalResponseAndLocation(int code)
    {
        await using var fixture = new SourceProxyFixture(
            (uri, _) => uri.AbsolutePath == "/start" ? (code, "Location: /folder/final?q=1\r\n", "") : (200, "", "OK")
        );
        using var client = fixture.Client();
        using var response = await client.GetAsync(new("http://public.example/start"), CancellationToken.None);
        Assert.Equal("OK", await response.Content.ReadAsStringAsync());
        Assert.Equal("http://public.example/folder/final?q=1", response.RequestMessage!.RequestUri!.AbsoluteUri);
        Assert.Equal(2, fixture.Requests.Count);
    }

    private sealed class Routes(Uri first, Uri second) : IWebProxy
    {
        public ICredentials? Credentials { get; set; }

        public Uri GetProxy(Uri destination) => destination.Host == "public.example" ? first : second;

        public bool IsBypassed(Uri host) => false;
    }

    [Fact]
    public async Task CrossHostRedirectUsesTheNewDestinationsProxy()
    {
        await using var first = new SourceProxyFixture((_, _) => (302, "Location: //other.example/final\r\n", ""));
        await using var second = new SourceProxyFixture((_, _) => (200, "", "OK"));
        using var client = first.Client(new Routes(first.Address, second.Address));
        using var response = await client.GetAsync(new("http://public.example/start"), CancellationToken.None);
        Assert.Equal("OK", await response.Content.ReadAsStringAsync());
        Assert.Single(first.Requests);
        Assert.Equal("other.example", Assert.Single(second.Requests).Host);
    }

    [Theory]
    [InlineData("http://127.0.0.1/private")]
    [InlineData("http://10.0.0.1/private")]
    [InlineData("http://[::ffff:127.0.0.1]/private")]
    [InlineData("http://internal.example/private")]
    [InlineData("file:///etc/passwd")]
    [InlineData("http://user:secret@public.example/private")]
    public async Task RedirectsCannotBypassDestinationValidation(string location)
    {
        await using var fixture = new SourceProxyFixture((_, _) => (302, "Location: " + location + "\r\n", ""));
        using var client = fixture.Client();
        var error = await Assert.ThrowsAsync<TagException>(() =>
            client.GetAsync(new("http://public.example/start"), CancellationToken.None)
        );
        Assert.Equal("SOURCE_ADDRESS_FORBIDDEN", error.Code);
        Assert.Single(fixture.Requests);
    }

    [Fact]
    public async Task CookiesCanCompleteASameAddressRedirect()
    {
        await using var fixture = new SourceProxyFixture(
            (_, headers) =>
                headers.Contains("Cookie: checked=yes")
                    ? (200, "", "OK")
                    : (302, "Location: /start\r\nSet-Cookie: checked=yes; Path=/\r\n", "")
        );
        using var client = fixture.Client();
        using var response = await client.GetAsync(new("http://public.example/start"), CancellationToken.None);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(2, fixture.Requests.Count);
    }

    [Fact]
    public async Task RedirectLoopsAreBounded()
    {
        await using var fixture = new SourceProxyFixture((_, _) => (302, "Location: /start\r\n", ""));
        using var client = fixture.Client();
        var error = await Assert.ThrowsAsync<TagException>(() =>
            client.GetAsync(new("http://public.example/start"), CancellationToken.None)
        );
        Assert.Equal("SOURCE_REDIRECT_LIMIT", error.Code);
        Assert.Equal(SourceHttpClient.MaximumRedirects + 1, fixture.Requests.Count);
    }

    [Theory]
    [InlineData(300)]
    [InlineData(304)]
    [InlineData(305)]
    [InlineData(404)]
    public async Task OtherStatusesAreNotFollowed(int status)
    {
        await using var fixture = new SourceProxyFixture((_, _) => (status, "Location: /unexpected\r\n", ""));
        using var client = fixture.Client();
        using var response = await client.GetAsync(new("http://public.example/start"), CancellationToken.None);
        Assert.Equal(status, (int)response.StatusCode);
        Assert.Single(fixture.Requests);
    }

    [Fact]
    public async Task MissingLocationIsActionable()
    {
        await using var fixture = new SourceProxyFixture((_, _) => (302, "", ""));
        using var client = fixture.Client();
        var error = await Assert.ThrowsAsync<TagException>(() =>
            client.GetAsync(new("http://public.example/start"), CancellationToken.None)
        );
        Assert.Equal("host.SourceHttp.redirectInvalid", error.Message);
    }

    [Fact]
    public void HttpsDowngradesAreRejected()
    {
        using var response = new HttpResponseMessage(HttpStatusCode.Found);
        response.Headers.Location = new("http://other.example/");
        var error = Assert.Throws<TagException>(() =>
            SourceHttpClient.RedirectTarget(new("https://public.example/start"), response)
        );
        Assert.Equal("SOURCE_REDIRECT_DOWNGRADE", error.Code);
    }
}
