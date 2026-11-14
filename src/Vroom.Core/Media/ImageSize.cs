using System.Buffers.Binary;
using System.Text;

namespace Vroom.Core.Media;

/// <summary>Displayed pixel size of a still image, read from its header without decoding pixels.</summary>
public readonly record struct ImageSize(int Width, int Height)
{
    public double AspectRatio => (double)Width / Height;

    public static ImageSize? Read(string path)
    {
        using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 4096);
        return Read(file);
    }

    /// <summary>PNG, GIF, WebP and JPEG (baseline or progressive; EXIF orientation 5–8 swaps the axes).</summary>
    public static ImageSize? Read(Stream stream)
    {
        var head = new byte[30];
        var count = Fill(stream, head);
        bool Ascii(int at, string text) =>
            count >= at + text.Length && Encoding.ASCII.GetString(head, at, text.Length) == text;
        if (count >= 24 && head[0] == 0x89 && Ascii(1, "PNG") && Ascii(12, "IHDR"))
            return Create(
                BinaryPrimitives.ReadInt32BigEndian(head.AsSpan(16)),
                BinaryPrimitives.ReadInt32BigEndian(head.AsSpan(20))
            );
        if (Ascii(0, "GIF8") && count >= 10)
            return Create(
                BinaryPrimitives.ReadUInt16LittleEndian(head.AsSpan(6)),
                BinaryPrimitives.ReadUInt16LittleEndian(head.AsSpan(8))
            );
        if (Ascii(0, "RIFF") && Ascii(8, "WEBP") && count == head.Length)
        {
            if (Ascii(12, "VP8 ") && head[23] == 0x9d && head[24] == 0x01 && head[25] == 0x2a)
                return Create(
                    BinaryPrimitives.ReadUInt16LittleEndian(head.AsSpan(26)) & 0x3fff,
                    BinaryPrimitives.ReadUInt16LittleEndian(head.AsSpan(28)) & 0x3fff
                );
            if (Ascii(12, "VP8L") && head[20] == 0x2f)
            {
                var bits = BinaryPrimitives.ReadUInt32LittleEndian(head.AsSpan(21));
                return Create((int)(bits & 0x3fff) + 1, (int)(bits >> 14 & 0x3fff) + 1);
            }
            if (Ascii(12, "VP8X"))
                return Create(
                    (head[24] | head[25] << 8 | head[26] << 16) + 1,
                    (head[27] | head[28] << 8 | head[29] << 16) + 1
                );
            return null;
        }
        return count >= 4 && head[0] == 0xff && head[1] == 0xd8 && stream.CanSeek ? Jpeg(stream) : null;
    }

    private static ImageSize? Jpeg(Stream stream)
    {
        stream.Position = 2;
        var orientation = 1;
        var buffer = new byte[5];
        for (var segments = 0; segments < 1024; segments++)
        {
            if (Fill(stream, buffer.AsSpan(0, 2)) < 2 || buffer[0] != 0xff)
                return null;
            var marker = buffer[1];
            while (marker == 0xff)
            {
                var next = stream.ReadByte();
                if (next < 0)
                    return null;
                marker = (byte)next;
            }
            // Standalone markers carry no length; scan data before a frame header means no size.
            if (marker is 0x01 or >= 0xd0 and <= 0xd7)
                continue;
            if (marker is 0xd9 or 0xda || Fill(stream, buffer.AsSpan(0, 2)) < 2)
                return null;
            var length = BinaryPrimitives.ReadUInt16BigEndian(buffer) - 2;
            if (length < 0)
                return null;
            if (marker is >= 0xc0 and <= 0xcf and not (0xc4 or 0xc8 or 0xcc))
            {
                if (Fill(stream, buffer) < 5)
                    return null;
                var height = BinaryPrimitives.ReadUInt16BigEndian(buffer.AsSpan(1));
                var width = BinaryPrimitives.ReadUInt16BigEndian(buffer.AsSpan(3));
                return orientation >= 5 ? Create(height, width) : Create(width, height);
            }
            if (marker == 0xe1 && orientation == 1)
            {
                var segment = new byte[length];
                if (Fill(stream, segment) < length)
                    return null;
                orientation = Orientation(segment);
            }
            else
                stream.Seek(length, SeekOrigin.Current);
        }
        return null;
    }

    // EXIF APP1: "Exif\0\0", then a TIFF header whose first IFD may hold tag 0x0112 (orientation).
    private static int Orientation(byte[] app1)
    {
        const int tiff = 6;
        if (app1.Length < tiff + 8 || !app1.AsSpan(0, 6).SequenceEqual("Exif\0\0"u8))
            return 1;
        var little = app1[tiff] == 'I';
        if (app1[tiff] != app1[tiff + 1] || !little && app1[tiff] != 'M')
            return 1;
        long Read(long at, int size)
        {
            if (at < 0 || at + size > app1.Length)
                return -1;
            var span = app1.AsSpan((int)at, size);
            return size == 2
                ? little
                    ? BinaryPrimitives.ReadUInt16LittleEndian(span)
                    : BinaryPrimitives.ReadUInt16BigEndian(span)
                : little
                    ? BinaryPrimitives.ReadUInt32LittleEndian(span)
                    : BinaryPrimitives.ReadUInt32BigEndian(span);
        }
        var directory = Read(tiff + 4, 4) is >= 0 and var offset ? tiff + offset : -1;
        var entries = Read(directory, 2);
        for (var i = 0; i < entries; i++)
            if (Read(directory + 2 + i * 12, 2) == 0x0112)
                return Read(directory + 2 + i * 12 + 8, 2) is >= 1 and <= 8 and var value ? (int)value : 1;
        return 1;
    }

    private static ImageSize? Create(int width, int height) =>
        width is > 0 and <= 1 << 20 && height is > 0 and <= 1 << 20 ? new(width, height) : null;

    private static int Fill(Stream stream, Span<byte> buffer)
    {
        var total = 0;
        while (total < buffer.Length && stream.Read(buffer[total..]) is > 0 and var read)
            total += read;
        return total;
    }
}
