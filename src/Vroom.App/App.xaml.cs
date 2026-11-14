namespace Vroom.App;

public partial class App : Application
{
    private readonly MainPage page;

    public App(MainPage page)
    {
        this.page = page;
        InitializeComponent();
        UserAppTheme = AppTheme.Dark;
    }

    protected override Window CreateWindow(IActivationState? activationState)
    {
        var window = new Window(page)
        {
            Title = "Vroom",
            Width = 1520,
            Height = 980,
            MinimumWidth = 1000,
            MinimumHeight = 680,
        };
        DesktopWindowChrome.Attach(window);
        return window;
    }
}
