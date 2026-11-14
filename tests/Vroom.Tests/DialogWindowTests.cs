using Vroom.App;

namespace Vroom.Tests;

public class DialogWindowTests
{
    private const string Query = "?id=8e8f870e-0508-482f-9d81-701ad806b45b&mode=exclusive&width=640&height=480";

    [Theory]
    [InlineData("https://0.0.0.1/dialog.html", true)]
    [InlineData("http://0.0.0.1/dialog.html", false)]
    [InlineData("https://0.0.0.1:9000/dialog.html", false)]
    [InlineData("https://0.0.0.1.evil.test/dialog.html", false)]
    [InlineData("https://other.test/dialog.html", false)]
    [InlineData("https://someone@0.0.0.1/dialog.html", false)]
    [InlineData("https://0.0.0.1/index.html", false)]
    public void Only_packaged_dialog_can_create_a_native_window(string uri, bool accepted) =>
        Assert.Equal(accepted, DialogWindowRequest.TryParse(uri + Query, out _));

    [Fact]
    public void Modes_are_explicit_and_unknown_or_ambiguous_options_are_rejected()
    {
        var uri = "https://0.0.0.1/dialog.html" + Query;
        Assert.True(DialogWindowRequest.TryParse(uri, out var exclusive));
        Assert.True(exclusive.Exclusive);
        Assert.True(DialogWindowRequest.TryParse(uri.Replace("exclusive", "modeless"), out var modeless));
        Assert.False(modeless.Exclusive);
        foreach (
            var invalid in new[]
            {
                uri.Replace("exclusive", "auto"),
                uri.Replace("640", "-1"),
                uri + "&mode=modeless",
                uri + "&url=other",
                uri.Replace("480", "999999"),
                uri.Replace("id=8e8f870e-0508-482f-9d81-701ad806b45b", "id=x"),
            }
        )
            Assert.False(DialogWindowRequest.TryParse(invalid, out _));
    }

    [Theory]
    [InlineData(-1920, 0, 1920, 1040, -100, 50)]
    [InlineData(0, 0, 1920, 1040, -2000, -900)]
    [InlineData(1920, -1200, 800, 600, 5000, 5000)]
    public void Windows_fit_the_owners_monitor_including_negative_coordinates(
        int x,
        int y,
        int width,
        int height,
        int ownerX,
        int ownerY
    )
    {
        var rect = DialogWindowRequest.Place(1440, 960, ownerX, ownerY, 1000, 700, x, y, width, height);
        Assert.InRange(rect.X, x, x + width - rect.Width);
        Assert.InRange(rect.Y, y, y + height - rect.Height);
        Assert.InRange(rect.Width, 1, width);
        Assert.InRange(rect.Height, 1, height);
    }

    [Fact]
    public void Content_growth_and_shrinkage_preserve_the_windows_position_and_width()
    {
        var small = DialogWindowRequest.ResizeToContent(200, 1, 32, 100, 120, 720, 0, 0, 1920, 1040);
        var large = DialogWindowRequest.ResizeToContent(600, 1, 32, small.X, small.Y, small.Width, 0, 0, 1920, 1040);
        Assert.Equal((100, 120, 720, 632), large);
        Assert.Equal(
            small,
            DialogWindowRequest.ResizeToContent(200, 1, 32, large.X, large.Y, large.Width, 0, 0, 1920, 1040)
        );
    }

    [Fact]
    public void Long_content_uses_the_full_work_area_then_shrinks_without_recentering()
    {
        var capped = DialogWindowRequest.ResizeToContent(int.MaxValue, 2, 48, -1800, 600, 800, -1920, 40, 1920, 1000);
        Assert.Equal((-1800, 40, 800, 1000), capped);
        var shrunk = DialogWindowRequest.ResizeToContent(
            200,
            2,
            48,
            capped.X,
            capped.Y,
            capped.Width,
            -1920,
            40,
            1920,
            1000
        );
        Assert.Equal((-1800, 40, 800, 448), shrunk);
    }

    [Fact]
    public void Fractional_dpi_rounds_up_so_fitting_content_does_not_get_a_scrollbar() =>
        Assert.Equal(
            (100, 100, 640, 296),
            DialogWindowRequest.ResizeToContent(201, 1.25, 44, 100, 100, 640, 0, 0, 1920, 1040)
        );

    [Fact]
    public void Tall_monitors_are_not_limited_to_the_old_1200_css_pixel_cap() =>
        Assert.Equal(
            (100, 100, 640, 1732),
            DialogWindowRequest.ResizeToContent(1700, 1, 32, 100, 100, 640, 0, 0, 1920, 2120)
        );
}
