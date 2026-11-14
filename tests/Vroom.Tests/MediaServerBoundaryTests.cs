using System.Net.Sockets;
using System.Text;
using Vroom.Core.Media;
using Vroom.Core.Storage;

namespace Vroom.Tests;

/// <summary>Request-parsing boundaries of the loopback media server, exercised over real sockets.</summary>
public sealed class MediaServerBoundaryTests : IAsyncLifetime
{
    private readonly string directory = Path.Combine(Path.GetTempPath(), "vroom-tests", Guid.NewGuid().ToString("N"));
    private CatalogDatabase db = null!;
    private CatalogRepository repo = null!;
    private LocalMediaServer server = null!;
    private Uri baseUri = null!;
    private string filmId = "";

    public async Task InitializeAsync()
    {
        Directory.CreateDirectory(directory);
        db = new(Path.Combine(directory, "data"));
        repo = new(db);
        await repo.InitializeAsync();
        await repo.SaveLibraryAsync(new("lib", "Library", [Path.Combine(directory, "media")], []));
        var path = Path.Combine(directory, "media", "clip.mp4");
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        await File.WriteAllBytesAsync(path, Enumerable.Range(0, 100).Select(i => (byte)i).ToArray());
        filmId = (
            await repo.ImportMediaAsync(
                new()
                {
                    LibraryId = "lib",
                    Path = path,
                    Size = 100,
                }
            )
        ).Id;
        server = new LocalMediaServer(repo, new FfmpegService(repo));
        await server.StartAsync();
        baseUri = new Uri(server.BaseUrl + "/");
    }

    public async Task DisposeAsync()
    {
        await server.DisposeAsync();
        db.Dispose();
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        Directory.Delete(directory, true);
    }

    private async Task<string> Send(string raw)
    {
        using var client = new TcpClient();
        await client.ConnectAsync(baseUri.Host, baseUri.Port);
        var stream = client.GetStream();
        await stream.WriteAsync(Encoding.ASCII.GetBytes(raw));
        using var reader = new StreamReader(stream, Encoding.ASCII);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        return (await reader.ReadLineAsync(timeout.Token)) ?? "";
    }

    private string Route(string route) => baseUri.AbsolutePath + route;

    [Theory]
    [InlineData("GET /no-secret/media/x HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n", "403")]
    [InlineData("POST {secret}media/{film} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n", "405")]
    [InlineData("garbage\r\n\r\n", "405")]
    [InlineData("GET {secret}media/unknown-film HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n", "404")]
    [InlineData("GET {secret}../../etc/passwd HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n", "404")]
    [InlineData("GET {secret}media/{film}/../../../x HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n", "404")]
    [InlineData("GET {secret}media/{film} HTTP/1.1\r\nHost: 127.0.0.1\r\nRange: bytes=500-\r\n\r\n", "416")]
    [InlineData("GET {secret}media/{film} HTTP/1.1\r\nHost: 127.0.0.1\r\nRange: bytes=10-19\r\n\r\n", "206")]
    [InlineData("HEAD {secret}media/{film} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n", "200")]
    public async Task MalformedHostileAndRangeRequestsGetTheRightStatus(string template, string status)
    {
        var raw = template.Replace("{secret}", Route("")).Replace("{film}", filmId);
        Assert.Contains(" " + status + " ", await Send(raw));
    }

    [Fact]
    public async Task OversizedHeadersAreRejected()
    {
        var raw =
            $"GET {Route("media/" + filmId)} HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Fill: {new string('a', 20000)}\r\n\r\n";
        Assert.Contains(" 431 ", await Send(raw));
    }
}
