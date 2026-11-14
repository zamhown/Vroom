using System.Net;
using System.Text.Json.Nodes;
using Vroom.Core.Application;
using Vroom.Core.Media;
using Vroom.Core.Storage;
using Vroom.Core.Tagging;

namespace Vroom.Tests;

public sealed partial class TaggingTests
{
    private sealed class TestSecrets : ISecretStore
    {
        public bool Available => true;
        private readonly Dictionary<string, string> values = new();

        public Task<string?> GetAsync(string key) => Task.FromResult(values.GetValueOrDefault(key));

        public Task SetAsync(string key, string? value)
        {
            if (value is null)
                values.Remove(key);
            else
                values[key] = value;
            return Task.CompletedTask;
        }
    }

    private sealed class SubtitleHandler(Func<HttpRequestMessage, Task<HttpResponseMessage>> reply) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken
        ) => reply(request);
    }

    private OnlineSubtitles SubtitleService(Func<HttpRequestMessage, Task<HttpResponseMessage>> reply) =>
        new(
            repo,
            new TestSecrets(),
            () => new SourceHttpClient(new WebProxy(), SourceProxyFixture.Resolve, handler: new SubtitleHandler(reply))
        );

    private static HttpResponseMessage SubtitleResponse(string body, HttpStatusCode code = HttpStatusCode.OK) =>
        new(code) { Content = new StringContent(body) };

    private const string SubtitleMatches =
        """{"data":[{"attributes":{"language":"en","download_count":7,"hearing_impaired":false,"files":[{"file_id":99,"file_name":"fixture.srt"}]}}],"total_pages":1}""";

    [Fact]
    public async Task SubtitleDownloadIsPinnedOwnedAndNeverForwardsApiCredentialsToTheFileHost()
    {
        var calls = new List<string>();
        var service = SubtitleService(async request =>
        {
            var uri = request.RequestUri!;
            calls.Add(uri.AbsoluteUri);
            if (uri.Host == "files.example")
            {
                Assert.False(request.Headers.Contains("Api-Key"));
                Assert.False(request.Headers.Contains("Authorization"));
                return SubtitleResponse("1\n00:00:01,000 --> 00:00:02,000\nFixture\n");
            }
            Assert.Equal("fixture-secret", request.Headers.GetValues("Api-Key").Single());
            if (uri.AbsolutePath.EndsWith("/subtitles"))
                return SubtitleResponse(SubtitleMatches);
            Assert.Equal(HttpMethod.Post, request.Method);
            var body = JsonNode.Parse(await request.Content!.ReadAsStringAsync())!;
            Assert.Equal(99, body["file_id"]!.GetValue<int>());
            Assert.Equal("srt", body["sub_format"]!.GetValue<string>());
            return SubtitleResponse("""{"link":"https://files.example/subtitle","file_name":"../fixture.srt"}""");
        });
        await service.ConfigureAsync("fixture-secret");
        var result = await service.SearchAsync(film.Id, null, "unfamiliar subject", "en");
        var original = await repo.GetMediaAsync(film.Id);
        var downloaded = await service.DownloadAsync(result.Ticket, 99);
        Assert.Equal(original.PartId, downloaded.PartId);
        Assert.Equal("fixture.srt", downloaded.Name);
        Assert.Equal(downloaded, await service.DownloadAsync(result.Ticket, 99));
        Assert.Equal(3, calls.Count);
        var resources = await repo.ResourcesAsync(film.Id);
        var set = Assert.Single(resources.ResourceSets);
        Assert.Equal(original.PartId, set.PartId);
        Assert.True(File.Exists(Assert.Single(set.Files).Path));
        Assert.Equal(downloaded.Text, (await service.ReadAsync(film.Id, original.PartId!, downloaded.FileId)).Text);
        await Assert.ThrowsAsync<ArgumentException>(() =>
            service.ReadAsync(film.Id, "different-part", downloaded.FileId)
        );
        var settings = CatalogRepository.Serialize(await repo.SettingsAsync());
        Assert.DoesNotContain("fixture-secret", settings);
    }

    [Fact]
    public async Task CredentialApiRedirectIsRejectedBeforeSendingASecondRequest()
    {
        var count = 0;
        var service = SubtitleService(request =>
        {
            count++;
            var result = SubtitleResponse("", HttpStatusCode.Found);
            result.Headers.Location = new("https://other.example/capture");
            return Task.FromResult(result);
        });
        await service.ConfigureAsync("fixture-secret");
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            service.SearchAsync(film.Id, null, "query", "")
        );
        Assert.Equal("host.Subtitles.requestFailed", error.Message);
        Assert.Equal(1, count);
    }

    [Fact]
    public async Task SubtitleSearchRejectsUnknownFilesAndChangedMediaBeforeChargingDownloadQuota()
    {
        var count = 0;
        var service = SubtitleService(request =>
        {
            count++;
            return Task.FromResult(SubtitleResponse(SubtitleMatches));
        });
        await service.ConfigureAsync("fixture-secret");
        var search = await service.SearchAsync(film.Id, null, "query", "");
        await Assert.ThrowsAsync<InvalidOperationException>(() => service.DownloadAsync(search.Ticket, 123));
        await db.RunAsync(c =>
            c.Execute("UPDATE media_files SET payload=json_set(payload,'$.size',123456) WHERE id=@id", ("@id", film.Id))
        );
        await Assert.ThrowsAsync<InvalidOperationException>(() => service.DownloadAsync(search.Ticket, 99));
        Assert.Equal(1, count);
    }

    [Theory]
    [InlineData("https://127.0.0.1/private", "1\n00:00:00,000 --> 00:00:02,000\nFixture")]
    [InlineData("https://files.example/subtitle", "<html>gateway error</html>")]
    public async Task InvalidDownloadDoesNotCreateResources(string link, string body)
    {
        var service = SubtitleService(request =>
            Task.FromResult(
                SubtitleResponse(
                    request.RequestUri!.AbsolutePath.EndsWith("/subtitles") ? SubtitleMatches
                    : request.RequestUri.Host == "files.example" ? body
                    : new JsonObject { ["link"] = link }.ToJsonString()
                )
            )
        );
        await service.ConfigureAsync("fixture-secret");
        var search = await service.SearchAsync(film.Id, null, "query", "");
        await Assert.ThrowsAnyAsync<Exception>(() => service.DownloadAsync(search.Ticket, 99));
        Assert.Empty((await repo.ResourcesAsync(film.Id)).ResourceSets);
    }
}
