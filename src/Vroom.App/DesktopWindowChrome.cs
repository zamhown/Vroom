using Microsoft.Maui.Platform;

namespace Vroom.App;

internal static class DesktopWindowChrome
{
    public static void Attach(Window window)
    {
#if WINDOWS || MACCATALYST
        // Keep the window title, OS caption buttons and native drag region on
        // the same opaque surface as the workspace, without covering web tabs.
        var titleBar = new TitleBar { HeightRequest = 32, ForegroundColor = SpectrumColors.ContentNeutral };
        titleBar.SetBinding(
            VisualElement.BackgroundColorProperty,
            new Binding(nameof(VisualElement.BackgroundColor), source: window.Page)
        );
        titleBar.SetBinding(TitleBar.TitleProperty, new Binding(nameof(Window.Title), source: window));
        window.TitleBar = titleBar;

        window.HandlerChanged += (_, _) => ApplyNativeAppearance(window);
        window.Created += (_, _) => ApplyNativeAppearance(window);
#if WINDOWS
        window.Activated += (_, _) => ApplyNativeAppearance(window);
        window.Deactivated += (_, _) => ApplyNativeAppearance(window);
#elif MACCATALYST
        // Keep Catalyst's titlebar stable while its scene changes Spaces/focus.
        MacWindowPlacement.Attach(window);
#endif
        titleBar.PropertyChanged += (_, args) =>
        {
            if (args.PropertyName == nameof(VisualElement.BackgroundColor))
                ApplyNativeAppearance(window);
        };
#endif
    }

#if WINDOWS || MACCATALYST
    private static void ApplyNativeAppearance(Window window)
    {
        var background = (window.TitleBar as TitleBar)?.BackgroundColor ?? SpectrumColors.Base;
#if WINDOWS
        if (window.Handler?.PlatformView is not Microsoft.UI.Xaml.Window nativeWindow)
            return;

        // Mica depends on the desktop wallpaper and focus. Use an opaque base
        // so even transparent caption buttons match the web canvas exactly.
        nativeWindow.SystemBackdrop = null;
        var brush = new Microsoft.UI.Xaml.Media.SolidColorBrush(background.ToWindowsColor());
        if (nativeWindow.Content is Microsoft.UI.Xaml.Controls.Panel panel)
            panel.Background = brush;
        else if (nativeWindow.Content is Microsoft.UI.Xaml.Controls.Control control)
            control.Background = brush;

        if (!Microsoft.UI.Windowing.AppWindowTitleBar.IsCustomizationSupported())
            return;

        var caption = nativeWindow.AppWindow.TitleBar;
        caption.BackgroundColor = background.ToWindowsColor();
        caption.InactiveBackgroundColor = background.ToWindowsColor();
        caption.ButtonBackgroundColor = background.ToWindowsColor();
        caption.ButtonInactiveBackgroundColor = background.ToWindowsColor();
        caption.ForegroundColor = SpectrumColors.ContentNeutral.ToWindowsColor();
        caption.ButtonForegroundColor = SpectrumColors.ContentNeutral.ToWindowsColor();
        caption.InactiveForegroundColor = SpectrumColors.ContentSubdued.ToWindowsColor();
        caption.ButtonInactiveForegroundColor = SpectrumColors.ContentSubdued.ToWindowsColor();
#elif MACCATALYST
        if (window.Handler?.PlatformView is not UIKit.UIWindow nativeWindow)
            return;

        nativeWindow.BackgroundColor = background.ToPlatform();
        if (nativeWindow.RootViewController?.View is { } root)
            root.BackgroundColor = background.ToPlatform();

        if (nativeWindow.WindowScene?.Titlebar is { } caption)
        {
            // Public Catalyst API keeps the traffic lights and removes the
            // native title, toolbar material and separator above our drag area.
            caption.TitleVisibility = UIKit.UITitlebarTitleVisibility.Hidden;
            caption.Toolbar = null;
            // The minimum Mac Catalyst version (17) runs on macOS 14, where the separator style exists.
#pragma warning disable CA1416
            caption.SeparatorStyle = UIKit.UITitlebarSeparatorStyle.None;
#pragma warning restore CA1416
        }
#endif
    }
#endif
}
