using System.Buffers.Binary;
using System.Text;
using System.Text.Json.Nodes;
using Vroom.Core.Media;
using Vroom.Core.Tagging;

namespace Vroom.Tests;

public sealed class ImageSizeTests
{
    internal static byte[] Png(int width, int height)
    {
        var bytes = new byte[33];
        new byte[] { 0x89, (byte)'P', (byte)'N', (byte)'G', 13, 10, 26, 10, 0, 0, 0, 13 }.CopyTo(bytes, 0);
        Encoding.ASCII.GetBytes("IHDR").CopyTo(bytes, 12);
        BinaryPrimitives.WriteInt32BigEndian(bytes.AsSpan(16), width);
        BinaryPrimitives.WriteInt32BigEndian(bytes.AsSpan(20), height);
        return bytes;
    }

    private delegate void ChunkData(Span<byte> data);

    private static byte[] WebP(string chunk, ChunkData data)
    {
        var bytes = new byte[30];
        Encoding.ASCII.GetBytes("RIFF").CopyTo(bytes, 0);
        Encoding.ASCII.GetBytes("WEBP" + chunk).CopyTo(bytes, 8);
        data(bytes.AsSpan(20));
        return bytes;
    }

    private static byte[] Jpeg(int width, int height, int orientation = 1, bool bigEndian = false)
    {
        var bytes = new List<byte> { 0xff, 0xd8 };
        bytes.AddRange([0xff, 0xe0, 0, 16, .. "JFIF\0"u8, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
        if (orientation != 1)
        {
            byte[] tiff = bigEndian
                ? [(byte)'M', (byte)'M', 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, (byte)orientation]
                : [(byte)'I', (byte)'I', 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, (byte)orientation, 0];
            byte[] payload = [.. "Exif\0\0"u8, .. tiff, 0, 0, 0, 0, 0, 0];
            bytes.AddRange([0xff, 0xe1, (byte)((payload.Length + 2) >> 8), (byte)(payload.Length + 2), .. payload]);
        }
        // A fill byte before a progressive frame header, as some encoders write.
        bytes.AddRange([0xff, 0xff, 0xc2, 0, 17, 8, (byte)(height >> 8), (byte)height, (byte)(width >> 8)]);
        bytes.AddRange([(byte)width, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xda, 0, 2, 0xff, 0xd9]);
        return [.. bytes];
    }

    private static ImageSize? Read(byte[] bytes) => ImageSize.Read(new MemoryStream(bytes));

    [Fact]
    public void ReadsDisplayedSizesFromStillImageHeaders()
    {
        Assert.Equal(new ImageSize(1500, 1000), Read(Png(1500, 1000)));
        Assert.Equal(new ImageSize(300, 200), Read([.. "GIF89a"u8, 0x2c, 0x01, 0xc8, 0x00, 0, 0]));
        Assert.Equal(
            new ImageSize(1920, 1080),
            Read(
                WebP(
                    "VP8X",
                    d =>
                    {
                        d[4] = 0x7f;
                        d[5] = 0x07;
                        d[7] = 0x37;
                        d[8] = 0x04;
                    }
                )
            )
        );
        Assert.Equal(
            new ImageSize(400, 600),
            Read(
                WebP(
                    "VP8L",
                    d =>
                    {
                        d[0] = 0x2f;
                        BinaryPrimitives.WriteUInt32LittleEndian(d[1..], 399u | 599u << 14);
                    }
                )
            )
        );
        Assert.Equal(
            new ImageSize(640, 480),
            Read(
                WebP(
                    "VP8 ",
                    d =>
                    {
                        d[3] = 0x9d;
                        d[4] = 0x01;
                        d[5] = 0x2a;
                        BinaryPrimitives.WriteUInt16LittleEndian(d[6..], 640);
                        BinaryPrimitives.WriteUInt16LittleEndian(d[8..], 480);
                    }
                )
            )
        );
        Assert.Equal(new ImageSize(1200, 800), Read(Jpeg(1200, 800)));
    }

    [Theory]
    [InlineData(3, false, 1200, 800)]
    [InlineData(6, false, 800, 1200)]
    [InlineData(8, true, 800, 1200)]
    public void JpegSizeFollowsTheExifOrientationBrowsersApply(int orientation, bool bigEndian, int width, int height)
    {
        Assert.Equal(new ImageSize(width, height), Read(Jpeg(1200, 800, orientation, bigEndian)));
    }

    [Fact]
    public void UnknownOrTruncatedImagesHaveNoSize()
    {
        Assert.Null(Read("not an image at all"u8.ToArray()));
        Assert.Null(Read(Png(0, 1000)));
        Assert.Null(Read(Jpeg(1200, 800)[..27]));
        // Scan data before any frame header.
        Assert.Null(Read([0xff, 0xd8, 0xff, 0xda, 0, 2, 0xff, 0xd9]));
    }
}

public sealed partial class TaggingTests
{
    private async Task<string> ImportImage(int width, int height) =>
        (
            await engine.ImportAssetAsync(
                new() { ["base64"] = Convert.ToBase64String(ImageSizeTests.Png(width, height)) }
            )
        ).Text("value");

    private async Task<JsonNode> Presentation() => (await engine.FilmAsync(film.Id))["film"]!["presentation"]!;

    private async Task ApplyChanges(params JsonObject[] changes)
    {
        var preview = await engine.PreviewConfigAsync(
            new() { ["changes"] = new JsonArray(changes.Select(c => (JsonNode?)c).ToArray()) }
        );
        await engine.ApplyConfigAsync(new() { ["previewToken"] = preview.Text("previewToken") });
    }

    private static JsonObject Identity(JsonNode presentation) =>
        new()
        {
            ["kind"] = "ui.identity",
            ["key"] = "core.identity.film",
            ["value"] = new JsonObject
            {
                ["title"] = Parse("""{"fact":"file.baseName"}"""),
                ["tabTitle"] = Parse("""{"fact":"file.baseName"}"""),
                ["primaryImage"] = Parse("""{"tag":"user.art.image"}"""),
                ["primaryImagePresentation"] = presentation,
            },
        };

    [Fact]
    public async Task BuiltInPosterDisplayFollowsTheFilmSettingThenTheUnfoldedCaseShape()
    {
        var unfolded = await ImportImage(1500, 1000);
        await Batch(Write("core.poster", JsonValue.Create(unfolded)));
        var shown = await Presentation();
        Assert.Equal(1500, shown["imageSize"]!["width"]!.GetValue<int>());
        Assert.Equal(1000, shown["imageSize"]!["height"]!.GetValue<int>());
        // Hosts fill registered parameter defaults, so clients never guess the spine width.
        Assert.True(
            JsonNode.DeepEquals(
                Parse("""{"component":"disc-case@1","props":{"view":"3d","spine":0.05}}"""),
                shown["imagePresentation"]
            )
        );
        var listed = (await engine.QueryAsync(Parse("{}")))["films"]![0]!["presentation"]!;
        Assert.True(JsonNode.DeepEquals(shown["imagePresentation"], listed["imagePresentation"]));

        await Batch(Write("core.poster.presentation", Parse("""{"term":"core.poster.presentations.whole"}""")));
        Assert.Equal("image@1", (await Presentation())["imagePresentation"].Text("component"));
        await Batch(Write("core.poster.presentation", Parse("""{"term":"core.poster.presentations.disc-back"}"""), 1));
        Assert.Equal("back", (await Presentation())["imagePresentation"]!["props"].Text("view"));

        var clear = Write("core.poster.presentation", null, 2);
        clear["operation"] = "clear";
        await Batch(clear, Write("core.poster", JsonValue.Create(await ImportImage(1000, 1500)), 1));
        Assert.Equal("image@1", (await Presentation())["imagePresentation"].Text("component"));
    }

    [Fact]
    public async Task UserIdentityDecidesImagePresentationForUnfamiliarFields()
    {
        await ConfigureVocabulary(
            "user.frames",
            Parse(
                """{"key":"user.art.image","revision":1,"enabled":true,"label":{"en":"Artwork"},"parents":[],"targets":["film-whole"],"value":{"cardinality":"one","schema":{"type":"string"},"semanticVersion":1},"input":{"component":"asset@1"},"placements":[],"writes":{"manual":true}}"""
            ),
            Parse(
                """{"key":"user.art.frame","revision":1,"enabled":true,"label":{"en":"Frame"},"parents":[],"targets":["film-whole"],"value":{"cardinality":"one","schema":{"type":"object","properties":{"term":{"type":"string"}},"required":["term"],"additionalProperties":false},"semanticVersion":1,"vocabulary":"user.frames"},"input":{"component":"select@1"},"placements":[],"writes":{"manual":true}}"""
            )
        );
        await CreateTerm("user.frames.flat", "user.frames", "Flat");
        await ApplyChanges(
            Identity(
                Parse(
                    """{"op":"case","args":[{"op":"eq","args":[{"tag":"user.art.frame"},{"literal":{"term":"user.frames.flat"}}]},{"literal":{"component":"image@1"}},{"op":"gt","args":[{"fact":"image.width"},{"literal":1000}]},{"literal":{"component":"disc-case@1","props":{"view":"back","spine":0.1}}},{"literal":null}]}"""
                )
            )
        );
        var none = await Presentation();
        Assert.Null(none["imagePresentation"]);
        Assert.NotNull(none["frameAt"]);

        await Batch(Write("user.art.image", JsonValue.Create(await ImportImage(1200, 900))));
        Assert.True(
            JsonNode.DeepEquals(
                Parse("""{"component":"disc-case@1","props":{"view":"back","spine":0.1}}"""),
                (await Presentation())["imagePresentation"]
            )
        );
        await Batch(Write("user.art.frame", Parse("""{"term":"user.frames.flat"}""")));
        Assert.True(
            JsonNode.DeepEquals(
                Parse("""{"component":"image@1","props":{}}"""),
                (await Presentation())["imagePresentation"]
            )
        );

        // A field value is never trusted as a presentation; it falls back to the whole image.
        await ApplyChanges(Identity(Parse("""{"tag":"user.art.image"}""")));
        var fallback = await Presentation();
        Assert.Null(fallback["imagePresentation"]);
        Assert.Equal(1200, fallback["imageSize"]!["width"]!.GetValue<int>());
    }

    [Theory]
    [InlineData("""{"literal":{"component":"user.unregistered@1"}}""", "IMAGE_PRESENTATION_UNAVAILABLE")]
    [InlineData(
        """{"op":"case","args":[{"op":"gt","args":[{"fact":"image.aspectRatio"},{"literal":1}]},{"literal":{"component":"disc-case@1","props":{"view":"sideways"}}},{"literal":null}]}""",
        "IMAGE_PRESENTATION_UNAVAILABLE"
    )]
    [InlineData("""{"literal":{"component":"image@1","extra":true}}""", "IMAGE_PRESENTATION_UNAVAILABLE")]
    [InlineData(
        """{"op":"case","args":[{"op":"gt","args":[{"fact":"image.depth"},{"literal":1}]},{"literal":null},{"literal":null}]}""",
        "EXPRESSION_FACT_UNAVAILABLE"
    )]
    public async Task PublicationRejectsUnregisteredImagePresentations(string presentation, string code)
    {
        await Publish(
            Parse(
                """{"key":"user.art.image","revision":1,"enabled":true,"label":{"en":"Artwork"},"parents":[],"targets":["film-whole"],"value":{"cardinality":"one","schema":{"type":"string"},"semanticVersion":1},"input":{"component":"asset@1"},"placements":[],"writes":{"manual":true}}"""
            )
        );
        var error = await Assert.ThrowsAsync<TagException>(() => ApplyChanges(Identity(Parse(presentation))));
        Assert.Equal(code, error.Code);
        Assert.StartsWith("/ui/identity/core.identity.film/primaryImagePresentation", error.Pointer);
    }

    [Fact]
    public async Task PrimaryImageFactsAreOnlyAvailableToThePresentation()
    {
        var identity = Identity(Parse("""{"literal":null}"""));
        identity["value"]!["title"] = Parse("""{"fact":"image.width"}""");
        await Publish(
            Parse(
                """{"key":"user.art.image","revision":1,"enabled":true,"label":{"en":"Artwork"},"parents":[],"targets":["film-whole"],"value":{"cardinality":"one","schema":{"type":"string"},"semanticVersion":1},"input":{"component":"asset@1"},"placements":[],"writes":{"manual":true}}"""
            )
        );
        var error = await Assert.ThrowsAsync<TagException>(() => ApplyChanges(identity));
        Assert.Equal("EXPRESSION_FACT_UNAVAILABLE", error.Code);
        Assert.Equal("/ui/identity/core.identity.film/title/fact", error.Pointer);
    }
}
