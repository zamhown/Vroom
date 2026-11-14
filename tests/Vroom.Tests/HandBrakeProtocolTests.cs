using System.Text.Json.Nodes;
using Json.Schema;
using Vroom.Core.Media;
using Vroom.Core.Tagging;

namespace Vroom.Tests;

public sealed class HandBrakeProtocolTests
{
    [Fact]
    public void AllSupportedEncodingFlagsAreDiscoverableIncludingAliasesAndOptionalValues()
    {
        var help = File.ReadAllText(
            Path.Combine(Root(), "tests", "Vroom.Tests", "Fixtures", "HandBrake-1.11.2-help.txt")
        );
        var options = HandBrakeProtocol.ParseHelp(help);
        Assert.True(options.Count > 130, $"Only {options.Count} options discovered");
        Assert.Equal(new[] { "av_mp4", "av_mov", "av_mkv", "av_webm" }, options.Single(o => o.Key == "format").Choices);
        Assert.All(
            new[] { "vfr", "cfr", "pfr" },
            key => Assert.Contains(options, o => o.Key == key && o.Arity == "none")
        );
        Assert.Equal("optional", options.Single(o => o.Key == "subtitle-burned").Arity);
        Assert.Equal("required", options.Single(o => o.Key == "min-duration").Arity);
        Assert.Contains(options, o => o.Key == "srt-file" && o.Group == "Subtitles");
        Assert.DoesNotContain(
            options,
            o => o.Key is "input" or "output" or "queue-import-file" or "preset-export-file"
        );
        var args = HandBrakeProtocol.Arguments(
            new Dictionary<string, string?>
            {
                ["srt-file"] = "D:\\字幕 文件\\x.srt",
                ["aname"] = "a --output evil",
                ["subtitle-burned"] = null,
            },
            options
        );
        Assert.Equal("--aname=a --output evil", args[1]);
        Assert.Equal(3, args.Length);
        Assert.Throws<ArgumentException>(() =>
            HandBrakeProtocol.Arguments(new Dictionary<string, string?> { ["output"] = "elsewhere" }, options)
        );
        Assert.Throws<ArgumentException>(() =>
            HandBrakeProtocol.Arguments(
                new Dictionary<string, string?> { ["quality"] = "22", ["vb"] = "2000" },
                options
            )
        );
        Assert.Throws<ArgumentException>(() =>
            HandBrakeProtocol.Arguments(new Dictionary<string, string?> { ["title"] = "0" }, options)
        );
        Assert.Throws<ArgumentException>(() =>
            HandBrakeProtocol.Arguments(new Dictionary<string, string?> { ["quality"] = "NaN" }, options)
        );
    }

    [Fact]
    public void JsonFramesCanBeSplitAtAnyByteAndContainQuotedBraces()
    {
        const string input =
            "noise\nVersion: {\"Name\":\"a \\\" { }\"}\nProgress: {\"State\":\"WORKING\",\"Working\":{\"Progress\":0.5,\"Pass\":2,\"PassCount\":2,\"Rate\":25.5,\"ETASeconds\":12}}\n";
        var reader = new HandBrakeJsonReader();
        var frames = input.SelectMany(c => reader.Feed(c.ToString())).ToArray();
        Assert.Equal(2, frames.Length);
        var progress = HandBrakeProtocol.Progress(frames[1]);
        Assert.NotNull(progress);
        Assert.Equal(7500, progress.Value.Progress);
        Assert.Equal(12, progress.Value.Telemetry.EtaSeconds);
    }

    [Fact]
    public void PublicRequestSchemaRejectsAmbiguousSourceAndArbitraryProperties()
    {
        var schema = Json.Schema.JsonSchema.FromText(TagResources.Read("media-export.schema.json"));
        Assert.False(
            schema
                .Evaluate(
                    System.Text.Json.JsonSerializer.SerializeToElement(
                        new
                        {
                            targets = new[]
                            {
                                new
                                {
                                    filmId = "alien",
                                    sourcePath = "D:/a",
                                    outputPath = "D:/b.mp4",
                                },
                            },
                            presetName = "any",
                            options = new { },
                        }
                    )
                )
                .IsValid
        );
        Assert.True(
            schema
                .Evaluate(
                    System.Text.Json.JsonSerializer.SerializeToElement(
                        new
                        {
                            targets = new[] { new { filmId = "alien", outputPath = "D:/b.mp4" } },
                            presetName = "any",
                            options = new { quality = "22" },
                        }
                    )
                )
                .IsValid
        );
    }

    internal static string Root()
    {
        var root = new DirectoryInfo(AppContext.BaseDirectory);
        while (root is not null && !File.Exists(Path.Combine(root.FullName, "AGENTS.md")))
            root = root.Parent;
        return root!.FullName;
    }
}
