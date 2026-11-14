namespace Vroom.App;

/// <summary>The private desktop window transport accepts only the packaged dialog document.</summary>
internal sealed record DialogWindowRequest(string Id, bool Exclusive, int Width, int Height)
{
    public static bool IsDocument(string value) =>
        Uri.TryCreate(value, UriKind.Absolute, out var uri)
        && uri.Scheme == "https"
        && uri.Host == "0.0.0.1"
        && uri.IsDefaultPort
        && uri.UserInfo.Length == 0
        && uri.AbsolutePath == "/dialog.html";

    public static bool TryParse(string value, out DialogWindowRequest request)
    {
        request = null!;
        if (!IsDocument(value))
            return false;
        var uri = new Uri(value);
        var pairs = uri.Query.TrimStart('?').Split('&').Select(p => p.Split('=', 2)).ToArray();
        if (pairs.Length != 4 || pairs.Any(p => p.Length != 2) || pairs.Select(p => p[0]).Distinct().Count() != 4)
            return false;
        var args = pairs.ToDictionary(p => p[0], p => p[1], StringComparer.Ordinal);
        if (
            !args.TryGetValue("id", out var id)
            || !Guid.TryParseExact(id, "D", out _)
            || !args.TryGetValue("mode", out var mode)
            || mode is not ("exclusive" or "modeless")
            || !args.TryGetValue("width", out var width)
            || !int.TryParse(width, out var w)
            || w is < 320 or > 1600
            || !args.TryGetValue("height", out var height)
            || !int.TryParse(height, out var h)
            || h is < 180 or > 1200
        )
            return false;
        request = new(id, mode == "exclusive", w, h);
        return true;
    }

    public static (int X, int Y, int Width, int Height) Place(
        int width,
        int height,
        int ownerX,
        int ownerY,
        int ownerWidth,
        int ownerHeight,
        int screenX,
        int screenY,
        int screenWidth,
        int screenHeight
    )
    {
        width = Math.Min(Math.Max(1, width), Math.Max(1, screenWidth));
        height = Math.Min(Math.Max(1, height), Math.Max(1, screenHeight));
        return (
            Math.Clamp(ownerX + (ownerWidth - width) / 2, screenX, screenX + screenWidth - width),
            Math.Clamp(ownerY + (ownerHeight - height) / 2, screenY, screenY + screenHeight - height),
            width,
            height
        );
    }

    public static (int X, int Y, int Width, int Height) ResizeToContent(
        int contentHeight,
        double scale,
        int chromeHeight,
        int x,
        int y,
        int width,
        int screenX,
        int screenY,
        int screenWidth,
        int screenHeight
    )
    {
        // Clamp in physical pixels before converting to int; long content only enlarges the scroll range.
        var height = (int)Math.Clamp(Math.Ceiling(contentHeight * scale) + chromeHeight, 1, Math.Max(1, screenHeight));
        width = Math.Clamp(width, 1, Math.Max(1, screenWidth));
        return (
            Math.Clamp(x, screenX, screenX + screenWidth - width),
            Math.Clamp(y, screenY, screenY + screenHeight - height),
            width,
            height
        );
    }
}
