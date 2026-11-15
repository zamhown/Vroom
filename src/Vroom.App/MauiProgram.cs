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
#if MACCATALYST
        var architecture =
            System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture
            == System.Runtime.InteropServices.Architecture.Arm64
                ? "arm64"
                : "x64";
        var nativeModel = Path.GetFullPath(
            Path.Combine(
                AppContext.BaseDirectory,
                "..",
                "Resources",
                "runtime",
                "llama",
                architecture,
                "libllama.dylib"
            )
        );
        LLama.Native.NativeLibraryConfig.LLama.WithLibrary(nativeModel);
#endif
        var builder = MauiApp.CreateBuilder().UseMauiApp<App>();
#if MACCATALYST
        builder.ConfigureMauiHandlers(handlers => handlers.AddHandler<MacDialogView, MacDialogViewHandler>());
#endif
        builder.Services.AddVroom(
            Environment.GetEnvironmentVariable("VROOM_DATA") ??
#if MACCATALYST
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Vroom", "catalog"),
#else
                Path.Combine(FileSystem.AppDataDirectory, "catalog"),
#endif
            allowSourceBrowser: true,
            allowExternalPlayers: true
        );
        builder.Services.AddTransient<MainPage>();
        builder.Services.AddSingleton<AppInitialization>();
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

// Reopening a Mac window creates a new page, but catalog startup and background
// workers belong to the application, not to each restored window.
internal sealed class AppInitialization(IServiceProvider services)
{
    private readonly Lazy<Task> ready = new(() => Task.Run(() => services.InitializeVroomAsync()));
    public Task Ready => ready.Value;
}
