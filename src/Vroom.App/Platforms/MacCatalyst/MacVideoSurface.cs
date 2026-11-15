using System.Runtime.InteropServices;
using UIKit;
using Vroom.Core.Application;
using Vroom.Core.Media;
using WebKit;

namespace Vroom.App;

internal sealed class MacVideoSurface(LocalDiagnostics log) : IDisposable
{
    private readonly Dictionary<string, long> surfaces = [];
    private HybridWebView? client;
    private WKWebView? web;
    private nint windowLibrary;
    private WindowFullscreen? setFullscreen;
    private WindowState? isFullscreen;

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate int WindowFullscreen(int requested);

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate int WindowState();

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate void WindowAttach();

    public bool Embedded => File.Exists(Path.Combine(MediaRuntime.Directory, "host", "vroom-decoder"));
    public bool Fullscreen => isFullscreen?.Invoke() == 1;

    public void Attach(HybridWebView view)
    {
        client = view;
        view.BackgroundColor = Colors.Transparent;
        view.WebViewInitialized += (_, args) => Configure(args.PlatformArgs!.Sender);
        if (view.Handler?.PlatformView is WKWebView existing)
            Configure(existing);
    }

    private void Configure(WKWebView browser)
    {
        web = browser;
        browser.Opaque = false;
        browser.BackgroundColor = UIColor.Clear;
        browser.ScrollView.BackgroundColor = UIColor.Clear;
        browser.UnderPageBackgroundColor = UIColor.Clear;
    }

    public Task<long> CreateAsync(string id) =>
        MainThread.InvokeOnMainThreadAsync(() =>
        {
            if (!Embedded)
                return 0L;
            if (web is null)
                throw new InvalidOperationException("host.Mpv.startFailed");
            var token = vroom_video_create(web.Handle);
            if (token == 0)
                throw new InvalidOperationException("host.Mpv.startFailed");
            surfaces.Add(id, token);
            if (windowLibrary == 0)
            {
                var path = Path.GetFullPath(
                    Path.Combine(
                        AppContext.BaseDirectory,
                        "..",
                        "Resources",
                        "runtime",
                        "host",
                        "libvroom-window.dylib"
                    )
                );
                windowLibrary = NativeLibrary.Load(path);
                setFullscreen = Marshal.GetDelegateForFunctionPointer<WindowFullscreen>(
                    NativeLibrary.GetExport(windowLibrary, "vroom_window_fullscreen")
                );
                isFullscreen = Marshal.GetDelegateForFunctionPointer<WindowState>(
                    NativeLibrary.GetExport(windowLibrary, "vroom_window_is_fullscreen")
                );
                Marshal.GetDelegateForFunctionPointer<WindowAttach>(
                    NativeLibrary.GetExport(windowLibrary, "vroom_window_attach")
                )();
            }
            return token;
        });

    public Task UpdateAsync(string id, NativeVideoBounds bounds) =>
        MainThread.InvokeOnMainThreadAsync(() =>
        {
            if (surfaces.TryGetValue(id, out var token))
                vroom_video_update(token, bounds.Left, bounds.Top, bounds.Width, bounds.Height, bounds.Visible ? 1 : 0);
        });

    public Task DestroyAsync(string id) =>
        MainThread.InvokeOnMainThreadAsync(() =>
        {
            if (!surfaces.Remove(id, out var token))
                return;
            log.Write(
                "native.video.presentation",
                $"session={id} frames={vroom_video_frames(token)} transport=IOSurface renderer=Metal"
            );
            vroom_video_destroy(token);
        });

    public Task<bool> FullscreenAsync(bool? enabled) =>
        MainThread.InvokeOnMainThreadAsync(() =>
        {
            var next =
                setFullscreen?.Invoke(
                    enabled is { } value
                        ? value
                            ? 1
                            : 0
                        : -1
                ) == 1;
            client?.SendRawMessage(System.Text.Json.JsonSerializer.Serialize(new { nativeFullscreen = next }));
            return next;
        });

    public void Dispose()
    {
        foreach (var token in surfaces.Values)
            vroom_video_destroy(token);
        surfaces.Clear();
        // AppKit's Objective-C classes stay loaded until process exit.
    }

    [DllImport("__Internal")]
    private static extern long vroom_video_create(nint browser);

    [DllImport("__Internal")]
    private static extern void vroom_video_update(
        long token,
        double left,
        double top,
        double width,
        double height,
        int visible
    );

    [DllImport("__Internal")]
    private static extern ulong vroom_video_frames(long token);

    [DllImport("__Internal")]
    private static extern void vroom_video_destroy(long token);
}
