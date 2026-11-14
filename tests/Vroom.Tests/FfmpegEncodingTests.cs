using System.Text;
using System.Text.Json;
using Vroom.Core.Media;

namespace Vroom.Tests;

[CollectionDefinition("ProcessEncoding", DisableParallelization = true)]
public sealed class ProcessEncodingCollection;

[Collection("ProcessEncoding")]
public sealed class FfmpegEncodingTests
{
    [Theory]
    [InlineData(936)]
    [InlineData(1252)]
    [InlineData(65001)]
    public async Task MediaOutputPreservesUnicodePathsTitlesAndErrorsRegardlessOfConsoleEncoding(int codePage)
    {
        const string output = """
            {"format":{"filename":"C:\\媒体\\彩\\测试.mp4"},"streams":[{"tags":{"title":"日本語 / 中文 / Français 🎬 \"quoted\" \\ track"}}]}
            """;
        const string error = "无法读取媒体 / 日本語 / Français 🎬";
        var directory = Path.Combine(Path.GetTempPath(), "vroom-encoding-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var originalEncoding = Console.OutputEncoding;
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
        try
        {
            Console.OutputEncoding = Encoding.GetEncoding(codePage);
            await File.WriteAllTextAsync(Path.Combine(directory, "stdout.json"), output, new UTF8Encoding(false));
            await File.WriteAllTextAsync(Path.Combine(directory, "stderr.txt"), error, new UTF8Encoding(false));
            var windows = OperatingSystem.IsWindows();
            var script = Path.Combine(directory, windows ? "emit.cmd" : "emit.sh");
            await File.WriteAllTextAsync(
                script,
                windows
                    ? "@type \"%~dp0stdout.json\"\r\n@type \"%~dp0stderr.txt\" 1>&2\r\n"
                    : "cat \"$(dirname \"$0\")/stdout.json\"\ncat \"$(dirname \"$0\")/stderr.txt\" >&2\n"
            );
            using var process = FfmpegService.Start(
                windows ? Path.Combine(Environment.SystemDirectory, "cmd.exe") : "/bin/sh",
                windows ? ["/d", "/c", script] : [script]
            );
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            var stdout = process.StandardOutput.ReadToEndAsync(timeout.Token);
            var stderr = process.StandardError.ReadToEndAsync(timeout.Token);
            await process.WaitForExitAsync(timeout.Token);
            using var json = JsonDocument.Parse(await stdout);
            Assert.Equal(0, process.ExitCode);
            Assert.Equal(
                @"C:\媒体\彩\测试.mp4",
                json.RootElement.GetProperty("format").GetProperty("filename").GetString()
            );
            Assert.Equal(
                "日本語 / 中文 / Français 🎬 \"quoted\" \\ track",
                json.RootElement.GetProperty("streams")[0].GetProperty("tags").GetProperty("title").GetString()
            );
            Assert.Equal(error, await stderr);
        }
        finally
        {
            Console.OutputEncoding = originalEncoding;
            Directory.Delete(directory, true);
        }
    }
}
