using System.Text.Json;
using Vroom.Core;
using Vroom.Core.Application;

namespace Vroom.App;

public partial class MainPage : ContentPage
{
    private readonly ClientApi api;
    private readonly LocalDiagnostics diagnostics;
    private readonly Task initialization;
    private readonly Vroom.Core.Media.NativeMpvService playback;
    private Task? shutdown;
    private int readyReported;
#if MACCATALYST
    private readonly MacDialogWindows dialogs;
#endif
#if WINDOWS
    private WindowsCompositionHost? client;
#else
    private readonly HybridWebView client;
#endif

    public MainPage(ClientApi api, IServiceProvider services)
    {
        this.api = api;
        diagnostics = services.GetRequiredService<LocalDiagnostics>();
        initialization = services.GetRequiredService<AppInitialization>().Ready;
        playback = services.GetRequiredService<Vroom.Core.Media.NativeMpvService>();
        InitializeComponent();
#if WINDOWS
        ClientHost.Loaded += async (_, _) =>
        {
            if (client is not null)
                return;
            try
            {
                client = new WindowsCompositionHost(ClientHost, diagnostics, ReceiveMessage);
                services.GetRequiredService<NativeVideoSurface>().Attach(client);
                await client.InitializeAsync();
            }
            catch (Exception ex)
            {
                diagnostics.Error("composition.initialize", ex);
                client?.Dispose();
                // Preserve the platform's diagnostic if the browser itself cannot start.
                ClientHost.Content = new Label
                {
                    Text = ex.Message,
                    Margin = new Thickness(24),
                    VerticalOptions = LayoutOptions.Center,
                };
            }
        };
#else
        client = new HybridWebView { HybridRoot = "wwwroot", DefaultFile = "index.html" };
#if MACCATALYST
        dialogs = new MacDialogWindows(
            diagnostics,
            services.GetRequiredService<Vroom.Core.Media.NativeMpvService>().StopAllAsync
        );
        client.WebViewInitializing += (_, e) => dialogs.Configure(e.PlatformArgs!.Configuration);
        client.WebViewInitialized += (_, e) => dialogs.Attach(e.PlatformArgs!.Sender);
#endif
        client.RawMessageReceived += (_, e) => ReceiveMessage(e.Message ?? "{}");
        ClientHost.Content = client;
        services.GetRequiredService<NativeVideoSurface>().Attach(client);
#endif
        Unloaded += async (_, _) => await ShutdownAsync();
    }

    internal Task ShutdownAsync() => shutdown ??= ShutdownCoreAsync();

    private async Task ShutdownCoreAsync()
    {
        try
        {
            await playback.StopAllAsync();
        }
        catch (Exception ex)
        {
            diagnostics.Error("native.playback.shutdown", ex);
        }
#if WINDOWS
        client?.Dispose();
#elif MACCATALYST
        dialogs.Dispose();
#endif
    }

    private async void ReceiveMessage(string raw)
    {
        string id = "";
        string response;
        try
        {
            using var message = JsonDocument.Parse(raw);
            id = message.RootElement.GetProperty("id").GetString()!;
            var request = message.RootElement.GetProperty("request").GetRawText();
            await initialization;
            response = await Task.Run(() => api.RequestAsync(request));
            if (message.RootElement.GetProperty("request").GetProperty("method").GetString() == "bootstrap")
            {
                using var resultDocument = JsonDocument.Parse(response);
                if (
                    resultDocument.RootElement.GetProperty("ok").GetBoolean()
                    && Interlocked.Exchange(ref readyReported, 1) == 0
                )
                    diagnostics.Write("native.client.ready", "Client bootstrap completed.");
            }
        }
        catch (Exception ex)
        {
            diagnostics.Error("native.rpc", ex);
            response = JsonSerializer.Serialize(new { ok = false, error = ex.Message });
        }
        var result = JsonSerializer.Serialize(new { id, response });
        MainThread.BeginInvokeOnMainThread(() =>
        {
            try
            {
                client?.SendRawMessage(result);
            }
            catch (Exception ex)
            {
                diagnostics.Error("native.reply", ex);
            }
        });
    }
}
