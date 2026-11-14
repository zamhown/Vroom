using Microsoft.Extensions.Logging;
using Vroom.Core;
using Vroom.Core.Application;

namespace Vroom.App;

public static class MauiProgram
{
    public static MauiApp CreateMauiApp()
    {
#if WINDOWS
        Environment.SetEnvironmentVariable(
            "WEBVIEW2_USER_DATA_FOLDER",
            Environment.GetEnvironmentVariable("VROOM_WEBVIEW_DATA")
                ?? Path.Combine(FileSystem.AppDataDirectory, "WebView2")
        );
#endif
        var builder = MauiApp.CreateBuilder().UseMauiApp<App>();
        builder.Services.AddVroom(
            Environment.GetEnvironmentVariable("VROOM_DATA") ?? Path.Combine(FileSystem.AppDataDirectory, "catalog"),
            allowSourceBrowser: true,
            allowExternalPlayers: true
        );
        builder.Services.AddSingleton<MainPage>();
        builder.Services.AddSingleton<NativeVideoSurface>();
        builder.Services.AddSingleton<Vroom.Core.Media.INativeVideoSurface>(services =>
            services.GetRequiredService<NativeVideoSurface>()
        );
        builder.Services.AddSingleton<IPlatformActions, NativePlatformActions>();
        builder.Services.AddSingleton<ISecretStore, NativeSecretStore>();
#if DEBUG
        builder.Logging.AddDebug();
#endif
        var app = builder.Build();
        var diagnostics = app.Services.GetRequiredService<LocalDiagnostics>();
        diagnostics.ObserveProcess();
#if WINDOWS
        Microsoft.UI.Xaml.Application.Current.UnhandledException += (_, e) =>
            diagnostics.Error("native.unhandled", e.Exception);
#endif
        return app;
    }
}
