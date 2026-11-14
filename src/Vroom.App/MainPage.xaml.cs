using System.Text.Json;
using Vroom.Core;
using Vroom.Core.Application;

namespace Vroom.App;

public partial class MainPage : ContentPage
{
    private readonly ClientApi api;
    private readonly LocalDiagnostics diagnostics;
    private readonly Task initialization;
#if WINDOWS
    private WindowsCompositionHost? client;
#else
    private readonly HybridWebView client;
#endif

    public MainPage(ClientApi api, IServiceProvider services)
    {
        this.api = api;
        diagnostics = services.GetRequiredService<LocalDiagnostics>();
        initialization = Task.Run(() => services.InitializeVroomAsync());
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
        client.RawMessageReceived += (_, e) => ReceiveMessage(e.Message ?? "{}");
        ClientHost.Content = client;
        services.GetRequiredService<NativeVideoSurface>().Attach(client);
#endif
        Unloaded += async (_, _) =>
        {
            try
            {
                await services.GetRequiredService<Vroom.Core.Media.NativeMpvService>().StopAllAsync();
            }
            catch (Exception ex)
            {
                diagnostics.Error("native.playback.shutdown", ex);
            }
#if WINDOWS
            client?.Dispose();
#endif
        };
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
