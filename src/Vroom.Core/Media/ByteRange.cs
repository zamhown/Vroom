namespace Vroom.Core.Media;

public readonly record struct ByteRange(long Start, long End)
{
    public long Length => End - Start + 1;

    public static bool TryParse(string? header, long length, out ByteRange range)
    {
        range = new(0, length - 1);
        if (header is null)
            return true;
        if (length <= 0 || !header.StartsWith("bytes=", StringComparison.OrdinalIgnoreCase) || header.Contains(','))
            return false;
        var halves = header[6..].Split('-');
        if (halves.Length != 2)
            return false;
        if (halves[0].Length == 0)
        {
            if (!long.TryParse(halves[1], out var suffix) || suffix <= 0)
                return false;
            range = new(Math.Max(0, length - suffix), length - 1);
            return true;
        }
        if (!long.TryParse(halves[0], out var start) || start < 0 || start >= length)
            return false;
        var end = length - 1;
        if (halves[1].Length > 0 && (!long.TryParse(halves[1], out end) || end < start))
            return false;
        range = new(start, Math.Min(end, length - 1));
        return true;
    }
}
