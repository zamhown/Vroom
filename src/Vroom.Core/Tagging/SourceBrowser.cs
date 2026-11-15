using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Win32.SafeHandles;
using Vroom.Core.Application;
using Vroom.Core.Processes;

namespace Vroom.Core.Tagging;

internal sealed record SourceDocument(byte[] Bytes, Uri Url, int Status = 200, TimeSpan? RetryAfter = null);

internal interface ISourceBrowser : IDisposable
{
    Task<SourceDocument> FetchAsync(
        string sourceId,
        Uri url,
        JsonNode options,
        int limit,
        string executable,
        Func<UiMessage, Task>? progress,
        CancellationToken ct
    );
    Task<SourceDocument> FetchAssetAsync(
        string sourceId,
        Uri url,
        JsonNode options,
        int limit,
        string executable,
        Uri? referrer,
        CancellationToken ct
    ) => throw new SourceAccessException("browser-unavailable", "host.SourceAccess.browserMissing");
}

internal sealed class SourceAccessException(
    string code,
    string messageId,
    DateTimeOffset? retryAt = null,
    Exception? inner = null
) : Exception(messageId, inner)
{
    internal string Code { get; } = code;
    internal DateTimeOffset? RetryAt { get; } = retryAt;
}

internal static class SourceBrowserRules
{
    internal static void Validate(JsonNode source, string path)
    {
        var request = source["request"];
        if (request.Text("mode", "http") == "http")
            return;
        var options = request?["browser"];
        if (source["parse"].Text("format") != "html" || options is null)
            throw new TagException("SOURCE_BROWSER_CONFIG_INVALID", path, "host.SourceAccess.invalidConfiguration");
        if (
            !Uri.TryCreate(request.Text("urlTemplate"), UriKind.Absolute, out var uri)
            || uri.Scheme is not ("http" or "https")
            || uri.UserInfo.Length > 0
            || !options
                .List("allowedHosts")
                .Any(h => string.Equals(h!.ToString(), uri.IdnHost, StringComparison.OrdinalIgnoreCase))
        )
            throw new TagException("SOURCE_BROWSER_CONFIG_INVALID", path, "host.SourceAccess.invalidConfiguration");
        foreach (var host in options.List("allowedHosts"))
            if (
                Uri.CheckHostName(host!.ToString()) != UriHostNameType.Dns
                || host.ToString().Contains('*')
                || host.ToString().Contains('{')
            )
                throw new TagException("SOURCE_BROWSER_CONFIG_INVALID", path, "host.SourceAccess.invalidConfiguration");
        try
        {
            new AngleSharp.Html.Parser.HtmlParser().ParseDocument("").QuerySelector(options.Text("readySelector"));
        }
        catch (Exception)
        {
            throw new TagException("SOURCE_BROWSER_CONFIG_INVALID", path, "host.SourceAccess.invalidConfiguration");
        }
    }

    internal static bool Ready(JsonNode options, string html) =>
        new AngleSharp.Html.Parser.HtmlParser().ParseDocument(html).QuerySelector(options.Text("readySelector"))
            is not null;
}

// A dedicated Chromium process/profile per source and route. It never opens the user's
// personal profile. Both platforms use CDP; no Windows-only embedded WebView is required.
internal sealed class SourceBrowser(
    string dataDirectory,
    bool enabled,
    IWebProxy? proxy = null,
    Func<IWebProxy>? routeProvider = null
) : ISourceBrowser
{
    private sealed class Slot
    {
        internal readonly SemaphoreSlim Gate = new(1, 1);
        internal BrowserSession? Session;
        internal string Configuration = "";
        internal DateTimeOffset Used = DateTimeOffset.UtcNow;
    }

    private readonly ConcurrentDictionary<string, Slot> slots = new();
    private readonly IWebProxy routes = proxy ?? HttpClient.DefaultProxy;
    private readonly CancellationTokenSource lifetime = new();
    private readonly object idle = new();
    private bool started;

    internal static string? FindExecutable(string chosen)
    {
        if (chosen.Length > 0)
            return File.Exists(chosen) ? Path.GetFullPath(chosen) : null;
        var paths = OperatingSystem.IsWindows()
            ? new[]
            {
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            }.SelectMany(root =>
                new[]
                {
                    Path.Combine(root, "Google", "Chrome", "Application", "chrome.exe"),
                    Path.Combine(root, "Microsoft", "Edge", "Application", "msedge.exe"),
                }
            )
            : new[]
            {
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
                "/Applications/Chromium.app/Contents/MacOS/Chromium",
                "/usr/bin/google-chrome",
                "/usr/bin/chromium",
            }.AsEnumerable();
        return paths.FirstOrDefault(File.Exists);
    }

    public async Task<SourceDocument> FetchAsync(
        string sourceId,
        Uri url,
        JsonNode options,
        int limit,
        string executable,
        Func<UiMessage, Task>? progress,
        CancellationToken ct
    ) => await FetchCoreAsync(sourceId, url, options, limit, executable, progress, false, null, ct);

    public Task<SourceDocument> FetchAssetAsync(
        string sourceId,
        Uri url,
        JsonNode options,
        int limit,
        string executable,
        Uri? referrer,
        CancellationToken ct
    ) => FetchCoreAsync(sourceId, url, options, limit, executable, null, true, referrer, ct);

    private async Task<SourceDocument> FetchCoreAsync(
        string sourceId,
        Uri url,
        JsonNode options,
        int limit,
        string executable,
        Func<UiMessage, Task>? progress,
        bool asset,
        Uri? referrer,
        CancellationToken ct
    )
    {
        if (!enabled)
            throw new SourceAccessException("browser-unavailable", "host.SourceAccess.desktopRequired");
        var binary =
            FindExecutable(executable)
            ?? throw new SourceAccessException("browser-unavailable", "host.SourceAccess.browserMissing");
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, lifetime.Token);
        ct = linked.Token;
        var routes = routeProvider?.Invoke() ?? this.routes;
        var route = routes.IsBypassed(url) ? null : routes.GetProxy(url);
        if (route == url)
            route = null;
        if (route is not null && (route.UserInfo.Length > 0 || routes.Credentials is not null))
            throw new SourceAccessException("browser-proxy-auth", "host.SourceAccess.proxyAuthentication");
        var hosts = options
            .List("allowedHosts")
            .Select(h => h!.ToString().ToLowerInvariant())
            .Distinct()
            .Order()
            .ToArray();
        var pins = new Dictionary<string, string>();
        foreach (var host in hosts)
        {
            var target = new UriBuilder(url.Scheme, host, url.Port).Uri;
            var hostRoute = routes.IsBypassed(target) ? null : routes.GetProxy(target);
            if (hostRoute == target)
                hostRoute = null;
            if (hostRoute != route)
                throw new SourceAccessException("browser-proxy-route", "host.SourceAccess.proxyRoutesDiffer");
            var addresses = await Dns.GetHostAddressesAsync(host, ct);
            if (addresses.Length == 0)
                throw new HttpRequestException("Source host unavailable");
            foreach (var address in addresses)
                SourceHttpClient.ValidateAddress(address);
            var addressToUse =
                addresses.FirstOrDefault(a => a.AddressFamily == AddressFamily.InterNetwork) ?? addresses[0];
            pins[host] = addressToUse.ToString();
        }
        var key = TagJson.Hash(new JsonObject { ["source"] = sourceId, ["route"] = route?.AbsoluteUri });
        var slot = slots.GetOrAdd(key, _ => new());
        await slot.Gate.WaitAsync(ct);
        try
        {
            var configuration = binary + JsonSerializer.Serialize(pins);
            if (slot.Session is null || !slot.Session.Alive || slot.Configuration != configuration)
            {
                if (slot.Session is not null)
                    await slot.Session.DisposeAsync();
                slot.Session = null;
                var profile = Path.Combine(dataDirectory, "source-browser", key);
                slot.Session = await BrowserSession.StartAsync(binary, profile, route, pins, ct);
                slot.Configuration = configuration;
            }
            return asset
                ? await slot.Session.FetchAssetAsync(url, limit, referrer, ct)
                : await slot.Session.FetchAsync(url, options, limit, progress, ct);
        }
        catch (Exception ex) when (ex is IOException or System.Net.WebSockets.WebSocketException)
        {
            if (slot.Session is not null)
                await slot.Session.DisposeAsync();
            slot.Session = null;
            throw new SourceAccessException("browser-disconnected", "host.SourceAccess.browserDisconnected", inner: ex);
        }
        finally
        {
            slot.Used = DateTimeOffset.UtcNow;
            slot.Gate.Release();
            lock (idle)
            {
                if (!started)
                {
                    started = true;
                    _ = ReapAsync();
                }
            }
        }
    }

    private async Task ReapAsync()
    {
        try
        {
            using var timer = new PeriodicTimer(TimeSpan.FromMinutes(1));
            while (await timer.WaitForNextTickAsync(lifetime.Token))
                foreach (var slot in slots.Values)
                    if (DateTimeOffset.UtcNow - slot.Used > TimeSpan.FromMinutes(10) && slot.Gate.Wait(0))
                    {
                        try
                        {
                            if (slot.Session is not null)
                                await slot.Session.DisposeAsync();
                            slot.Session = null;
                        }
                        finally
                        {
                            slot.Gate.Release();
                        }
                    }
        }
        catch (OperationCanceledException) { }
    }

    public void Dispose()
    {
        lifetime.Cancel();
        // Browser.close flushes the dedicated profile's cookies before process exit.
        var close = Task.Run(async () =>
            await Task.WhenAll(
                slots.Values.Select(async slot =>
                {
                    await slot.Gate.WaitAsync();
                    try
                    {
                        if (slot.Session is not null)
                            await slot.Session.DisposeAsync();
                        slot.Session = null;
                    }
                    finally
                    {
                        slot.Gate.Release();
                    }
                })
            )
        );
        if (!close.Wait(TimeSpan.FromSeconds(8)))
            foreach (var slot in slots.Values)
                slot.Session?.Terminate();
    }
}

internal sealed class BrowserSession : IAsyncDisposable
{
    private readonly Process process;
    private readonly SafeFileHandle? processLifetime;
    private readonly SourceBrowserProtocol protocol;
    private readonly HashSet<string> hosts;
    private readonly LocalDiagnostics diagnostics;
    private readonly CancellationTokenSource stop = new();
    private Task? events;
    private string session = "",
        target = "",
        mainFrame = "";
    private int status;
    private string? blockedDocument;
    private bool requireHttps;
    private int initialPort;
    private TimeSpan? retryAfter;
    private string mainRequest = "",
        mainLocation = "";
    private readonly ConcurrentDictionary<string, bool> finished = new();
    private int terminated;
    private bool closing;
    private readonly TaskCompletionSource attached = new(TaskCreationOptions.RunContinuationsAsynchronously);
    internal bool Alive => !process.HasExited && events is { IsCompleted: false };

    private BrowserSession(
        Process process,
        SafeFileHandle? processLifetime,
        SourceBrowserProtocol protocol,
        IEnumerable<string> hosts,
        string directory
    )
    {
        this.process = process;
        this.processLifetime = processLifetime;
        this.protocol = protocol;
        this.hosts = new(hosts, StringComparer.OrdinalIgnoreCase);
        diagnostics = new(directory);
    }

    internal static async Task<BrowserSession> StartAsync(
        string binary,
        string profile,
        Uri? route,
        Dictionary<string, string> pins,
        CancellationToken ct
    )
    {
        Directory.CreateDirectory(profile);
        var activePort = Path.Combine(profile, "DevToolsActivePort");
        if (File.Exists(activePort))
            File.Delete(activePort);
        var start = new ProcessStartInfo(binary)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
        };
        foreach (
            var arg in new[]
            {
                "--remote-debugging-port=0",
                "--remote-debugging-address=127.0.0.1",
                "--user-data-dir=" + profile,
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-sync",
                "--disable-background-networking",
                "--disable-quic",
                "--disable-component-update",
                "--start-minimized",
                "--window-size=1000,760",
                "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
            }
        )
            start.ArgumentList.Add(arg);
        start.ArgumentList.Add(
            route is null ? "--no-proxy-server" : "--proxy-server=" + route.GetLeftPart(UriPartial.Authority)
        );
        // Direct DNS is pinned for the entire process, including popups/workers. Unknown
        // hosts cannot resolve. For an explicit proxy that proxy remains the DNS boundary.
        start.ArgumentList.Add(
            "--host-resolver-rules="
                + (route is null ? "" : "EXCLUDE " + route.IdnHost + ", ")
                + string.Join(
                    ", ",
                    pins.Select(p => "MAP " + p.Key + " " + (p.Value.Contains(':') ? "[" + p.Value + "]" : p.Value))
                )
                + ", MAP * ~NOTFOUND"
        );
        start.ArgumentList.Add("about:blank");
        var process = ChildProcessLifetime.Start(start) ?? throw new IOException("Browser failed to start");
        var protocol = new SourceBrowserProtocol();
        SafeFileHandle? processLifetime = null;
        BrowserSession? result = null;
        try
        {
            // Chromium must not retain the dedicated profile after a host crash/restart.
            processLifetime = ChildProcessLifetime.Attach(process);
            using var startup = CancellationTokenSource.CreateLinkedTokenSource(ct);
            startup.CancelAfter(TimeSpan.FromSeconds(20));
            string[] lines = [];
            while (lines.Length < 2)
            {
                startup.Token.ThrowIfCancellationRequested();
                if (process.HasExited)
                    throw new IOException("Browser exited during startup");
                try
                {
                    if (File.Exists(activePort))
                        lines = await File.ReadAllLinesAsync(activePort, startup.Token);
                }
                catch (IOException) { }
                if (lines.Length < 2)
                    await Task.Delay(100, startup.Token);
            }
            if (
                !int.TryParse(lines[0], out var port)
                || port is < 1 or > 65535
                || !lines[1].StartsWith("/devtools/browser/", StringComparison.Ordinal)
            )
                throw new IOException("Invalid browser endpoint");
            await protocol.ConnectAsync(new Uri($"ws://127.0.0.1:{port}{lines[1]}"), startup.Token);
            result = new(
                process,
                processLifetime,
                protocol,
                pins.Keys,
                Path.GetDirectoryName(Path.GetDirectoryName(profile))!
            );
            result.events = result.EventsAsync();
            await protocol.CallAsync("Browser.setDownloadBehavior", new { behavior = "deny" }, ct: startup.Token);
            var targets = await protocol.CallAsync("Target.getTargets", ct: startup.Token);
            result.target = targets["targetInfos"]!.AsArray().First(t => t.Text("type") == "page").Text("targetId");
            await protocol.CallAsync(
                "Target.setAutoAttach",
                new
                {
                    autoAttach = true,
                    waitForDebuggerOnStart = true,
                    flatten = true,
                },
                ct: startup.Token
            );
            await result.attached.Task.WaitAsync(startup.Token);
            await result.PlaceAsync(false, startup.Token);
            return result;
        }
        catch
        {
            if (result is not null)
                await result.DisposeAsync();
            else
            {
                try
                {
                    process.Kill(true);
                }
                catch (InvalidOperationException) { }
                processLifetime?.Dispose();
                await protocol.DisposeAsync();
                process.Dispose();
            }
            throw;
        }
    }

    private async Task ConfigureAsync(string id, CancellationToken ct)
    {
        await protocol.CallAsync(
            "Fetch.enable",
            new { patterns = new[] { new { urlPattern = "*", requestStage = "Request" } } },
            id,
            ct
        );
        await protocol.CallAsync("Network.enable", session: id, ct: ct);
        await protocol.CallAsync("Network.setBypassServiceWorker", new { bypass = true }, id, ct);
        await protocol.CallAsync(
            "Target.setAutoAttach",
            new
            {
                autoAttach = true,
                waitForDebuggerOnStart = true,
                flatten = true,
            },
            id,
            ct
        );
    }

    internal bool Allows(Uri uri) =>
        uri.Scheme is "https" or "http"
        && (!requireHttps || uri.Scheme == "https")
        && uri.UserInfo.Length == 0
        && hosts.Contains(uri.IdnHost)
        && (uri.IsDefaultPort || uri.Port == initialPort);

    private async Task EventsAsync()
    {
        try
        {
            await foreach (var message in protocol.Events.ReadAllAsync(stop.Token))
            {
                var args = message["params"]!;
                var id = message.Text("sessionId");
                switch (message.Text("method"))
                {
                    case "Target.attachedToTarget":
                        var child = args.Text("sessionId");
                        var primary = args["targetInfo"].Text("targetId") == target;
                        if (primary)
                            session = child;
                        if (args["targetInfo"].Text("type") is "page" or "iframe")
                            await ConfigureAsync(child, stop.Token);
                        else
                            await protocol.CallAsync(
                                "Fetch.enable",
                                new { patterns = new[] { new { urlPattern = "*" } } },
                                child,
                                stop.Token
                            );
                        await protocol.CallAsync("Runtime.runIfWaitingForDebugger", session: child, ct: stop.Token);
                        if (primary)
                            attached.TrySetResult();
                        break;
                    case "Fetch.requestPaused":
                        var permitted =
                            Uri.TryCreate(args["request"].Text("url"), UriKind.Absolute, out var uri) && Allows(uri);
                        if (args.Text("resourceType") is "Media" or "Font")
                            permitted = false;
                        if (!permitted && uri is not null && args.Text("resourceType") is not ("Media" or "Font"))
                            diagnostics.Write(
                                "source.browser.blocked",
                                JsonSerializer.Serialize(new { host = uri.Host, type = args.Text("resourceType") })
                            );
                        if (
                            !permitted
                            && args.Text("resourceType") == "Document"
                            && id == session
                            && args.Text("frameId") == mainFrame
                        )
                            blockedDocument = "host.SourceAccess.addressForbidden";
                        try
                        {
                            await protocol.CallAsync(
                                permitted ? "Fetch.continueRequest" : "Fetch.failRequest",
                                permitted
                                    ? new { requestId = args.Text("requestId") }
                                    : (object)
                                        new { requestId = args.Text("requestId"), errorReason = "BlockedByClient" },
                                id,
                                stop.Token
                            );
                        }
                        catch (SourceBrowserProtocolException error)
                            when (error.Code == -32602
                                && error.Message.Contains("InterceptionId", StringComparison.Ordinal)
                            )
                        { /* Navigation/cancellation can invalidate an already queued request. */
                        }
                        break;
                    case "Network.responseReceived":
                        if (id == session && args.Text("type") == "Document" && args.Text("frameId") == mainFrame)
                        {
                            status = (int)args["response"].Number("status");
                            var headers = args["response"]?["headers"]?.AsObject();
                            retryAfter = SourceAccess.RetryDelay(
                                headers
                                    ?.FirstOrDefault(h =>
                                        h.Key.Equals("retry-after", StringComparison.OrdinalIgnoreCase)
                                    )
                                    .Value?.ToString()
                            );
                        }
                        break;
                    case "Network.requestWillBeSent":
                        if (id == session && args.Text("type") == "Document" && args.Text("frameId") == mainFrame)
                        {
                            mainRequest = args.Text("requestId");
                            mainLocation = args["request"].Text("url");
                        }
                        break;
                    case "Network.loadingFinished":
                        if (id == session && args.Text("requestId") == mainRequest)
                            finished[mainRequest] = true;
                        break;
                    case "Network.loadingFailed":
                        if (id == session && args.Text("requestId") == mainRequest)
                            finished[mainRequest] = false;
                        break;
                }
            }
        }
        catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
        catch (Exception error)
        {
            attached.TrySetException(error);
            if (!closing)
            {
                diagnostics.Error("source.browser.protocol", error);
                Terminate();
            }
        }
    }

    internal async Task<SourceDocument> FetchAsync(
        Uri url,
        JsonNode options,
        int limit,
        Func<UiMessage, Task>? progress,
        CancellationToken ct
    )
    {
        requireHttps = url.Scheme == "https";
        initialPort = url.Port;
        if (!Allows(url))
            throw new SourceAccessException("address-forbidden", "host.SourceAccess.addressForbidden");
        status = 0;
        retryAfter = null;
        blockedDocument = null;
        mainRequest = "";
        finished.Clear();
        if (progress is not null)
            await progress(UiMessage.Of("host.SourceAccess.browserLoading", url.Host));
        var selector = JsonSerializer.Serialize(options.Text("readySelector"));
        var watch = Stopwatch.StartNew();
        var waiting = false;
        var pageWait = TimeSpan.FromSeconds(options.Number("pageTimeoutSeconds", 20));
        var humanWait = TimeSpan.FromSeconds(options.Number("verificationTimeoutSeconds", 120));
        try
        {
            var frame = await protocol.CallAsync("Page.getFrameTree", session: session, ct: ct);
            mainFrame = frame["frameTree"]!["frame"].Text("id");
            var navigation = await protocol.CallAsync("Page.navigate", new { url = url.AbsoluteUri }, session, ct);
            if (navigation.Text("errorText").Length > 0)
                throw new SourceAccessException(
                    "connection-failed",
                    "host.SourceAccess.connectionFailed",
                    inner: new IOException(navigation.Text("errorText"))
                );
            while (watch.Elapsed < pageWait + humanWait)
            {
                ct.ThrowIfCancellationRequested();
                if (!Alive)
                    throw new IOException("Browser process disconnected");
                if (blockedDocument is not null)
                    throw new SourceAccessException("address-forbidden", blockedDocument);
                JsonObject state;
                try
                {
                    var value = await protocol.CallAsync(
                        "Runtime.evaluate",
                        new
                        {
                            expression = $"(() => ({{url:location.href,ready:document.readyState!=='loading'&&!!document.querySelector({selector})}}))()",
                            returnByValue = true,
                        },
                        session,
                        ct
                    );
                    if (value["exceptionDetails"] is not null)
                        throw new SourceAccessException(
                            "configuration-invalid",
                            "host.SourceAccess.invalidConfiguration"
                        );
                    state = value["result"]?["value"]?.AsObject() ?? new();
                }
                catch (IOException) when (Alive)
                {
                    await Task.Delay(250, ct);
                    continue;
                }
                var finalUrl = state.Text("url");
                if (!waiting && watch.Elapsed >= pageWait)
                    diagnostics.Write(
                        "source.browser.waiting",
                        JsonSerializer.Serialize(
                            new
                            {
                                status,
                                ready = state.Flag("ready"),
                                location = Uri.TryCreate(finalUrl, UriKind.Absolute, out var observed)
                                    ? observed.GetLeftPart(UriPartial.Authority)
                                    : finalUrl,
                            }
                        )
                    );
                if (finalUrl.StartsWith("chrome-error:", StringComparison.Ordinal))
                    throw new SourceAccessException("connection-failed", "host.SourceAccess.connectionFailed");
                if (state.Flag("ready") || status is >= 400 and not 403)
                {
                    if (!Uri.TryCreate(finalUrl, UriKind.Absolute, out var final) || !Allows(final))
                        throw new SourceAccessException("address-forbidden", "host.SourceAccess.addressForbidden");
                    var value = await protocol.CallAsync(
                        "Runtime.evaluate",
                        new
                        {
                            expression = $"(() => {{const html=document.documentElement.outerHTML;return html.length>{limit}?null:html;}})()",
                            returnByValue = true,
                        },
                        session,
                        ct
                    );
                    var html =
                        value["result"]?["value"]?.GetValue<string>()
                        ?? throw new SourceAccessException("too-large", "host.SourceAccess.tooLarge");
                    var bytes = Encoding.UTF8.GetBytes(html);
                    if (bytes.Length > limit)
                        throw new SourceAccessException("too-large", "host.SourceAccess.tooLarge");
                    return new(bytes, final, status == 0 ? 200 : status, retryAfter);
                }
                if (!waiting && watch.Elapsed >= pageWait)
                {
                    waiting = true;
                    if (progress is not null)
                        await progress(UiMessage.Of("host.SourceAccess.waitingVerification", url.Host));
                    await PlaceAsync(true, ct);
                }
                await Task.Delay(500, ct);
            }
            throw new SourceAccessException("verification-required", "host.SourceAccess.verificationRequired");
        }
        finally
        {
            try
            {
                using var cleanup = new CancellationTokenSource(TimeSpan.FromSeconds(3));
                await protocol.CallAsync("Page.navigate", new { url = "about:blank" }, session, cleanup.Token);
                await PlaceAsync(false, cleanup.Token);
            }
            catch (Exception)
            {
                Terminate();
            }
        }
    }

    private async Task PlaceAsync(bool visible, CancellationToken ct)
    {
        var window = await protocol.CallAsync("Browser.getWindowForTarget", new { targetId = target }, ct: ct);
        await protocol.CallAsync(
            "Browser.setWindowBounds",
            new
            {
                windowId = window["windowId"]!.GetValue<int>(),
                bounds = new { windowState = visible ? "normal" : "minimized" },
            },
            ct: ct
        );
        if (visible)
            await protocol.CallAsync("Page.bringToFront", session: session, ct: ct);
    }

    internal void Terminate()
    {
        if (Interlocked.Exchange(ref terminated, 1) != 0)
            return;
        stop.Cancel();
        try
        {
            if (!process.HasExited)
                process.Kill(true);
        }
        catch (InvalidOperationException) { }
        processLifetime?.Dispose();
    }

    internal async Task<SourceDocument> FetchAssetAsync(Uri url, int limit, Uri? referrer, CancellationToken ct)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(20));
        ct = timeout.Token;
        requireHttps = url.Scheme == "https";
        initialPort = url.Port;
        status = 0;
        blockedDocument = null;
        mainRequest = "";
        finished.Clear();
        if (!Allows(url))
            throw new SourceAccessException("address-forbidden", "host.SourceAccess.addressForbidden");
        try
        {
            var frame = await protocol.CallAsync("Page.getFrameTree", session: session, ct: ct);
            mainFrame = frame["frameTree"]!["frame"].Text("id");
            var navigation = await protocol.CallAsync(
                "Page.navigate",
                new { url = url.AbsoluteUri, referrer = referrer?.AbsoluteUri ?? "" },
                session,
                ct
            );
            if (navigation.Text("errorText").Length > 0)
                throw new IOException(navigation.Text("errorText"));
            while (!finished.TryGetValue(mainRequest, out _))
            {
                ct.ThrowIfCancellationRequested();
                if (!Alive)
                    throw new IOException("Browser disconnected");
                await Task.Delay(100, ct);
            }
            if (!finished[mainRequest] || blockedDocument is not null)
                throw new SourceAccessException("connection-failed", "host.SourceAccess.connectionFailed");
            if (!Uri.TryCreate(mainLocation, UriKind.Absolute, out var final) || !Allows(final))
                throw new SourceAccessException("address-forbidden", "host.SourceAccess.addressForbidden");
            var body = await protocol.CallAsync(
                "Network.getResponseBody",
                new { requestId = mainRequest },
                session,
                ct
            );
            var bytes = body.Flag("base64Encoded")
                ? Convert.FromBase64String(body.Text("body"))
                : Encoding.UTF8.GetBytes(body.Text("body"));
            if (bytes.Length > limit)
                throw new SourceAccessException("too-large", "host.SourceAccess.tooLarge");
            return new(bytes, final, status, retryAfter);
        }
        finally
        {
            try
            {
                using var cleanup = new CancellationTokenSource(TimeSpan.FromSeconds(3));
                await protocol.CallAsync("Page.navigate", new { url = "about:blank" }, session, cleanup.Token);
                await PlaceAsync(false, cleanup.Token);
            }
            catch (Exception)
            {
                Terminate();
            }
        }
    }

    public async ValueTask DisposeAsync()
    {
        closing = true;
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            await protocol.CallAsync("Browser.close", ct: timeout.Token);
            await process.WaitForExitAsync(timeout.Token);
        }
        catch (Exception) { }
        Terminate();
        await protocol.DisposeAsync();
        if (events is not null)
            try
            {
                await events;
            }
            catch (Exception) { }
        process.Dispose();
        stop.Dispose();
    }
}
