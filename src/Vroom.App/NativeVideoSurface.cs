using Vroom.Core.Media;
#if WINDOWS
using System.Runtime.InteropServices;
#endif

namespace Vroom.App;

/// <summary>Owns only the video child windows. Each decoder remains in its own process.</summary>
public sealed class NativeVideoSurface(Vroom.Core.Application.LocalDiagnostics diagnostics)
    : INativeVideoSurface,
        IDisposable
{
#if WINDOWS
    private WindowsCompositionHost? view;

    public void Attach(WindowsCompositionHost client)
    {
        view = client;
        var window = (Microsoft.UI.Xaml.Window)
            Application.Current!.Windows.First(w => w.Page is MainPage).Handler!.PlatformView!;
        hostWindow = window.AppWindow;
        hostWindow.Changed += WindowChanged;
        UpdateFullscreen();
    }
#else
    // Native video composition is Windows-only; other platforms use the web player.
    public void Attach(HybridWebView client) => _ = diagnostics;
#endif

    public void Dispose()
    {
#if WINDOWS
        if (hostWindow is not null)
            hostWindow.Changed -= WindowChanged;
        windowThread.Dispose();
#endif
    }

#if WINDOWS
    private Microsoft.UI.Windowing.AppWindow? hostWindow;
    private volatile bool fullscreen;
    public bool Fullscreen => fullscreen;

    private void WindowChanged(
        Microsoft.UI.Windowing.AppWindow sender,
        Microsoft.UI.Windowing.AppWindowChangedEventArgs args
    )
    {
        if (args.DidPresenterChange)
            UpdateFullscreen();
    }

    private void UpdateFullscreen()
    {
        fullscreen = hostWindow?.Presenter.Kind == Microsoft.UI.Windowing.AppWindowPresenterKind.FullScreen;
        view?.SendRawMessage(System.Text.Json.JsonSerializer.Serialize(new { nativeFullscreen = fullscreen }));
    }

    private readonly Dictionary<string, nint> windows = new();
    private readonly NativeWindowThread windowThread = new();
    public bool Embedded => true;

    public async Task<long> CreateAsync(string id)
    {
        var parent = await MainThread.InvokeOnMainThreadAsync(() =>
        {
            return view?.Handle ?? throw new InvalidOperationException("Composition host is not ready.");
        });
        return await windowThread.InvokeAsync(() =>
        {
            // The composed WebView owns input even over video; a disabled decoder parent cannot intercept it.
            var handle = CreateWindowExW(0x08000000, "STATIC", "", 0x4e000000, 0, 0, 1, 1, parent, 0, 0, 0);
            if (handle == 0)
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            windows[id] = handle;
            return handle.ToInt64();
        });
    }

    public async Task UpdateAsync(string id, NativeVideoBounds bounds)
    {
        var rectangle = await MainThread.InvokeOnMainThreadAsync(() =>
        {
            if (!bounds.Visible || bounds.Width < 1 || bounds.Height < 1 || view is null || view.Handle == 0)
                return (Visible: false, X: 0, Y: 0, Width: 0, Height: 0);
            return (
                Visible: true,
                X: (int)Math.Round(bounds.Left * bounds.Scale),
                Y: (int)Math.Round(bounds.Top * bounds.Scale),
                Width: (int)Math.Round(bounds.Width * bounds.Scale),
                Height: (int)Math.Round(bounds.Height * bounds.Scale)
            );
        });
        await windowThread.InvokeAsync(() =>
        {
            if (!windows.TryGetValue(id, out var handle))
                return false;
            if (!rectangle.Visible)
                return ShowWindow(handle, 0);
            return SetWindowPos(
                handle,
                0,
                rectangle.X,
                rectangle.Y,
                rectangle.Width,
                rectangle.Height,
                0x0010 | 0x0040 | 0x4000
            );
        });
    }

    public async Task DestroyAsync(string id) =>
        await windowThread.InvokeAsync(() =>
        {
            if (!windows.Remove(id, out var handle))
                return false;
            return DestroyWindow(handle);
        });

    public void SendInput(string id, MpvInput input) =>
        MainThread.BeginInvokeOnMainThread(() =>
        {
            try
            {
                view?.SendRawMessage(
                    System.Text.Json.JsonSerializer.Serialize(
                        new
                        {
                            nativeInput = new
                            {
                                sessionId = id,
                                kind = input.Kind,
                                key = input.Key,
                                x = input.X,
                                y = input.Y,
                            },
                        }
                    )
                );
            }
            catch (Exception ex)
            {
                diagnostics.Error("native.playback.input", ex);
            }
        });

    private bool restoreMaximized;

    public Task<bool> FullscreenAsync(bool? enabled) =>
        MainThread.InvokeOnMainThreadAsync(() =>
        {
            var window = (Microsoft.UI.Xaml.Window)
                Application.Current!.Windows.First(w => w.Page is MainPage).Handler!.PlatformView!;
            var appWindow = window.AppWindow;
            var current = appWindow.Presenter.Kind == Microsoft.UI.Windowing.AppWindowPresenterKind.FullScreen;
            var next = enabled ?? !current;
            if (next == current)
                return next;
            if (next)
                restoreMaximized =
                    appWindow.Presenter is Microsoft.UI.Windowing.OverlappedPresenter presenter
                    && presenter.State == Microsoft.UI.Windowing.OverlappedPresenterState.Maximized;
            appWindow.SetPresenter(
                next
                    ? Microsoft.UI.Windowing.AppWindowPresenterKind.FullScreen
                    : Microsoft.UI.Windowing.AppWindowPresenterKind.Default
            );
            UpdateFullscreen();
            if (!next && restoreMaximized && appWindow.Presenter is Microsoft.UI.Windowing.OverlappedPresenter restored)
                restored.Maximize();
            return next;
        });

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern nint CreateWindowExW(
        uint ex,
        string cls,
        string title,
        uint style,
        int x,
        int y,
        int width,
        int height,
        nint parent,
        nint menu,
        nint instance,
        nint param
    );

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(nint hwnd, nint after, int x, int y, int width, int height, uint flags);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(nint hwnd, int command);

    [DllImport("user32.dll")]
    private static extern bool DestroyWindow(nint hwnd);
#else
    public bool Embedded => false;

    public Task<long> CreateAsync(string id) => Task.FromResult(0L);

    public Task UpdateAsync(string id, NativeVideoBounds bounds) => Task.CompletedTask;

    public Task DestroyAsync(string id) => Task.CompletedTask;
#endif
}
