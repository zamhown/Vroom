using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;
using Vroom.Core.Tagging;

namespace Vroom.Tests;

public sealed class InstalledBrowserFactAttribute : FactAttribute
{
    public InstalledBrowserFactAttribute()
    {
        if (SourceBrowser.FindExecutable("") is null)
            Skip = "Install Chrome or Edge to run the real browser integration check.";
    }
}

public sealed class SourceBrowserIntegrationTests
{
    // This loopback fixture is pinned only through the internal test boundary. The public
    // SourceBrowser entry point still rejects every private/loopback destination.
    private sealed class Site : IAsyncDisposable
    {
        private readonly TcpListener listener = new(IPAddress.Loopback, 0);
        private readonly CancellationTokenSource stop = new(TimeSpan.FromSeconds(60));
        private readonly List<Task> connections = [];
        private readonly Task server;
        internal readonly ConcurrentQueue<string> Requests = new();

        internal Uri Url(string path) => new($"http://source.test:{((IPEndPoint)listener.LocalEndpoint).Port}{path}");

        internal static readonly byte[] Image = Convert.FromBase64String(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII="
        );

        internal Site()
        {
            listener.Start();
            server = ServeAsync();
        }

        private async Task ServeAsync()
        {
            try
            {
                while (!stop.IsCancellationRequested)
                {
                    var client = await listener.AcceptTcpClientAsync(stop.Token);
                    connections.Add(RespondAsync(client));
                }
            }
            catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
        }

        private async Task RespondAsync(TcpClient client)
        {
            using (client)
                try
                {
                    await using var stream = client.GetStream();
                    using var reader = new StreamReader(stream, Encoding.ASCII, false, 4096, leaveOpen: true);
                    var first = await reader.ReadLineAsync(stop.Token);
                    if (first is null)
                        return;
                    var path = first.Split(' ')[1];
                    var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                    string? line;
                    while (!string.IsNullOrEmpty(line = await reader.ReadLineAsync(stop.Token)))
                    {
                        var colon = line.IndexOf(':');
                        if (colon > 0)
                            headers[line[..colon]] = line[(colon + 1)..].Trim();
                    }
                    Requests.Enqueue(path);
                    var code = 200;
                    var extra = "";
                    var contentType = "text/html; charset=utf-8";
                    byte[] body;
                    if (path == "/start")
                    {
                        code = 302;
                        extra = "Location: /verify\r\n";
                        body = [];
                    }
                    else if (path == "/verify")
                        body = Encoding.UTF8.GetBytes(
                            "<title>Fixture verification</title><script>setTimeout(()=>{document.cookie='verified=yes; Max-Age=3600; Path=/';location.href='/content';},200)</script>"
                        );
                    else if (path == "/content")
                        body = Encoding.UTF8.GetBytes(
                            headers.GetValueOrDefault("Cookie", "").Contains("verified=yes")
                                ? "<title>Fixture content</title><p class='ready'>独立会话 / isolated session</p>"
                                : "<title>No session</title>"
                        );
                    else if (path == "/asset")
                    {
                        if (
                            !headers.GetValueOrDefault("Cookie", "").Contains("verified=yes")
                            || !headers.GetValueOrDefault("Referer", "").EndsWith("/content")
                        )
                            code = 403;
                        contentType = "image/png";
                        body = Image;
                    }
                    else if (path == "/private")
                    {
                        code = 302;
                        extra = "Location: http://127.0.0.1/private-target\r\n";
                        body = [];
                    }
                    else
                        body = Encoding.UTF8.GetBytes("<title>Waiting fixture</title>");
                    var response = Encoding.ASCII.GetBytes(
                        $"HTTP/1.1 {code} Fixture\r\n{extra}Content-Type: {contentType}\r\nContent-Length: {body.Length}\r\nConnection: close\r\n\r\n"
                    );
                    await stream.WriteAsync(response, stop.Token);
                    await stream.WriteAsync(body, stop.Token);
                }
                catch (Exception ex) when (ex is IOException or OperationCanceledException or SocketException) { }
        }

        public async ValueTask DisposeAsync()
        {
            stop.Cancel();
            await server;
            await Task.WhenAll(connections);
            listener.Stop();
            stop.Dispose();
        }
    }

    [InstalledBrowserFact]
    public async Task RealBrowserExecutesRedirectScriptsPersistsCookiesDownloadsImagesAndCancelsVerification()
    {
        var directory = Path.Combine(Path.GetTempPath(), "vroom-browser-review", Guid.NewGuid().ToString("N"));
        var profile = Path.Combine(directory, "source-browser", "fixture");
        var executable = SourceBrowser.FindExecutable("")!;
        var options = JsonNode.Parse(
            """{"allowedHosts":["source.test"],"readySelector":".ready","pageTimeoutSeconds":1,"verificationTimeoutSeconds":5}"""
        )!;
        await using var site = new Site();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(50));
        try
        {
            await using (
                var browser = await BrowserSession.StartAsync(
                    executable,
                    profile,
                    null,
                    new() { ["source.test"] = "127.0.0.1" },
                    timeout.Token
                )
            )
            {
                var document = await browser.FetchAsync(site.Url("/start"), options, 65536, null, timeout.Token);
                Assert.Equal(200, document.Status);
                Assert.EndsWith("/content", document.Url.AbsoluteUri);
                Assert.Contains("独立会话", Encoding.UTF8.GetString(document.Bytes));
                var image = await browser.FetchAssetAsync(site.Url("/asset"), 65536, document.Url, timeout.Token);
                Assert.Equal(200, image.Status);
                Assert.Equal(Site.Image, image.Bytes);
                await Assert.ThrowsAsync<SourceAccessException>(() =>
                    browser.FetchAsync(site.Url("/content"), options, 10, null, timeout.Token)
                );
                using var cancel = new CancellationTokenSource();
                var waiting = false;
                await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
                    browser.FetchAsync(
                        site.Url("/wait"),
                        options,
                        65536,
                        message =>
                        {
                            if (message.Id == "host.SourceAccess.waitingVerification")
                            {
                                waiting = true;
                                cancel.Cancel();
                            }
                            return Task.CompletedTask;
                        },
                        cancel.Token
                    )
                );
                Assert.True(waiting);
                await Assert.ThrowsAsync<SourceAccessException>(() =>
                    browser.FetchAsync(site.Url("/private"), options, 65536, null, timeout.Token)
                );
            }
            await using (
                var restarted = await BrowserSession.StartAsync(
                    executable,
                    profile,
                    null,
                    new() { ["source.test"] = "127.0.0.1" },
                    timeout.Token
                )
            )
                Assert.Contains(
                    "isolated session",
                    Encoding.UTF8.GetString(
                        (await restarted.FetchAsync(site.Url("/content"), options, 65536, null, timeout.Token)).Bytes
                    )
                );
            Assert.DoesNotContain("/private-target", site.Requests);
        }
        finally
        {
            // Temporary review profile only; no user browser/catalog is modified.
            Assert.StartsWith(
                Path.GetFullPath(Path.Combine(Path.GetTempPath(), "vroom-browser-review"))
                    + Path.DirectorySeparatorChar,
                Path.GetFullPath(directory)
            );
            try
            {
                Directory.Delete(directory, true);
            }
            catch (IOException) { }
        }
    }
}
