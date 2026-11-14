using System.Collections.Concurrent;
using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Vroom.Core.Application;
using Vroom.Core.Storage;

namespace Vroom.Core.Tagging;

internal sealed class SourceFetchFailure(SourceOutcome outcome, Exception inner) : Exception(outcome.Error, inner)
{
    internal SourceOutcome Outcome { get; } = outcome;
}

// Access state belongs to the local host, not to exported source definitions. A failed
// source has its own cooldown and cannot prevent subsequent sources from being queried.
internal sealed class SourceAccess(
    CatalogRepository repository,
    SourceHttpClient seed,
    ISourceBrowser browser,
    Vroom.Core.Network.NetworkService? network = null
) : IDisposable
{
    private readonly LocalDiagnostics diagnostics = new(repository.Database.DataDirectory);

    private sealed record AccessState(
        int Failures = 0,
        DateTimeOffset? RetryAt = null,
        bool Browser = false,
        string? Failure = null
    );

    private readonly ConcurrentDictionary<string, SourceHttpClient> clients = new();
    private readonly ConcurrentDictionary<string, SemaphoreSlim> gates = new();
    private readonly ConcurrentDictionary<string, DateTimeOffset> lastRequest = new();

    private static string Key(string id, JsonNode source) =>
        "source.access." + TagJson.Hash(new JsonObject { ["sourceId"] = id, ["source"] = source.Copy() });

    internal static TimeSpan? RetryDelay(string? value)
    {
        if (
            double.TryParse(value, NumberStyles.Number, CultureInfo.InvariantCulture, out var seconds)
            && double.IsFinite(seconds)
        )
            return TimeSpan.FromSeconds(Math.Clamp(seconds, 1, 604800));
        if (DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var date))
            return TimeSpan.FromSeconds(Math.Clamp((date - DateTimeOffset.UtcNow).TotalSeconds, 1, 604800));
        return null;
    }

    private async Task<AccessState> StateAsync(string key, CancellationToken ct) =>
        await repository.Database.ReadAsync(
            db =>
                db.Scalar("SELECT value FROM settings WHERE key=@k", ("@k", key)) is string value
                    ? JsonSerializer.Deserialize<AccessState>(value)!
                    : new(),
            ct
        );

    private Task SaveAsync(string key, AccessState state, CancellationToken ct) =>
        repository.Database.RunAsync(
            db =>
                db.Execute(
                    "INSERT INTO settings(key,value) VALUES(@k,@v) ON CONFLICT(key) DO UPDATE SET value=@v",
                    ("@k", key),
                    ("@v", JsonSerializer.Serialize(state))
                ),
            ct
        );

    internal async Task<SourceDocument> FetchAsync(
        string id,
        JsonNode source,
        Uri url,
        int limit,
        string executable,
        Func<UiMessage, Task>? progress,
        CancellationToken ct
    )
    {
        var key = Key(id, source);
        var gate = gates.GetOrAdd(key, _ => new(1, 1));
        await gate.WaitAsync(ct);
        try
        {
            var state = await StateAsync(key, ct);
            if (state.RetryAt > DateTimeOffset.UtcNow)
                throw new SourceFetchFailure(
                    new(
                        id,
                        "cooldown",
                        Error: "host.SourceAccess.cooldown",
                        RetryAt: state.RetryAt,
                        Cause: FailureMessage(state.Failure)
                    ),
                    new SourceAccessException("cooldown", "host.SourceAccess.cooldown", state.RetryAt)
                );
            var interval = TimeSpan.FromMilliseconds(source["limits"].Number("minIntervalMs", 1000));
            if (lastRequest.TryGetValue(key, out var last) && last + interval > DateTimeOffset.UtcNow)
                await Task.Delay(last + interval - DateTimeOffset.UtcNow, ct);
            lastRequest[key] = DateTimeOffset.UtcNow;
            if (progress is not null)
                await progress(UiMessage.Of("host.SourceAccess.fetching", url.Host));
            var request = source["request"]!;
            var mode = request.Text("mode", "http");
            var viaBrowser = mode == "browser" || mode == "auto" && state.Browser;
            SourceDocument document;
            if (viaBrowser)
                document = await browser.FetchAsync(id, url, request["browser"]!, limit, executable, progress, ct);
            else
            {
                try
                {
                    document = await HttpAsync(id, url, limit, ct);
                }
                catch (Exception ex)
                    when (mode == "auto"
                        && (
                            ex is HttpRequestException
                            || ex is OperationCanceledException && !ct.IsCancellationRequested
                        )
                    )
                {
                    document = await browser.FetchAsync(id, url, request["browser"]!, limit, executable, progress, ct);
                    viaBrowser = true;
                }
                if (
                    mode == "auto"
                    && !viaBrowser
                    && (
                        document.Status is 401 or 403
                        || document.Status is >= 200 and < 300
                            && !SourceBrowserRules.Ready(request["browser"]!, Encoding.UTF8.GetString(document.Bytes))
                    )
                )
                {
                    document = await browser.FetchAsync(id, url, request["browser"]!, limit, executable, progress, ct);
                    viaBrowser = true;
                }
            }
            if (document.Status is < 200 or >= 300)
            {
                var kind = document.Status switch
                {
                    401 => "authentication-required",
                    403 => "access-denied",
                    404 => "not-found",
                    429 => "rate-limited",
                    _ => "http-error",
                };
                throw new SourceAccessException(
                    kind,
                    document.Status switch
                    {
                        401 => "host.SourceAccess.authenticationRequired",
                        403 => "host.SourceAccess.accessDenied",
                        404 => "host.SourceAccess.notFound",
                        429 => "host.SourceAccess.rateLimited",
                        _ => "host.SourceAccess.httpError",
                    },
                    document.RetryAfter is { } retry ? DateTimeOffset.UtcNow + retry : null
                );
            }
            if (viaBrowser && !state.Browser)
                await SaveAsync(key, state with { Browser = true }, ct);
            return document;
        }
        catch (Exception error)
            when (!ct.IsCancellationRequested
                && (
                    error
                    is HttpRequestException
                        or IOException
                        or System.Net.Sockets.SocketException
                        or OperationCanceledException
                        or SourceAccessException
                        or TagException
                )
            )
        {
            throw new SourceFetchFailure(await RecordFailureAsync(id, source, error, ct), error);
        }
        finally
        {
            gate.Release();
        }
    }

    internal async Task<SourceDocument> HttpAsync(
        string id,
        Uri url,
        int limit,
        CancellationToken ct,
        bool text = true,
        Uri? referrer = null
    )
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(20));
        var clientKey = id + ":" + (network?.Status.Revision ?? 0);
        using var response = await clients
            .GetOrAdd(clientKey, _ => seed.CreateSession(network?.CaptureProxy()))
            .GetAsync(url, deadline.Token, referrer);
        if (response.Content.Headers.ContentLength > limit)
            throw new SourceAccessException("too-large", "host.SourceAccess.tooLarge");
        await using var stream = await response.Content.ReadAsStreamAsync(deadline.Token);
        using var memory = new MemoryStream();
        var buffer = new byte[65536];
        int read;
        while ((read = await stream.ReadAsync(buffer, deadline.Token)) > 0)
        {
            if (memory.Length + read > limit)
                throw new SourceAccessException("too-large", "host.SourceAccess.tooLarge");
            memory.Write(buffer, 0, read);
        }
        var bytes = memory.ToArray();
        if (text && response.Content.Headers.ContentType?.CharSet is { Length: > 0 } charset)
        {
            Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
            try
            {
                bytes = Encoding.UTF8.GetBytes(Encoding.GetEncoding(charset.Trim('"', '\'')).GetString(bytes));
            }
            catch (ArgumentException) { }
        }
        return new(
            bytes,
            response.RequestMessage?.RequestUri ?? url,
            (int)response.StatusCode,
            RetryDelay(response.Headers.TryGetValues("Retry-After", out var values) ? values.FirstOrDefault() : null)
        );
    }

    internal async Task<SourceDocument> AssetAsync(
        string id,
        JsonNode source,
        Uri url,
        int limit,
        string executable,
        Uri? referrer,
        CancellationToken ct
    )
    {
        var mode = source["request"].Text("mode", "http");
        if (mode == "browser" || mode == "auto" && (await StateAsync(Key(id, source), ct)).Browser)
            return await browser.FetchAssetAsync(
                id,
                url,
                source["request"]!["browser"]!,
                limit,
                executable,
                referrer,
                ct
            );
        return await HttpAsync(id, url, limit, ct, text: false, referrer: referrer);
    }

    internal async Task<SourceOutcome> FailureAsync(string id, JsonNode source, Exception error, CancellationToken ct)
    {
        if (error is SourceFetchFailure recorded)
            return recorded.Outcome;
        var gate = gates.GetOrAdd(Key(id, source), _ => new(1, 1));
        await gate.WaitAsync(ct);
        try
        {
            return await RecordFailureAsync(id, source, error, ct);
        }
        finally
        {
            gate.Release();
        }
    }

    internal void LogAssetFailure(string source, Exception error) =>
        diagnostics.Error("source.asset." + source, error, Vroom.Core.Domain.TaskOrigin.Current.Value?.TabId);

    private static string FailureMessage(string? kind) =>
        kind switch
        {
            "browser-disconnected" => "host.SourceAccess.browserDisconnected",
            "verification-required" => "host.SourceAccess.verificationRequired",
            "authentication-required" => "host.SourceAccess.authenticationRequired",
            "access-denied" => "host.SourceAccess.accessDenied",
            "rate-limited" => "host.SourceAccess.rateLimited",
            "http-error" => "host.SourceAccess.httpError",
            "identity-mismatch" => "host.SourceAccess.identityMismatch",
            "address-forbidden" => "host.SourceAccess.addressForbidden",
            "source-error" => "host.SourceAccess.sourceError",
            "timeout" => "host.SourceAccess.timeout",
            "connection-failed" => "host.SourceAccess.connectionFailed",
            "too-large" => "host.SourceAccess.tooLarge",
            _ => "host.SourceAccess.failed",
        };

    private async Task<SourceOutcome> RecordFailureAsync(
        string id,
        JsonNode source,
        Exception error,
        CancellationToken ct
    )
    {
        diagnostics.Error("source." + id, error, Vroom.Core.Domain.TaskOrigin.Current.Value?.TabId);
        var failure = error as SourceAccessException;
        var kind =
            failure?.Code
            ?? (
                error is TagException tag
                    ? tag.Code switch
                    {
                        "SOURCE_REQUIRED_FIELD_MISSING" => "verification-required",
                        "SOURCE_IDENTITY_MISMATCH" => "identity-mismatch",
                        "SOURCE_ADDRESS_FORBIDDEN" => "address-forbidden",
                        _ => "source-error",
                    }
                : error is System.Xml.XmlException or JsonException ? "source-error"
                : error is OperationCanceledException ? "timeout"
                : "connection-failed"
            );
        var message =
            failure?.Message
            ?? (
                error is TagException known && known.Message.StartsWith("host.", StringComparison.Ordinal)
                    ? known.Message
                    : kind switch
                    {
                        "identity-mismatch" => "host.SourceAccess.identityMismatch",
                        "address-forbidden" => "host.SourceAccess.addressForbidden",
                        "source-error" => "host.SourceAccess.sourceError",
                        "timeout" => "host.SourceAccess.timeout",
                        _ => "host.SourceAccess.connectionFailed",
                    }
            );
        var key = Key(id, source);
        var state = await StateAsync(key, ct);
        var retryAt = failure?.RetryAt;
        if (
            source.Text("transport") == "http"
            && kind
                is not (
                    "cooldown"
                    or "not-found"
                    or "identity-mismatch"
                    or "browser-unavailable"
                    or "browser-proxy-auth"
                    or "browser-proxy-route"
                    or "configuration-invalid"
                    or "address-forbidden"
                )
        )
        {
            var count = Math.Min(state.Failures + 1, 16);
            var seconds = Math.Min(
                source["limits"].Number("maxCooldownSeconds", 1800),
                source["limits"].Number("failureCooldownSeconds", 30) * Math.Pow(2, count - 1)
            );
            retryAt ??= DateTimeOffset.UtcNow.AddSeconds(seconds);
            await SaveAsync(key, state with { Failures = count, RetryAt = retryAt, Failure = kind }, ct);
        }
        await repository.AuditAsync(
            "source.failed",
            JsonSerializer.Serialize(
                new
                {
                    sourceId = id,
                    code = kind,
                    retryAt,
                }
            ),
            ct
        );
        return new(id, kind, Error: kind == "not-found" ? null : message, RetryAt: retryAt);
    }

    internal async Task SuccessAsync(string id, JsonNode source, CancellationToken ct)
    {
        var key = Key(id, source);
        var gate = gates.GetOrAdd(key, _ => new(1, 1));
        await gate.WaitAsync(ct);
        try
        {
            var state = await StateAsync(key, ct);
            if (state.Failures > 0)
                await SaveAsync(key, state with { Failures = 0, RetryAt = null }, ct);
        }
        finally
        {
            gate.Release();
        }
    }

    public void Dispose()
    {
        foreach (var client in clients.Values)
            client.Dispose();
        seed.Dispose();
        browser.Dispose();
    }

    internal Task ResetConnectionFailuresAsync(CancellationToken ct) =>
        repository.Database.RunAsync(
            db =>
            {
                using var tx = db.BeginTransaction();
                var reset = new List<(string Key, AccessState State)>();
                using (var command = db.Command("SELECT key,value FROM settings WHERE key LIKE 'source.access.%'"))
                using (var reader = command.ExecuteReader())
                    while (reader.Read())
                    {
                        var state = JsonSerializer.Deserialize<AccessState>(reader.GetString(1));
                        if (state?.Failure is "connection-failed" or "timeout" or "browser-disconnected")
                            reset.Add((reader.GetString(0), state));
                    }
                foreach (var (key, state) in reset)
                    db.Execute(
                        "UPDATE settings SET value=@v WHERE key=@k",
                        ("@v", JsonSerializer.Serialize(state with { Failures = 0, RetryAt = null, Failure = null })),
                        ("@k", key)
                    );
                tx.Commit();
            },
            ct
        );
}
