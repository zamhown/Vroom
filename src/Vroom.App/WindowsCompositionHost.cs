#if WINDOWS
using System.ComponentModel;
using System.Runtime.InteropServices;
using Vroom.Core.Application;
using Microsoft.Web.WebView2.Core;
using WinRT;
using Windows.UI.Composition;
using Windows.UI.Composition.Desktop;
using WinPoint = Windows.Foundation.Point;
using WinRect = Windows.Foundation.Rect;

namespace Vroom.App;

/// <summary>GPU-composed web UI above decoder child windows. No video readback or HTML region clipping.</summary>
public sealed class WindowsCompositionHost : IDisposable
{
    private readonly ContentView host;
    private readonly LocalDiagnostics log;
    private readonly Action<string> receive;
    private readonly WindowProcedure procedure;
    private nint previousProcedure;
    private Microsoft.UI.Xaml.FrameworkElement? element;
    private CoreWebView2CompositionController? controller;

    // Keep the WinRT event source rooted for as long as native callbacks can run.
    private CoreWebView2? web;
    private WindowsDialogWindows? dialogs;
    private nint automationProvider;
    private BrowserDropTarget? dropTarget;
    private bool oleInitialized;
    private Compositor? compositor;
    private DesktopWindowTarget? target;
    private ContainerVisual? visual;
    private Windows.System.DispatcherQueueController? dispatcher;
    private WinRect lastBounds;
    private bool tracking,
        disposed,
        focusQueued;
    public nint Handle { get; private set; }
    public double Scale => element?.XamlRoot?.RasterizationScale ?? 1;

    public WindowsCompositionHost(ContentView host, LocalDiagnostics log, Action<string> receive)
    {
        this.host = host;
        this.log = log;
        this.receive = receive;
        procedure = WindowMessage;
    }

    public async Task InitializeAsync()
    {
        element = (Microsoft.UI.Xaml.FrameworkElement)host.Handler!.PlatformView!;
        var window = (Microsoft.UI.Xaml.Window)Application.Current!.Windows[0].Handler!.PlatformView!;
        Handle = CreateWindowExW(
            0x00200000,
            "STATIC",
            "",
            0x50000100,
            0,
            0,
            1,
            1,
            WinRT.Interop.WindowNative.GetWindowHandle(window),
            0,
            0,
            0
        );
        if (Handle == 0)
            throw new Win32Exception(Marshal.GetLastWin32Error());
        previousProcedure = SetWindowLongPtrW(Handle, -4, Marshal.GetFunctionPointerForDelegate(procedure));
        if (previousProcedure == 0)
            throw new Win32Exception(Marshal.GetLastWin32Error());
        if (Windows.System.DispatcherQueue.GetForCurrentThread() is null)
        {
            Marshal.ThrowExceptionForHR(
                CreateDispatcherQueueController(
                    new DispatcherOptions
                    {
                        Size = 12,
                        ThreadType = 2,
                        ApartmentType = 2,
                    },
                    out var queue
                )
            );
            try
            {
                dispatcher = MarshalInspectable<Windows.System.DispatcherQueueController>.FromAbi(queue);
            }
            finally
            {
                Marshal.Release(queue);
            }
        }
        compositor = new Compositor();
        compositor.As<ICompositorDesktopInterop>().CreateDesktopWindowTarget(Handle, true, out var rawTarget);
        try
        {
            target = MarshalInspectable<DesktopWindowTarget>.FromAbi(rawTarget);
        }
        finally
        {
            Marshal.Release(rawTarget);
        }
        visual = compositor.CreateContainerVisual();
        target.Root = visual;
        var environment = await CoreWebView2Environment.CreateWithOptionsAsync(
            null,
            Environment.GetEnvironmentVariable("WEBVIEW2_USER_DATA_FOLDER"),
            new CoreWebView2EnvironmentOptions()
        );
        if (disposed)
            return;
        controller = await environment.CreateCoreWebView2CompositionControllerAsync(
            CoreWebView2ControllerWindowReference.CreateFromWindowHandle((ulong)Handle)
        );
        if (disposed)
        {
            controller.Close();
            return;
        }
        controller.RootVisualTarget = visual;
        controller.DefaultBackgroundColor = Windows.UI.Color.FromArgb(0, 0, 0, 0);
        controller.ShouldDetectMonitorScaleChanges = false;
        controller.BoundsMode = CoreWebView2BoundsMode.UseRawPixels;
        controller.CursorChanged += (_, _) => UpdateCursor();
        controller.MoveFocusRequested += (_, e) =>
        {
            e.Handled = true;
            QueueFocus(e.Reason);
        };
        controller.As<ICompositionControllerInterop>().GetAutomationProvider(out var provider);
        try
        {
            var providerId = new Guid("D6DD68D1-86FD-4332-8666-9ABEDEA2D24C");
            Marshal.ThrowExceptionForHR(Marshal.QueryInterface(provider, in providerId, out automationProvider));
        }
        finally
        {
            Marshal.Release(provider);
        }
        Marshal.ThrowExceptionForHR(OleInitialize(0));
        oleInitialized = true;
        dropTarget = new BrowserDropTarget(this, controller.As<ICompositionDropInterop>());
        Marshal.ThrowExceptionForHR(RegisterDragDrop(Handle, dropTarget));
        web = controller.CoreWebView2;
        web.Settings.IsStatusBarEnabled = false;
        web.WebMessageReceived += (_, e) =>
        {
            if (!IsLocal(e.Source))
                return;
            try
            {
                var message = Uri.UnescapeDataString(e.TryGetWebMessageAsString());
                if (message.StartsWith("__RawMessage|", StringComparison.Ordinal))
                    receive(message[13..]);
            }
            catch (Exception ex)
            {
                log.Error("composition.message", ex);
            }
        };
        web.NavigationStarting += (_, e) =>
        {
            if (!IsLocal(e.Uri))
                e.Cancel = true;
        };
        dialogs = new WindowsDialogWindows(environment, WinRT.Interop.WindowNative.GetWindowHandle(window), log);
        dialogs.Attach(web, WinRT.Interop.WindowNative.GetWindowHandle(window));
        web.ProcessFailed += (_, e) =>
            log.Error("composition.browser", new IOException(e.ProcessFailedKind.ToString()));
        web.SetVirtualHostNameToFolderMapping(
            "0.0.0.1",
            Path.Combine(AppContext.BaseDirectory, "wwwroot"),
            CoreWebView2HostResourceAccessKind.DenyCors
        );
        await web.AddScriptToExecuteOnDocumentCreatedAsync(
            "window.__vroomComposition = true; window.__vroomWindows = true;"
        );
        if (disposed)
            return;
        element.LayoutUpdated += LayoutUpdated;
        UpdateBounds();
        controller.IsVisible = true;
        log.Write("composition.ready", "Windows GPU composition; decoder windows below the web visual.");
        web.Navigate("https://0.0.0.1/index.html");
    }

    private static bool IsLocal(string value) =>
        Uri.TryCreate(value, UriKind.Absolute, out var uri)
        && uri.Scheme == "https"
        && uri.Host == "0.0.0.1"
        && uri.IsDefaultPort;

    public void SendRawMessage(string value)
    {
        if (!disposed)
            web?.PostWebMessageAsString(Uri.EscapeDataString(value));
    }

    private void LayoutUpdated(object? sender, object e) => UpdateBounds();

    private void QueueFocus(CoreWebView2MoveFocusReason reason)
    {
        if (focusQueued || disposed)
            return;
        focusQueued = true;
        // Focus changes may synchronously send WM_SETFOCUS / MoveFocusRequested again.
        host.Dispatcher.Dispatch(() =>
        {
            try
            {
                if (!disposed)
                    controller?.MoveFocus(reason);
            }
            catch (Exception ex)
            {
                log.Error("composition.focus", ex);
            }
            finally
            {
                focusQueued = false;
            }
        });
    }

    private void UpdateBounds()
    {
        if (disposed || controller is null || element?.XamlRoot is null)
            return;
        var window = (Microsoft.UI.Xaml.Window)Application.Current!.Windows[0].Handler!.PlatformView!;
        var offset = element.TransformToVisual(window.Content).TransformPoint(new WinPoint());
        var bounds = new WinRect(
            Math.Round(offset.X * Scale),
            Math.Round(offset.Y * Scale),
            Math.Round(element.ActualWidth * Scale),
            Math.Round(element.ActualHeight * Scale)
        );
        if (bounds == lastBounds && controller.RasterizationScale == Scale)
            return;
        lastBounds = bounds;
        SetWindowPos(Handle, 0, (int)bounds.X, (int)bounds.Y, (int)bounds.Width, (int)bounds.Height, 0x0010 | 0x0040);
        controller.RasterizationScale = Scale;
        controller.Bounds = new WinRect(0, 0, bounds.Width, bounds.Height);
        if (visual is not null)
            visual.Size = new System.Numerics.Vector2((float)bounds.Width, (float)bounds.Height);
        controller.NotifyParentWindowPositionChanged();
    }

    private nint WindowMessage(nint hwnd, uint message, nuint wParam, nint lParam)
    {
        try
        {
            if (controller is not null && !disposed)
            {
                if (message == 0x003D && lParam == -25 && automationProvider != 0)
                    return UiaReturnRawElementProvider(hwnd, wParam, lParam, automationProvider);
                if (message == 0x0020)
                {
                    UpdateCursor();
                    return 1;
                }
                if (message == 0x02A3)
                {
                    tracking = false;
                    controller.SendMouseInput(CoreWebView2MouseEventKind.Leave, 0, 0, new WinPoint());
                    return 0;
                }
                if (message is >= 0x0200 and <= 0x020E)
                {
                    var point = new NativePoint
                    {
                        X = (short)((long)lParam & 0xffff),
                        Y = (short)(((long)lParam >> 16) & 0xffff),
                    };
                    var data = 0u;
                    if (message is 0x020A or 0x020E)
                    {
                        ScreenToClient(hwnd, ref point);
                        data = unchecked((uint)(short)(wParam >> 16));
                    }
                    else if (message is >= 0x020B and <= 0x020D)
                        data = (uint)(wParam >> 16);
                    if (message is 0x0201 or 0x0204 or 0x0207 or 0x020B or 0x0203 or 0x0206 or 0x0209 or 0x020D)
                    {
                        SetCapture(hwnd);
                        controller.MoveFocus(CoreWebView2MoveFocusReason.Programmatic);
                    }
                    if (message == 0x0200 && !tracking)
                    {
                        var track = new TrackMouse
                        {
                            Size = (uint)Marshal.SizeOf<TrackMouse>(),
                            Flags = 2,
                            Window = hwnd,
                        };
                        tracking = TrackMouseEvent(ref track);
                    }
                    controller.SendMouseInput(
                        (CoreWebView2MouseEventKind)message,
                        (CoreWebView2MouseEventVirtualKeys)((uint)wParam & 0xffff),
                        data,
                        new WinPoint(point.X, point.Y)
                    );
                    if (message is 0x0202 or 0x0205 or 0x0208 or 0x020C && ((uint)wParam & 0x73) == 0)
                        ReleaseCapture();
                    return 0;
                }
            }
        }
        catch (Exception ex)
        {
            log.Error("composition.input", ex);
        }
        return CallWindowProcW(previousProcedure, hwnd, message, wParam, lParam);
    }

    private void UpdateCursor()
    {
        var type = controller?.Cursor?.Type;
        var id = type switch
        {
            Windows.UI.Core.CoreCursorType.Hand => 32649,
            Windows.UI.Core.CoreCursorType.IBeam => 32513,
            Windows.UI.Core.CoreCursorType.Cross => 32515,
            Windows.UI.Core.CoreCursorType.Wait => 32514,
            Windows.UI.Core.CoreCursorType.SizeAll => 32646,
            Windows.UI.Core.CoreCursorType.SizeNorthSouth => 32645,
            Windows.UI.Core.CoreCursorType.SizeWestEast => 32644,
            Windows.UI.Core.CoreCursorType.UniversalNo => 32648,
            Windows.UI.Core.CoreCursorType.SizeNortheastSouthwest => 32643,
            Windows.UI.Core.CoreCursorType.SizeNorthwestSoutheast => 32642,
            _ => 32512,
        };
        SetCursor(LoadCursorW(0, id));
    }

    public void Dispose()
    {
        if (disposed)
            return;
        disposed = true;
        dialogs?.Dispose();
        dialogs = null;
        if (element is not null)
            element.LayoutUpdated -= LayoutUpdated;
        if (dropTarget is not null)
        {
            RevokeDragDrop(Handle);
            dropTarget = null;
        }
        if (automationProvider != 0)
        {
            Marshal.Release(automationProvider);
            automationProvider = 0;
        }
        if (controller is not null)
        {
            controller.RootVisualTarget = null;
            controller.Close();
            controller = null;
        }
        web = null;
        if (target is not null)
            target.Root = null;
        visual?.Dispose();
        target?.Dispose();
        compositor?.Dispose();
        visual = null;
        target = null;
        compositor = null;
        if (Handle != 0)
        {
            if (previousProcedure != 0)
                SetWindowLongPtrW(Handle, -4, previousProcedure);
            DestroyWindow(Handle);
            Handle = 0;
        }
        if (dispatcher is not null)
        {
            _ = dispatcher.ShutdownQueueAsync();
            dispatcher = null;
        }
        if (oleInitialized)
        {
            OleUninitialize();
            oleInitialized = false;
        }
    }

    [ComImport, Guid("29E691FA-4567-4DCA-B319-D0F207EB6807"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface ICompositorDesktopInterop
    {
        void CreateDesktopWindowTarget(nint hwnd, [MarshalAs(UnmanagedType.Bool)] bool topmost, out nint target);
    }

    [ComImport, Guid("8e9922ce-9c80-42e6-bad7-fcebf291a495"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface ICompositionControllerInterop
    {
        void GetAutomationProvider(out nint provider);
    }

    [ComImport, Guid("6b47bbe1-2480-4ff8-a5ba-69c2f0b868b3"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface ICompositionDropInterop
    {
        void GetAutomationProvider(out nint provider);
        void GetRootVisualTarget(out nint target);
        void SetRootVisualTarget(nint target);
        void DragEnter(nint data, uint keys, NativePoint point, out uint effect);
        void DragLeave();
        void DragOver(uint keys, NativePoint point, out uint effect);
        void Drop(nint data, uint keys, NativePoint point, out uint effect);
    }

    [
        ComVisible(true),
        Guid("00000122-0000-0000-C000-000000000046"),
        InterfaceType(ComInterfaceType.InterfaceIsIUnknown)
    ]
    private interface IDropTarget
    {
        [PreserveSig]
        int DragEnter(nint data, uint keys, NativePoint point, ref uint effect);

        [PreserveSig]
        int DragOver(uint keys, NativePoint point, ref uint effect);

        [PreserveSig]
        int DragLeave();

        [PreserveSig]
        int Drop(nint data, uint keys, NativePoint point, ref uint effect);
    }

    [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
    private sealed class BrowserDropTarget(WindowsCompositionHost owner, ICompositionDropInterop browser) : IDropTarget
    {
        private int Forward(nint data, uint keys, NativePoint point, ref uint effect, int operation)
        {
            try
            {
                if (owner.disposed)
                {
                    effect = 0;
                    return 0;
                }
                ScreenToClient(owner.Handle, ref point);
                uint result;
                if (operation == 0)
                    browser.DragEnter(data, keys, point, out result);
                else if (operation == 1)
                    browser.DragOver(keys, point, out result);
                else
                    browser.Drop(data, keys, point, out result);
                effect &= result;
                return 0;
            }
            catch (Exception ex)
            {
                owner.log.Error("composition.drop", ex);
                effect = 0;
                return Marshal.GetHRForException(ex);
            }
        }

        public int DragEnter(nint data, uint keys, NativePoint point, ref uint effect) =>
            Forward(data, keys, point, ref effect, 0);

        public int DragOver(uint keys, NativePoint point, ref uint effect) => Forward(0, keys, point, ref effect, 1);

        public int Drop(nint data, uint keys, NativePoint point, ref uint effect) =>
            Forward(data, keys, point, ref effect, 2);

        public int DragLeave()
        {
            try
            {
                browser.DragLeave();
                return 0;
            }
            catch (Exception ex)
            {
                owner.log.Error("composition.drop", ex);
                return Marshal.GetHRForException(ex);
            }
        }
    }

    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate nint WindowProcedure(nint hwnd, uint message, nuint wParam, nint lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct NativePoint
    {
        public int X,
            Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct TrackMouse
    {
        public uint Size,
            Flags;
        public nint Window;
        public uint HoverTime;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct DispatcherOptions
    {
        public int Size,
            ThreadType,
            ApartmentType;
    }

    [DllImport("CoreMessaging.dll")]
    private static extern int CreateDispatcherQueueController(DispatcherOptions options, out nint dispatcher);

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

    [DllImport("user32.dll", SetLastError = true)]
    private static extern nint SetWindowLongPtrW(nint hwnd, int index, nint value);

    [DllImport("user32.dll")]
    private static extern nint CallWindowProcW(nint previous, nint hwnd, uint message, nuint wParam, nint lParam);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(nint hwnd, nint after, int x, int y, int width, int height, uint flags);

    [DllImport("user32.dll")]
    private static extern bool DestroyWindow(nint hwnd);

    [DllImport("user32.dll")]
    private static extern bool ScreenToClient(nint hwnd, ref NativePoint point);

    [DllImport("user32.dll")]
    private static extern nint SetCapture(nint hwnd);

    [DllImport("user32.dll")]
    private static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    private static extern bool TrackMouseEvent(ref TrackMouse track);

    [DllImport("user32.dll")]
    private static extern nint SetCursor(nint cursor);

    [DllImport("user32.dll")]
    private static extern nint LoadCursorW(nint instance, nint name);

    [DllImport("UIAutomationCore.dll")]
    private static extern nint UiaReturnRawElementProvider(nint hwnd, nuint wParam, nint lParam, nint provider);

    [DllImport("ole32.dll")]
    private static extern int OleInitialize(nint reserved);

    [DllImport("ole32.dll")]
    private static extern void OleUninitialize();

    [DllImport("ole32.dll")]
    private static extern int RegisterDragDrop(nint hwnd, [MarshalAs(UnmanagedType.Interface)] IDropTarget target);

    [DllImport("ole32.dll")]
    private static extern int RevokeDragDrop(nint hwnd);
}
#endif
