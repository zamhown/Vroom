#if WINDOWS
using System.Runtime.InteropServices;
using Vroom.Core.Application;
using Microsoft.UI.Windowing;
using Microsoft.Maui.Platform;
using Microsoft.Web.WebView2.Core;

namespace Vroom.App;

/// <summary>Owned OS windows for the shared React dialogs. The opener retains their state.</summary>
internal sealed class WindowsDialogWindows(CoreWebView2Environment environment, nint root, LocalDiagnostics log)
    : IDisposable
{
    private readonly Dictionary<nint, Entry> windows = [];
    private readonly Microsoft.UI.Dispatching.DispatcherQueue queue =
        Microsoft.UI.Dispatching.DispatcherQueue.GetForCurrentThread();
    private bool disposed;

    public void Attach(CoreWebView2 web, nint owner)
    {
        web.NewWindowRequested += (_, e) => Open(owner, e);
        // A reload invalidates all React portals owned by this document.
        web.NavigationStarting += (_, _) => CloseChildren(owner);
        web.ProcessFailed += (_, _) => CloseChildren(owner);
    }

    private async void Open(nint owner, CoreWebView2NewWindowRequestedEventArgs request)
    {
        request.Handled = true;
        if (disposed || !DialogWindowRequest.TryParse(request.Uri, out var options))
            return;
        using var deferral = request.GetDeferral();
        Entry? entry = null;
        try
        {
            if (owner != root && !windows.ContainsKey(owner))
            {
                log.Write("dialog.rejected", $"{options.Id}: owner no longer exists.");
                return;
            }
            // A disabled owner cannot initiate another competing exclusive dialog.
            if (windows.Values.FirstOrDefault(w => w.Owner == owner && w.Exclusive) is { } blocking)
            {
                log.Write(
                    "dialog.rejected",
                    $"{options.Id}: owner already has an exclusive dialog ({blocking.Handle})."
                );
                blocking.Window.Show();
                SetForegroundWindow(blocking.Handle);
                return;
            }
            var presenter = OverlappedPresenter.Create();
            presenter.IsMinimizable = false;
            presenter.IsMaximizable = true;
            var window = AppWindow.Create(presenter, Microsoft.UI.Win32Interop.GetWindowIdFromWindow(owner));
            var handle = Microsoft.UI.Win32Interop.GetWindowFromWindowId(window.Id);
            entry = new Entry(window, handle, owner, options.Exclusive);
            windows.Add(handle, entry);
            window.IsShownInSwitchers = !options.Exclusive;
            window.Title = "Vroom";
            var caption = window.TitleBar;
            caption.BackgroundColor =
                caption.InactiveBackgroundColor =
                caption.ButtonBackgroundColor =
                caption.ButtonInactiveBackgroundColor =
                    SpectrumColors.Base.ToWindowsColor();
            caption.ForegroundColor = caption.ButtonForegroundColor = SpectrumColors.ContentNeutral.ToWindowsColor();
            caption.InactiveForegroundColor = caption.ButtonInactiveForegroundColor =
                SpectrumColors.ContentSubdued.ToWindowsColor();
            var scale = GetDpiForWindow(owner) / 96d;
            var work = DisplayArea
                .GetFromWindowId(Microsoft.UI.Win32Interop.GetWindowIdFromWindow(owner), DisplayAreaFallback.Nearest)
                .WorkArea;
            GetWindowRect(owner, out var parentBounds);
            var bounds = DialogWindowRequest.Place(
                (int)Math.Round(options.Width * scale),
                (int)Math.Round(options.Height * scale),
                parentBounds.Left,
                parentBounds.Top,
                parentBounds.Right - parentBounds.Left,
                parentBounds.Bottom - parentBounds.Top,
                work.X,
                work.Y,
                work.Width,
                work.Height
            );
            window.MoveAndResize(new Windows.Graphics.RectInt32(bounds.X, bounds.Y, bounds.Width, bounds.Height));
            // Ownership is established by AppWindow.Create, before activating modal input blocking.
            presenter.IsModal = options.Exclusive;
            var current = entry;
            window.Closing += (_, e) =>
            {
                e.Cancel = true;
                RequestClose(current);
            };
            window.Destroying += (_, _) => Release(current);
            window.Changed += (_, _) =>
            {
                UpdateBounds(current);
                if (current.Ready)
                    QueueFit(current);
            };
            _ = CloseIfUnready(current);
            current.Controller = await environment.CreateCoreWebView2ControllerAsync(
                CoreWebView2ControllerWindowReference.CreateFromWindowHandle((ulong)handle)
            );
            if (disposed || !windows.ContainsKey(handle))
            {
                current.Controller.Close();
                return;
            }
            var web = current.Web = current.Controller.CoreWebView2;
            current.Controller.ZoomFactorChanged += (_, _) => QueueFit(current);
            web.Settings.IsStatusBarEnabled = false;
            web.SetVirtualHostNameToFolderMapping(
                "0.0.0.1",
                Path.Combine(AppContext.BaseDirectory, "wwwroot"),
                CoreWebView2HostResourceAccessKind.DenyCors
            );
            web.NavigationStarting += (_, e) =>
            {
                if (!DialogWindowRequest.IsDocument(e.Uri))
                    e.Cancel = true;
            };
            web.DocumentTitleChanged += (_, _) => window.Title = web.DocumentTitle;
            web.WindowCloseRequested += (_, _) => Close(current);
            web.ProcessFailed += (_, e) =>
            {
                log.Error("dialog.browser", new IOException(e.ProcessFailedKind.ToString()));
                Close(current);
            };
            web.WebMessageReceived += (_, e) =>
            {
                if (!DialogWindowRequest.IsDocument(e.Source))
                    return;
                try
                {
                    var message = e.TryGetWebMessageAsString();
                    const string prefix = "dialog-size|";
                    if (
                        message.StartsWith(prefix, StringComparison.Ordinal)
                        && int.TryParse(message.AsSpan(prefix.Length), out var contentHeight)
                        && contentHeight >= 180
                    )
                    {
                        current.ContentHeight = contentHeight;
                        QueueFit(current);
                    }
                }
                catch (Exception ex)
                {
                    log.Error("dialog.message", ex);
                }
            };
            Attach(web, handle);
            current.Controller.DefaultBackgroundColor = SpectrumColors.Base.ToWindowsColor();
            UpdateBounds(current);
            current.Controller.IsVisible = true;
            request.NewWindow = web;
            // Never navigate this controller ourselves: NewWindow must preserve the opener relationship.
            log.Write("dialog.open", $"{options.Id} mode={(options.Exclusive ? "exclusive" : "modeless")}");
        }
        catch (Exception ex)
        {
            log.Error("dialog.open", ex);
            if (entry is not null)
                Close(entry);
        }
        finally
        {
            try
            {
                deferral.Complete();
            }
            catch (Exception ex)
            {
                log.Error("dialog.deferral", ex);
                if (entry is not null)
                    Close(entry);
            }
        }
    }

    private async Task CloseIfUnready(Entry entry)
    {
        await Task.Delay(TimeSpan.FromSeconds(15));
        if (!entry.Ready && windows.TryGetValue(entry.Handle, out var live) && ReferenceEquals(entry, live))
        {
            log.Error("dialog.ready", new TimeoutException("Dialog document did not become ready."));
            Close(entry);
        }
    }

    private async void RequestClose(Entry entry)
    {
        try
        {
            if (entry.Web is null || !entry.Ready)
            {
                Close(entry);
                return;
            }
            // React decides whether cancellation is currently allowed (e.g. a commit is in flight).
            await entry.Web.ExecuteScriptAsync("window.dispatchEvent(new Event('vroom-window-close'))");
        }
        catch (Exception ex)
        {
            log.Error("dialog.close", ex);
            Close(entry);
        }
    }

    private void UpdateBounds(Entry entry)
    {
        if (entry.Controller is null)
            return;
        try
        {
            GetClientRect(entry.Handle, out var rect);
            entry.Controller.Bounds = new Windows.Foundation.Rect(
                0,
                0,
                Math.Max(1, rect.Right),
                Math.Max(1, rect.Bottom)
            );
            entry.Controller.NotifyParentWindowPositionChanged();
        }
        catch (Exception ex)
        {
            log.Error("dialog.bounds", ex);
        }
    }

    private void QueueFit(Entry entry)
    {
        if (entry.FitQueued || entry.ContentHeight is null || disposed)
            return;
        entry.FitQueued = true;
        // Coalesce layout messages and never resize recursively inside an AppWindow Changed callback.
        if (
            !queue.TryEnqueue(() =>
            {
                entry.FitQueued = false;
                if (disposed || !windows.TryGetValue(entry.Handle, out var live) || !ReferenceEquals(entry, live))
                    return;
                try
                {
                    FitContent(entry);
                    if (!entry.Ready)
                    {
                        entry.Ready = true;
                        entry.Window.Show();
                        SetForegroundWindow(entry.Handle);
                        entry.Controller?.MoveFocus(CoreWebView2MoveFocusReason.Programmatic);
                    }
                }
                catch (Exception ex)
                {
                    log.Error("dialog.size", ex);
                    if (!entry.Ready)
                        Close(entry);
                }
            })
        )
            entry.FitQueued = false;
    }

    private static void FitContent(Entry entry)
    {
        if (
            entry.Window.Presenter is not OverlappedPresenter presenter
            || presenter.State == OverlappedPresenterState.Minimized
        )
            return;
        GetWindowRect(entry.Handle, out var outer);
        GetClientRect(entry.Handle, out var inner);
        var work = DisplayArea.GetFromWindowId(entry.Window.Id, DisplayAreaFallback.Nearest).WorkArea;
        var scale = GetDpiForWindow(entry.Handle) / 96d * (entry.Controller?.ZoomFactor ?? 1);
        var chromeHeight = outer.Bottom - outer.Top - inner.Bottom;
        // Report capacity, not the temporarily undersized viewport. The portal can then keep
        // scrollbars hidden throughout an asynchronous auto-fit without a timeout/debounce.
        var maxHeight = Math.Max(
            1,
            (presenter.State == OverlappedPresenterState.Maximized ? inner.Bottom : work.Height - chromeHeight) / scale
        );
        if (entry.SizeLimit != maxHeight)
        {
            entry.Web!.PostWebMessageAsJson(
                System.Text.Json.JsonSerializer.Serialize(new { type = "dialog-size-limit", maxHeight })
            );
            entry.SizeLimit = maxHeight;
        }
        if (presenter.State != OverlappedPresenterState.Restored)
            return;
        var rect = DialogWindowRequest.ResizeToContent(
            entry.ContentHeight!.Value,
            scale,
            chromeHeight,
            outer.Left,
            outer.Top,
            outer.Right - outer.Left,
            work.X,
            work.Y,
            work.Width,
            work.Height
        );
        if (!entry.Ready)
        {
            GetWindowRect(entry.Owner, out var owner);
            rect = DialogWindowRequest.Place(
                rect.Width,
                rect.Height,
                owner.Left,
                owner.Top,
                owner.Right - owner.Left,
                owner.Bottom - owner.Top,
                work.X,
                work.Y,
                work.Width,
                work.Height
            );
        }
        if (
            rect.X != outer.Left
            || rect.Y != outer.Top
            || rect.Width != outer.Right - outer.Left
            || rect.Height != outer.Bottom - outer.Top
        )
            entry.Window.MoveAndResize(new Windows.Graphics.RectInt32(rect.X, rect.Y, rect.Width, rect.Height));
    }

    private void CloseChildren(nint owner)
    {
        foreach (var entry in windows.Values.Where(w => w.Owner == owner).ToArray())
            Close(entry);
    }

    private void Close(Entry entry)
    {
        if (!windows.TryGetValue(entry.Handle, out var live) || !ReferenceEquals(entry, live))
            return;
        CloseChildren(entry.Handle);
        // Release modal ownership before destroying the HWND, including initialization/crash failures.
        if (entry.Window.Presenter is OverlappedPresenter presenter)
            presenter.IsModal = false;
        var restoreFocus = GetForegroundWindow() == entry.Handle;
        entry.Window.Destroy();
        if (restoreFocus)
            SetForegroundWindow(entry.Owner);
    }

    private void Release(Entry entry)
    {
        if (!windows.Remove(entry.Handle))
            return;
        CloseChildren(entry.Handle);
        entry.Controller?.Close();
        entry.Controller = null;
        entry.Web = null;
    }

    public void Dispose()
    {
        if (disposed)
            return;
        disposed = true;
        CloseChildren(root);
    }

    private sealed class Entry(AppWindow window, nint handle, nint owner, bool exclusive)
    {
        public AppWindow Window { get; } = window;
        public nint Handle { get; } = handle;
        public nint Owner { get; } = owner;
        public bool Exclusive { get; } = exclusive;
        public bool Ready { get; set; }
        public bool FitQueued { get; set; }
        public int? ContentHeight { get; set; }
        public double? SizeLimit { get; set; }
        public CoreWebView2Controller? Controller { get; set; }
        public CoreWebView2? Web { get; set; }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int Left,
            Top,
            Right,
            Bottom;
    }

    [DllImport("user32.dll")]
    private static extern bool GetClientRect(nint hwnd, out Rect rect);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(nint hwnd, out Rect rect);

    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(nint hwnd);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(nint hwnd);

    [DllImport("user32.dll")]
    private static extern nint GetForegroundWindow();
}
#endif
