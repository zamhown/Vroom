using System.Runtime.InteropServices;
using CoreGraphics;
using Foundation;
using Microsoft.Maui.Handlers;
using Microsoft.Maui.Platform;
using Vroom.Core.Application;
using WebKit;

namespace Vroom.App;

// WKWebView's supplied configuration preserves window.opener and the JavaScript
// realm. React portals retain the original application state and mounted players.
internal sealed class MacDialogWindows(LocalDiagnostics log, Func<Task> stopPlayback)
    : WKUIDelegate,
        IWKScriptMessageHandler
{
    private readonly LocalDiagnostics diagnostics = log;
    private readonly Dictionary<WKWebView, Entry> windows = [];
    private WKWebView? root;
    private WKNavigationDelegate? rootNavigation;
    private bool disposed;

    // AppKit invokes these on the main thread. Tokens are process-wide so a late
    // callback cannot address a new window belonging to a replacement root.
    private static ulong nextToken;
    private static readonly Dictionary<ulong, WeakReference<MacDialogWindows>> owners = [];
    private static readonly CloseRequest closeRequest = OnCloseRequest;
    private AttachDialog? attachDialog;
    private DetachDialog? detachDialog;
    private ResizeDialog? resizeDialog;
    private CaptureWindow? captureWindow;

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate int AttachDialog(
        ulong token,
        ulong owner,
        [MarshalAs(UnmanagedType.LPUTF8Str)] string title,
        CloseRequest callback
    );

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate void DetachDialog(ulong token);

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate double ResizeDialog(ulong token, double width, double height);

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate void CaptureWindow();

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate void CloseRequest(ulong token);

    private sealed record Entry(WKWebView Web, WKWebView Owner, Window Window, bool Exclusive, double Width)
    {
        public IDisposable? TitleObserver;
        public WKNavigationDelegate? Navigation;
        public bool Sized;
        public CancellationTokenSource Initialization = new();
        public ulong Token;
        public bool Attached;
        public int? RequestedHeight;
    }

    public void Configure(WKWebViewConfiguration configuration)
    {
        // The desktop UI must survive Spaces transitions without a suspended
        // WebContent process. External mpv playback is invisible to WebKit's
        // built-in media exemption. Child windows inherit these preferences.
        configuration.Preferences.InactiveSchedulingPolicy = WKInactiveSchedulingPolicy.None;
        configuration.Preferences.JavaScriptCanOpenWindowsAutomatically = true;
        configuration.Preferences.ElementFullscreenEnabled = true;
        configuration.UserContentController.AddScriptMessageHandler(this, "vroomDialog");
        configuration.UserContentController.AddUserScript(
            new WKUserScript(
                new NSString(
                    """
                    window.__vroomWindows = true;
                    window.__vroomComposition = true;
                    window.__vroomDialogHost = {
                      postMessage: value => window.webkit.messageHandlers.vroomDialog.postMessage(value),
                      addEventListener: (name, listener) => window.addEventListener('vroom-dialog-message', listener),
                      removeEventListener: (name, listener) => window.removeEventListener('vroom-dialog-message', listener)
                    };
                    window.addEventListener('pagehide', () => window.webkit.messageHandlers.vroomDialog.postMessage('dialog-owner-closing'));
                    """
                ),
                WKUserScriptInjectionTime.AtDocumentStart,
                true
            )
        );
    }

    public void Attach(WKWebView web)
    {
        root = web;
        web.UIDelegate = this;
        rootNavigation = new RootNavigation(Recover);
        web.NavigationDelegate = rootNavigation;
        var library = NativeLibrary.Load(
            Path.GetFullPath(
                Path.Combine(AppContext.BaseDirectory, "..", "Resources", "runtime", "host", "libvroom-window.dylib")
            )
        );
        attachDialog = Marshal.GetDelegateForFunctionPointer<AttachDialog>(
            NativeLibrary.GetExport(library, "vroom_dialog_attach")
        );
        detachDialog = Marshal.GetDelegateForFunctionPointer<DetachDialog>(
            NativeLibrary.GetExport(library, "vroom_dialog_detach")
        );
        resizeDialog = Marshal.GetDelegateForFunctionPointer<ResizeDialog>(
            NativeLibrary.GetExport(library, "vroom_dialog_resize")
        );
        captureWindow = Marshal.GetDelegateForFunctionPointer<CaptureWindow>(
            NativeLibrary.GetExport(library, "vroom_window_attach")
        );
    }

    [ObjCRuntime.MonoPInvokeCallback(typeof(CloseRequest))]
    private static void OnCloseRequest(ulong token)
    {
        if (!owners.TryGetValue(token, out var reference) || !reference.TryGetTarget(out var owner))
            return;
        try
        {
            var entry = owner.windows.Values.FirstOrDefault(entry => entry.Token == token);
            entry?.Web.EvaluateJavaScript("window.dispatchEvent(new Event('vroom-window-close'))", (_, _) => { });
        }
        catch (Exception error)
        {
            // Exceptions must never escape through the unmanaged callback boundary.
            owner.diagnostics.Error("dialog.close-request", error);
        }
    }

    private async void Recover(WKWebView web)
    {
        if (disposed || web != root)
            return;
        diagnostics.Write(
            "webview.terminated",
            "Recovering the local document after WebKit content process termination."
        );
        foreach (var child in windows.Keys.ToArray())
            Close(child, true);
        try
        {
            // A dead JavaScript realm cannot release its sessions. Stop them before
            // restoring the persisted workspace so there are no orphan decoders.
            await stopPlayback();
            if (!disposed)
                web.LoadRequest(new NSUrlRequest(new NSUrl("app://0.0.0.1/")));
        }
        catch (Exception error)
        {
            diagnostics.Error("webview.recover", error);
        }
    }

    public override WKWebView? CreateWebView(
        WKWebView webView,
        WKWebViewConfiguration configuration,
        WKNavigationAction navigationAction,
        WKWindowFeatures windowFeatures
    )
    {
        if (
            disposed
            || (webView != root && !windows.ContainsKey(webView))
            || !DialogWindowRequest.TryParse(navigationAction.Request.Url?.AbsoluteString ?? "", out var options, "app")
            || windows.Values.Any(w => w.Owner == webView && w.Exclusive)
        )
            return null;
        var child = new WKWebView(CGRect.Empty, configuration)
        {
            UIDelegate = this,
            BackgroundColor = SpectrumColors.Base.ToPlatform(),
            Opaque = true,
        };
        var page = new ContentPage { Content = new MacDialogView(child), BackgroundColor = SpectrumColors.Base };
        var window = new Window(page)
        {
            Title = "Vroom",
            Width = options.Width,
            Height = options.Height,
            MinimumWidth = 320,
            MinimumHeight = 180,
        };
        captureWindow?.Invoke();
        var entry = new Entry(child, webView, window, options.Exclusive, options.Width) { Token = ++nextToken };
        entry.Navigation = new DialogNavigation(() => entry.Initialization.Cancel(), () => Close(child, true));
        child.NavigationDelegate = entry.Navigation;
        windows.Add(child, entry);
        owners.Add(entry.Token, new WeakReference<MacDialogWindows>(this));
        entry.TitleObserver = child.AddObserver(
            "title",
            NSKeyValueObservingOptions.New,
            _ => window.Title = child.Title ?? "Vroom"
        );
        window.Destroying += (_, _) => Close(child, false);
        async void AttachWhenReady(object? sender, EventArgs args)
        {
            // The AppKit scene may appear after the UIKit creation callback.
            // Creation must work even while the application is inactive.
            for (var attempt = 0; attempt < 20 && windows.ContainsKey(child) && !entry.Attached; attempt++)
            {
                await Task.Delay(50);
                AttachWindow(entry);
            }
        }
        window.Created += AttachWhenReady;
        window.Activated += AttachWhenReady;
        if (options.Exclusive)
            webView.UserInteractionEnabled = false;
        try
        {
            SceneDelegate.ExpectDialog(window);
            Application.Current!.OpenWindow(window);
        }
        catch
        {
            Close(child, false);
            throw;
        }
        _ = ExpireAsync(entry);
        diagnostics.Write("dialog.open", options.Id + " mode=" + (options.Exclusive ? "exclusive" : "modeless"));
        return child;
    }

    private async Task ExpireAsync(Entry entry)
    {
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(15), entry.Initialization.Token);
            MainThread.BeginInvokeOnMainThread(() => Close(entry.Web, true));
        }
        catch (OperationCanceledException) { }
    }

    public override void DidClose(WKWebView webView) => Close(webView, true);

    private void AttachWindow(Entry entry)
    {
        if (entry.Attached || !windows.ContainsKey(entry.Web))
            return;
        var owner = windows.TryGetValue(entry.Owner, out var parent) ? parent.Token : 0;
        entry.Attached = attachDialog?.Invoke(entry.Token, owner, entry.Window.Title ?? "Vroom", closeRequest) == 1;
        if (entry.Attached)
        {
            diagnostics.Write("dialog.ownership", $"token={entry.Token} attached=True");
            SizeWindow(entry);
        }
    }

    private void Close(WKWebView web, bool closeWindow)
    {
        if (!windows.Remove(web, out var entry))
            return;
        owners.Remove(entry.Token);
        SceneDelegate.ForgetDialog(entry.Window);
        foreach (var child in windows.Values.Where(w => w.Owner == web).ToArray())
            Close(child.Web, true);
        entry.TitleObserver?.Dispose();
        detachDialog?.Invoke(entry.Token);
        entry.Initialization.Cancel();
        if (entry.Exclusive)
            entry.Owner.UserInteractionEnabled = true;
        // A user closing the native scene also closes the opener's portal.
        web.EvaluateJavaScript("window.dispatchEvent(new Event('pagehide'))", (_, _) => { });
        if (closeWindow)
            Application.Current?.CloseWindow(entry.Window);
        web.StopLoading();
        web.UIDelegate = null!;
    }

    public void DidReceiveScriptMessage(WKUserContentController controller, WKScriptMessage message)
    {
        if (
            message.FrameInfo.MainFrame
            && message.Body.ToString() == "dialog-owner-closing"
            && message.WebView is { } owner
            && (owner == root || windows.ContainsKey(owner))
        )
        {
            foreach (var child in windows.Values.Where(w => w.Owner == owner).ToArray())
                Close(child.Web, true);
            return;
        }
        if (
            !message.FrameInfo.MainFrame
            || message.WebView is not { } web
            || !windows.TryGetValue(web, out var entry)
            || !DialogWindowRequest.IsDocument(web.Url?.AbsoluteString ?? "", "app")
        )
            return;
        var value = message.Body.ToString() ?? "";
        const string prefix = "dialog-size|";
        if (
            !value.StartsWith(prefix, StringComparison.Ordinal)
            || !int.TryParse(value.AsSpan(prefix.Length), out var height)
            || height < 180
        )
            return;
        entry.RequestedHeight = height;
        AttachWindow(entry);
        SizeWindow(entry);
    }

    private void SizeWindow(Entry entry)
    {
        var web = entry.Web;
        if (!entry.Attached || entry.RequestedHeight is not { } height || web.Window?.WindowScene is not { } scene)
            return;
        var frame = scene.EffectiveGeometry.SystemFrame;
        if (web.Bounds.Width <= 0 || frame.Width <= 0)
            return;
        // Catalyst's default UI scale differs from AppKit window geometry. Convert
        // CSS/UIKit points before sizing, and only set width on initial placement.
        var scale = frame.Width / web.Bounds.Width;
        var title = Math.Max(0, frame.Height - web.Bounds.Height * scale);
        // AppKit positions and sizes in the same coordinate space as the owner
        // and that screen's usable frame (excluding menu bar and Dock).
        var maximum =
            resizeDialog?.Invoke(entry.Token, entry.Sized ? frame.Width : entry.Width * scale, height * scale + title)
            ?? 0;
        if (maximum <= title)
            return;
        entry.Sized = true;
        var limit = System.Text.Json.JsonSerializer.Serialize(
            new { type = "dialog-size-limit", maxHeight = (maximum - title) / scale }
        );
        web.EvaluateJavaScript(
            "window.dispatchEvent(new MessageEvent('vroom-dialog-message', {data:" + limit + "}))",
            (_, _) => { }
        );
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing && !disposed)
        {
            disposed = true;
            foreach (var web in windows.Keys.ToArray())
                Close(web, true);
            if (root is not null)
            {
                root.UIDelegate = null!;
                root.NavigationDelegate = null!;
                root.Configuration.UserContentController.RemoveScriptMessageHandler("vroomDialog");
            }
        }
        base.Dispose(disposing);
    }

    private sealed class RootNavigation(Action<WKWebView> terminated) : WKNavigationDelegate
    {
        public override void ContentProcessDidTerminate(WKWebView webView) => terminated(webView);
    }

    private sealed class DialogNavigation(Action ready, Action failed) : WKNavigationDelegate
    {
        public override void DidFinishNavigation(WKWebView webView, WKNavigation navigation) => ready();

        public override void DidFailNavigation(WKWebView webView, WKNavigation navigation, NSError error) => failed();

        public override void DidFailProvisionalNavigation(WKWebView webView, WKNavigation navigation, NSError error) =>
            failed();

        public override void ContentProcessDidTerminate(WKWebView webView) => failed();

        public override void DecidePolicy(
            WKWebView webView,
            WKNavigationAction navigationAction,
            Action<WKNavigationActionPolicy> decisionHandler
        ) =>
            decisionHandler(
                DialogWindowRequest.IsDocument(navigationAction.Request.Url?.AbsoluteString ?? "", "app")
                    ? WKNavigationActionPolicy.Allow
                    : WKNavigationActionPolicy.Cancel
            );
    }
}

internal sealed class MacDialogView(WKWebView web) : View
{
    public WKWebView Web { get; } = web;
}

internal sealed class MacDialogViewHandler() : ViewHandler<MacDialogView, WKWebView>(ViewMapper)
{
    protected override WKWebView CreatePlatformView() => VirtualView.Web;
}
