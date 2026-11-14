using System.Text;
using System.Text.Json.Nodes;
using Vroom.Core.Application;
using Vroom.Core.Storage;
using Vroom.Core.Tagging;

namespace Vroom.Tests;

public sealed partial class TaggingTests
{
    private sealed class BrowserStub(Func<CancellationToken, Task<SourceDocument>> fetch) : ISourceBrowser
    {
        internal int Calls;

        public async Task<SourceDocument> FetchAsync(
            string sourceId,
            Uri url,
            JsonNode options,
            int limit,
            string executable,
            Func<UiMessage, Task>? progress,
            CancellationToken ct
        )
        {
            Calls++;
            if (progress is not null)
                await progress(UiMessage.Of("host.SourceAccess.waitingVerification", url.Host));
            return await fetch(ct);
        }

        public void Dispose() { }
    }

    private static JsonObject BrowserSource(string mode = "auto") =>
        Parse(
            """
            {"transport":"http","request":{"urlTemplate":"http://public.example/item","mode":"auto","browser":{"allowedHosts":["public.example"],"readySelector":".ready"}},
            "parse":{"format":"html","fields":{"note":{"selector":".ready"}}},"limits":{"cacheTtlSeconds":0,"minIntervalMs":500}}
            """
        )
            is var source
            ? SetMode(source, mode)
            : throw new Exception();

    private static JsonObject SetMode(JsonObject source, string mode)
    {
        source["request"]!["mode"] = mode;
        return source;
    }

    private static SourceDocument ReadyDocument() =>
        new(Encoding.UTF8.GetBytes("<div class='ready'>Browser result</div>"), new Uri("http://public.example/final"));

    [Fact]
    public async Task EnrichmentBrowserFallbackRetainsItsRouteAcrossServiceRestartAndNeverCachesVerificationHtml()
    {
        await ConfigureFeedbackSource(BrowserSource());
        await repo.PatchSettingsAsync(new() { ["onlineMetadata"] = true });
        await using var proxy = new SourceProxyFixture((_, _) => (200, "", "<h1>Please verify</h1>"));
        var first = new BrowserStub(_ => Task.FromResult(ReadyDocument()));
        var second = new BrowserStub(_ => Task.FromResult(ReadyDocument()));
        using (var sources = new TagSources(engine, proxy.Client(), first))
            Assert.True((await sources.EnrichAsync(film.Id)).Found);
        using (var sources = new TagSources(engine, proxy.Client(), second))
            Assert.True((await sources.EnrichAsync(film.Id)).Found);
        Assert.Equal(1, first.Calls);
        Assert.Equal(1, second.Calls);
        Assert.Single(proxy.Requests);
        var detail = await engine.FilmAsync(film.Id);
        Assert.Contains("Browser result", detail["candidates"]!.ToJsonString());
        Assert.DoesNotContain("Please verify", detail["candidates"]!.ToJsonString());
        Assert.Null(detail["film"]!["values"]?["user.feedback.note"]);
    }

    [Fact]
    public async Task EnrichmentRateLimitPersistsAndDoesNotOpenBrowserOrBlockOtherSources()
    {
        await ConfigureFeedbackSource(BrowserSource());
        await repo.PatchSettingsAsync(new() { ["onlineMetadata"] = true });
        var document = await engine.ExportAsync("definitions");
        var field = document.List("definitions").Single(d => d.Text("key") == "user.feedback.note")!.DeepClone();
        field["enrichment"]!
            .AsArray()
            .Add(
                Parse(
                    """{"id":"local-fallback","source":"user.independent.local","field":"note","apply":"suggest-only"}"""
                )
            );
        var preview = await engine.PreviewConfigAsync(
            new()
            {
                ["changes"] = new JsonArray(
                    new JsonObject
                    {
                        ["kind"] = "definition",
                        ["key"] = "user.feedback.note",
                        ["value"] = field,
                    },
                    new JsonObject
                    {
                        ["kind"] = "sources",
                        ["key"] = "user.independent.local",
                        ["value"] = FeedbackSidecar(),
                    }
                ),
            }
        );
        await engine.ApplyConfigAsync(
            new()
            {
                ["previewToken"] = preview["previewToken"]!.DeepClone(),
                ["expectedGeneration"] = preview["generation"]!.DeepClone(),
            }
        );
        await File.WriteAllTextAsync(Path.ChangeExtension(film.Path, ".review"), "{\"note\":\"Local fallback\"}");
        await using var proxy = new SourceProxyFixture((_, _) => (429, "Retry-After: 120\r\n", "Slow down"));
        var browser = new BrowserStub(_ => throw new Exception("Browser must not ignore a rate limit"));
        using (var sources = new TagSources(engine, proxy.Client(), browser))
        {
            var result = await sources.EnrichAsync(film.Id);
            Assert.True(result.Found);
            Assert.True(result.HasFailures);
            var failure = Assert.Single(result.Sources, s => s.Status == "rate-limited");
            Assert.True(failure.RetryAt > DateTimeOffset.UtcNow.AddSeconds(100));
        }
        using (var sources = new TagSources(engine, proxy.Client(), browser))
            Assert.Contains((await sources.EnrichAsync(film.Id)).Sources, s => s.Status == "cooldown");
        Assert.Single(proxy.Requests);
        Assert.Equal(0, browser.Calls);
        Assert.Contains("Local fallback", (await engine.FilmAsync(film.Id))["candidates"]!.ToJsonString());
    }

    [Fact]
    public async Task EnrichmentCancelledDuringVerificationDoesNotWriteResultsOrCooldown()
    {
        await ConfigureFeedbackSource(BrowserSource("browser"));
        await repo.PatchSettingsAsync(new() { ["onlineMetadata"] = true });
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var browser = new BrowserStub(async ct =>
        {
            entered.SetResult();
            await Task.Delay(Timeout.Infinite, ct);
            return ReadyDocument();
        });
        using var sources = new TagSources(engine, new SourceHttpClient(), browser);
        using var stop = new CancellationTokenSource();
        var messages = new List<string>();
        var running = sources.EnrichAsync(
            film.Id,
            stop.Token,
            m =>
            {
                messages.Add(m.Id);
                return Task.CompletedTask;
            }
        );
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        stop.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => running);
        Assert.Contains("host.SourceAccess.waitingVerification", messages);
        Assert.Empty((await engine.FilmAsync(film.Id)).List("candidates"));
        Assert.Equal(0, await db.RunAsync(c => Convert.ToInt32(c.Scalar("SELECT COUNT(*) FROM tag_source_cache"))));
        Assert.Equal(
            0,
            await db.RunAsync(c =>
                Convert.ToInt32(c.Scalar("SELECT COUNT(*) FROM settings WHERE key LIKE 'source.access.%'"))
            )
        );
    }

    [Fact]
    public async Task EnrichmentLocalBrowserConfigurationFailureCanBeRetriedImmediately()
    {
        await ConfigureFeedbackSource(BrowserSource("browser"));
        await repo.PatchSettingsAsync(new() { ["onlineMetadata"] = true });
        var available = false;
        var browser = new BrowserStub(_ =>
            available
                ? Task.FromResult(ReadyDocument())
                : throw new SourceAccessException("browser-unavailable", "host.SourceAccess.browserMissing")
        );
        using var sources = new TagSources(engine, new SourceHttpClient(), browser);
        var first = await sources.EnrichAsync(film.Id);
        Assert.Contains(first.Sources, s => s.Status == "browser-unavailable" && s.RetryAt is null);
        available = true;
        Assert.True((await sources.EnrichAsync(film.Id)).Found);
        Assert.Equal(2, browser.Calls);
    }

    [Fact]
    public async Task EnrichmentConcurrentRequestsObserveTheSameRateLimit()
    {
        await ConfigureFeedbackSource(BrowserSource());
        await repo.PatchSettingsAsync(new() { ["onlineMetadata"] = true });
        await using var proxy = new SourceProxyFixture((_, _) => (429, "Retry-After: 90\r\n", ""));
        using var sources = new TagSources(engine, proxy.Client(), new BrowserStub(_ => throw new Exception()));
        var results = await Task.WhenAll(sources.EnrichAsync(film.Id), sources.EnrichAsync(film.Id));
        Assert.Single(proxy.Requests);
        Assert.Contains(results.SelectMany(r => r.Sources), s => s.Status == "rate-limited");
        Assert.Contains(results.SelectMany(r => r.Sources), s => s.Status == "cooldown");
    }

    [Fact]
    public async Task EnrichmentBrowserResultCannotOverwriteAChangedFilmRevision()
    {
        await ConfigureFeedbackSource(BrowserSource("browser"));
        await repo.PatchSettingsAsync(new() { ["onlineMetadata"] = true });
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var browser = new BrowserStub(async ct =>
        {
            entered.SetResult();
            await release.Task.WaitAsync(ct);
            return ReadyDocument();
        });
        using var sources = new TagSources(engine, new SourceHttpClient(), browser);
        var running = sources.EnrichAsync(film.Id);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await repo.UpdateMediaAsync(film.Id, f => f with { Size = f.Size + 1 });
        release.SetResult();
        Assert.Equal("STALE_SOURCE_RESULT", (await Assert.ThrowsAsync<TagException>(() => running)).Code);
        Assert.Empty((await engine.FilmAsync(film.Id)).List("candidates"));
    }

    [Fact]
    public async Task EnrichmentCookiesAreIsolatedBetweenSourcesOnTheSameHost()
    {
        var cookies = new List<string>();
        await using var proxy = new SourceProxyFixture(
            (uri, request) =>
            {
                cookies.Add(request);
                return (200, uri.AbsolutePath == "/set" ? "Set-Cookie: session=private; Path=/\r\n" : "", "OK");
            }
        );
        using var access = new SourceAccess(repo, proxy.Client(), new BrowserStub(_ => throw new Exception()));
        await access.HttpAsync("one", new("http://public.example/set"), 1024, CancellationToken.None);
        await access.HttpAsync("one", new("http://public.example/read"), 1024, CancellationToken.None);
        await access.HttpAsync("two", new("http://public.example/read"), 1024, CancellationToken.None);
        Assert.Contains("session=private", cookies[1]);
        Assert.DoesNotContain("session=private", cookies[2]);
    }

    [Fact]
    public async Task EnrichmentBrowserConfigurationIsValidatedBeforePublication()
    {
        var source = BrowserSource();
        source["request"]!["browser"]!["readySelector"] = "]bad[";
        await Assert.ThrowsAsync<TagException>(() => ConfigureFeedbackSource(source));
        source = BrowserSource();
        source["request"]!["browser"]!["allowedHosts"] = new JsonArray("elsewhere.example");
        await Assert.ThrowsAsync<TagException>(() => ConfigureFeedbackSource(source));
        source = BrowserSource();
        source["parse"]!["format"] = "json";
        source["parse"]!["fields"]!["note"] = Parse("""{"pointer":"/note"}""");
        await Assert.ThrowsAsync<TagException>(() => ConfigureFeedbackSource(source));
    }
}

public sealed class SourceRetryTests
{
    [Fact]
    public void RetryAfterSupportsDeltaDateAndInvalidValues()
    {
        Assert.Equal(TimeSpan.FromSeconds(90), SourceAccess.RetryDelay("90"));
        Assert.InRange(
            SourceAccess.RetryDelay(DateTimeOffset.UtcNow.AddMinutes(2).ToString("R"))!.Value.TotalSeconds,
            118,
            121
        );
        Assert.Null(SourceAccess.RetryDelay("not a date"));
        Assert.Null(SourceAccess.RetryDelay("NaN"));
    }
}
