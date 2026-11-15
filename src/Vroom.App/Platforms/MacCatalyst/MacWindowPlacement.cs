using System.Runtime.InteropServices;

namespace Vroom.App;

internal static class MacWindowPlacement
{
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate int CenterWindow([MarshalAs(UnmanagedType.LPUTF8Str)] string title);

    private static readonly Lazy<CenterWindow> center = new(() =>
    {
        var library = NativeLibrary.Load(
            Path.GetFullPath(
                Path.Combine(AppContext.BaseDirectory, "..", "Resources", "runtime", "host", "libvroom-window.dylib")
            )
        );
        return Marshal.GetDelegateForFunctionPointer<CenterWindow>(
            NativeLibrary.GetExport(library, "vroom_window_center")
        );
    });

    internal static void Attach(Window window)
    {
        var placed = false;
        var placing = false;
        var closed = false;
        window.Destroying += (_, _) => closed = true;
        async void Place(object? sender, EventArgs args)
        {
            if (placed || placing || closed)
                return;
            placing = true;
            try
            {
                // UIKit activation can precede AppKit's key-window transition.
                // Place once; switching Spaces must never move a user's window.
                for (var attempt = 0; attempt < 20 && !closed && !placed; attempt++)
                {
                    placed = center.Value(window.Title ?? "Vroom") == 1;
                    if (!placed)
                        await Task.Delay(50);
                }
            }
            finally
            {
                placing = false;
            }
        }
        window.Created += Place;
        window.Activated += Place;
    }
}
