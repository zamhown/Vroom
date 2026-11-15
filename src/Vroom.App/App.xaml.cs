namespace Vroom.App;

public partial class App : Application
{
    private readonly IServiceProvider services;

    public App(IServiceProvider services)
    {
        this.services = services;
        InitializeComponent();
        UserAppTheme = AppTheme.Dark;
    }

    protected override Window CreateWindow(IActivationState? activationState)
    {
        var page = services.GetRequiredService<MainPage>();
        var window = new Window(page)
        {
            Title = "Vroom",
            Width = 1520,
            Height = 980,
            MinimumWidth = 1000,
            MinimumHeight = 680,
        };
        window.Destroying += async (_, _) => await page.ShutdownAsync();
        DesktopWindowChrome.Attach(window);
        return window;
    }
}
