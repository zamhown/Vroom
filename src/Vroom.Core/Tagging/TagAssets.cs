using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Vroom.Core.Media;

namespace Vroom.Core.Tagging;

public sealed partial class TagEngine
{
    // Assets are content-addressed and never rewritten, so a measured size stays valid.
    private static readonly ConcurrentDictionary<string, ImageSize> AssetSizes = new(StringComparer.Ordinal);

    internal ImageSize? AssetImageSize(JsonNode? image)
    {
        if (
            image is not JsonValue value
            || !value.TryGetValue<string>(out var text)
            || !text.StartsWith("asset:", StringComparison.Ordinal)
        )
            return null;
        var hash = text[6..].ToLowerInvariant();
        if (AssetSizes.TryGetValue(hash, out var known))
            return known;
        try
        {
            if (ImageSize.Read(AssetPath(hash)) is not { } size)
                return null;
            if (AssetSizes.Count < 100_000)
                AssetSizes[hash] = size;
            return size;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or TagException)
        {
            return null;
        }
    }

    public async Task<JsonObject> ImportAssetAsync(JsonObject args, CancellationToken ct = default)
    {
        var encoded = args.Text("base64");
        if (encoded.Length > 14_000_000)
            throw new TagException("ASSET_TOO_LARGE");
        byte[] bytes;
        try
        {
            bytes = Convert.FromBase64String(encoded);
        }
        catch (FormatException)
        {
            throw new TagException("ASSET_INVALID");
        }
        if (bytes.Length < 12 || bytes.Length > 10 * 1024 * 1024)
            throw new TagException("ASSET_INVALID");
        var image =
            bytes[0] == 0xff && bytes[1] == 0xd8
            || bytes[0] == 137 && bytes[1] == 80 && bytes[2] == 78 && bytes[3] == 71
            || Encoding.ASCII.GetString(bytes, 0, 3) == "GIF"
            || Encoding.ASCII.GetString(bytes, 0, 4) == "RIFF" && Encoding.ASCII.GetString(bytes, 8, 4) == "WEBP";
        if (!image)
            throw new TagException("ASSET_FORMAT_UNSUPPORTED");
        var id = Convert.ToHexStringLower(SHA256.HashData(bytes));
        var path = AssetPath(id);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        await File.WriteAllBytesAsync(temp, bytes, ct);
        File.Move(temp, path, true);
        return new() { ["value"] = "asset:" + id, ["id"] = id };
    }
}
