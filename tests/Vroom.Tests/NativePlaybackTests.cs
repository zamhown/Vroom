using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using Vroom.Core.Application;
using Vroom.Core.Domain;
using Vroom.Core.Media;
using Vroom.Core.Storage;
using Vroom.Core.Tagging;

namespace Vroom.Tests;

public sealed class NativePlaybackTests
{
    [Fact]
    public void NativeSettingsHaveOnePublicContractAndRejectExecutableOptions()
    {
        NativeMpvService.ValidateSettings(
            new()
            {
                ["audio-delay"] = .5,
                ["sub-scale"] = 1.5,
                ["video-rotate"] = 90,
            }
        );
        Assert.Throws<ArgumentException>(() => NativeMpvService.ValidateSettings(new() { ["speed"] = 0 }));
        Assert.Throws<ArgumentException>(() =>
            NativeMpvService.ValidateSettings(new() { ["input-ipc-server"] = "untrusted" })
        );
        Assert.Throws<ArgumentException>(() =>
            NativeMpvService.ValidateSettings(new() { ["af"] = "lavfi=[amovie=/private/file]" })
        );
        Assert.Throws<ArgumentException>(() => NativeMpvService.ValidateSettings(new() { ["volume"] = 201 }));
        Assert.Throws<ArgumentException>(() => NativeMpvService.ValidateSettings(new() { ["sub-scale"] = "large" }));
        var props = TagResources.Json("playback-capabilities.json")["nativePlayback"]!["settings"]![
            "properties"
        ]!.AsObject();
        NativeMpvService.ValidateSettings(
            new JsonObject(props.Select(p => KeyValuePair.Create(p.Key, p.Value!["default"]?.DeepClone())))
        );
    }

    [Fact]
    public void NativeRequestsRejectArbitraryCommandsPathsAndMalformedControlValues()
    {
        var schema = TagSchemas.Get("native-playback-command.schema.json");
        bool Accept(string method, JsonObject args) =>
            schema.Evaluate(new JsonObject { ["method"] = method, ["args"] = args }).IsValid;
        var id = new string('a', 32);
        Assert.True(
            Accept(
                "native.settings",
                new()
                {
                    ["sessionId"] = id,
                    ["values"] = new JsonObject { ["sub-delay"] = -.2 },
                }
            )
        );
        Assert.True(
            Accept(
                "native.open",
                new()
                {
                    ["filmId"] = "media-id",
                    ["position"] = 0,
                    ["settings"] = new JsonObject(),
                }
            )
        );
        Assert.False(
            Accept(
                "native.open",
                new()
                {
                    ["path"] = "C:/unrelated/file",
                    ["position"] = 0,
                    ["settings"] = new JsonObject(),
                }
            )
        );
        Assert.False(Accept("native.command", new() { ["sessionId"] = id, ["command"] = "run" }));
        Assert.False(Accept("native.surface", new() { ["sessionId"] = id, ["windowId"] = 123 }));
        Assert.False(Accept("native.seek", new() { ["sessionId"] = id, ["position"] = -1 }));
        Assert.True(
            Accept(
                "native.seek",
                new()
                {
                    ["sessionId"] = id,
                    ["position"] = 5,
                    ["precision"] = "keyframe",
                }
            )
        );
        Assert.True(
            Accept(
                "native.seek",
                new()
                {
                    ["sessionId"] = id,
                    ["position"] = 5,
                    ["precision"] = "exact",
                }
            )
        );
        Assert.False(
            Accept(
                "native.seek",
                new()
                {
                    ["sessionId"] = id,
                    ["position"] = 5,
                    ["precision"] = "arbitrary",
                }
            )
        );
        Assert.False(Accept("native.pause", new() { ["sessionId"] = id, ["paused"] = "true" }));
        Assert.True(Accept("native.fullscreen", new() { ["sessionId"] = id }));
        Assert.True(Accept("native.fullscreen", new() { ["sessionId"] = id, ["enabled"] = false }));
        Assert.False(Accept("native.fullscreen", new() { ["sessionId"] = id, ["enabled"] = "yes" }));
        Assert.False(
            Accept(
                "native.track",
                new()
                {
                    ["sessionId"] = id,
                    ["kind"] = "input-ipc-server",
                    ["track"] = "auto",
                }
            )
        );
        var bounds = JsonNode
            .Parse("""{"left":0,"top":0,"width":800,"height":600,"scale":1.5,"visible":true}""")!
            .AsObject();
        bool Surface() => Accept("native.surface", new() { ["sessionId"] = id, ["bounds"] = bounds.DeepClone() });
        Assert.True(Surface());
        bounds["scale"] = 0;
        Assert.False(Surface());
        bounds["scale"] = 1.5;
        bounds["width"] = -1;
        Assert.False(Surface());
        bounds["width"] = 800;
        bounds["occlusions"] = new JsonArray();
        Assert.False(Surface()); // Removed clipping contract is not accepted.
    }

    [NativeMpvFact]
    public async Task RealMpvDecodesTracksAppliesSettingsAndSurvivesAnotherDecoderCrash()
    {
        var directory = Path.Combine(Path.GetTempPath(), "vroom-mpv-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var file = await Fixture(directory);
            using var log = new LocalDiagnostics(directory);
            await using var first = new MpvProcess(log);
            await using var second = new MpvProcess(log);
            var executable = Environment.GetEnvironmentVariable("VROOM_TEST_MPV")!;
            await first.StartAsync(executable, file, 0, directory, headless: true);
            await second.StartAsync(executable, file, 0, directory, headless: true);
            string? socketPath = null;
            if (!OperatingSystem.IsWindows())
            {
                socketPath = (await first.CommandAsync(["get_property", "input-ipc-server"]))!.GetValue<string>();
                Assert.True(System.Text.Encoding.UTF8.GetByteCount(socketPath) < 104);
                Assert.Equal(
                    UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute,
                    File.GetUnixFileMode(Path.GetDirectoryName(socketPath)!)
                );
                Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(socketPath));
            }
            var keyInput = new TaskCompletionSource<MpvInput>(TaskCreationOptions.RunContinuationsAsynchronously);
            first.InputReceived += value => keyInput.TrySetResult(value);
            await first.CommandAsync(["keypress", "SPACE"]);
            Assert.Equal(new MpvInput("key", " ", 0, 0), await keyInput.Task.WaitAsync(TimeSpan.FromSeconds(2)));
            var pointerInput = new TaskCompletionSource<MpvInput>(TaskCreationOptions.RunContinuationsAsynchronously);
            first.InputReceived += value =>
            {
                if (value.Kind == "contextmenu")
                    pointerInput.TrySetResult(value);
            };
            await first.CommandAsync(["script-message", "vroom-input", "contextmenu", "200", "150", "800", "600"]);
            Assert.Equal(
                new MpvInput("contextmenu", "", .25, .25),
                await pointerInput.Task.WaitAsync(TimeSpan.FromSeconds(2))
            );
            var tracks = (await first.CommandAsync(["get_property", "track-list"]))!.AsArray();
            Assert.Equal(2, tracks.Count(t => t!["type"]!.GetValue<string>() == "audio"));
            Assert.Single(
                tracks,
                t => t!["type"]!.GetValue<string>() == "sub" && t["external"]?.GetValue<bool>() != true
            );
            Assert.Equal(2, (await first.CommandAsync(["get_property", "chapter-list"]))!.AsArray().Count);
            await first.CommandAsync(["set_property", "aid", 2]);
            Assert.Equal(2, (await first.CommandAsync(["get_property", "aid"]))!.GetValue<int>());
            await first.CommandAsync(["set_property", "sid", 1]);
            await first.CommandAsync(["set_property", "secondary-sid", 2]);
            await first.CommandAsync(["set_property", "audio-delay", .3]);
            Assert.Equal(.3, (await first.CommandAsync(["get_property", "audio-delay"]))!.GetValue<double>(), 3);
            await first.CommandAsync(["seek", 4, "absolute+exact"]);
            await Task.Delay(200);
            Assert.InRange((await first.CommandAsync(["get_property", "time-pos"]))!.GetValue<double>(), 3.9, 4.1);
            await first.CommandAsync(["frame-step"]);
            await Task.Delay(150);
            var frame = (await first.CommandAsync(["get_property", "time-pos"]))!.GetValue<double>();
            Assert.InRange(frame, 4.02, 4.1);
            await first.CommandAsync(["frame-back-step"]);
            await Task.Delay(150);
            Assert.True((await first.CommandAsync(["get_property", "time-pos"]))!.GetValue<double>() < frame);
            var properties = TagResources.Json("playback-capabilities.json")["nativePlayback"]!["settings"]![
                "properties"
            ]!.AsObject();
            foreach (var (key, property) in properties)
            {
                try
                {
                    if (property!["enum"] is JsonArray options)
                        foreach (var value in options)
                            await first.CommandAsync(["set_property", key, value]);
                    await first.CommandAsync(["set_property", key, property["default"]]);
                }
                catch (Exception ex)
                {
                    throw new Exception("mpv default rejected: " + key, ex);
                }
            }
            await second.CommandAsync(["set_property", "speed", 1.5]);
            Process.GetProcessById(first.ProcessId).Kill(true);
            await Task.Delay(200);
            Assert.True(first.Exited);
            Assert.False(second.Exited);
            Assert.Equal(1.5, (await second.CommandAsync(["get_property", "speed"]))!.GetValue<double>());
            await second.CommandAsync(["set_property", "pause", false]);
            await Task.Delay(300);
            Assert.True((await second.CommandAsync(["get_property", "time-pos"]))!.GetValue<double>() > .1);
            await second.CommandAsync(["set_property", "pause", true]);
            Assert.Contains("mpv.ipc", await File.ReadAllTextAsync(log.FilePath));
            await first.DisposeAsync();
            if (socketPath is not null)
                Assert.False(Directory.Exists(Path.GetDirectoryName(socketPath)));
            if (OperatingSystem.IsWindows())
            {
                using var target = Process.GetProcessById(second.ProcessId);
                Assert.Equal(0, NtSuspendProcess(target.Handle));
                var pending = second.CommandAsync(["get_property", "time-pos"]);
                await Task.Delay(100);
                Assert.False(pending.IsCompleted);
                var stopping = Stopwatch.StartNew();
                second.Terminate();
                await second.DisposeAsync();
                await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending);
                Assert.True(
                    stopping.Elapsed < TimeSpan.FromSeconds(3),
                    "A stalled decoder must not hold up stop/retry."
                );
            }
        }
        finally
        {
            try
            {
                if (Directory.Exists(directory))
                    Directory.Delete(directory, true);
            }
            catch (IOException)
            { /* Some Windows decoders release file handles after process exit. */
            }
        }
    }

    [DllImport("ntdll.dll")]
    private static extern int NtSuspendProcess(nint process);

    [NativeMpvFact]
    public async Task ScrubPreviewDecodesDifferentFramesWithoutChangingMediaOrPlaybackState()
    {
        var directory = Path.Combine(Path.GetTempPath(), "vroom-preview-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var file = await Fixture(directory);
            var original = await File.ReadAllBytesAsync(file);
            using var db = new CatalogDatabase(Path.Combine(directory, "catalog"));
            var repo = new CatalogRepository(db);
            await repo.InitializeAsync();
            await repo.SaveLibraryAsync(new("fixture", "Preview fixture", [directory], []));
            await repo.SaveSettingsAsync(
                (await repo.SettingsAsync()) with
                {
                    FfmpegPath = Environment.GetEnvironmentVariable("VROOM_TEST_FFMPEG")!,
                }
            );
            var film = await repo.ImportMediaAsync(
                new Film
                {
                    LibraryId = "fixture",
                    Path = file,
                    Size = original.Length,
                    Duration = 10,
                }
            );
            await using var server = new LocalMediaServer(repo, new FfmpegService(repo));
            var revision = TagEngine.MediaRevision(film);
            var frames = await Task.WhenAll(
                server.PreviewAsync(film.Id, revision, 1),
                server.PreviewAsync(film.Id, revision, 6)
            );
            Assert.NotEqual(frames[0], frames[1]);
            foreach (var frame in frames)
            {
                Assert.StartsWith("data:image/jpeg;base64,", frame);
                var bytes = Convert.FromBase64String(frame.Split(',')[1]);
                Assert.True(bytes.Length < 3_000_000);
                Assert.Equal(new byte[] { 0xff, 0xd8 }, bytes.Take(2));
            }
            Assert.StartsWith("data:image/jpeg;base64,", await server.PreviewAsync(film.Id, revision, 100));
            await Assert.ThrowsAsync<TagException>(() => server.PreviewAsync(film.Id, "stale", 1));
            await Assert.ThrowsAsync<ArgumentException>(() => server.PreviewAsync(film.Id, revision, -1));
            using var cancelled = new CancellationTokenSource();
            cancelled.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
                server.PreviewAsync(film.Id, revision, 1, cancelled.Token)
            );
            Assert.Equal(original, await File.ReadAllBytesAsync(file));
            Assert.Equal(0, (await repo.GetMediaAsync(film.Id)).Position);
            Assert.False(Directory.Exists(Path.Combine(db.DataDirectory, "streams")));
        }
        finally
        {
            Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
            if (Directory.Exists(directory))
                Directory.Delete(directory, true);
        }
    }

    [Fact]
    public void PreviewContractRequiresCatalogIdentityRevisionAndFinitePosition()
    {
        var schema = TagSchemas.Get("playback-preview.schema.json");
        Assert.True(
            schema.Evaluate(JsonNode.Parse("""{"id":"fixture","mediaRevision":"revision","position":1.5}""")).IsValid
        );
        foreach (
            var json in new[]
            {
                """{"path":"C:/unrelated/file","position":1}""",
                """{"id":"fixture","position":1}""",
                """{"id":"fixture","mediaRevision":"revision","position":-1}""",
                """{"id":"fixture","mediaRevision":"revision","position":1,"filter":"arbitrary"}""",
            }
        )
            Assert.False(schema.Evaluate(JsonNode.Parse(json)).IsValid);
    }

    [Fact]
    public void NativeInputRejectsOtherClientsMalformedCoordinatesAndUnregisteredKeys()
    {
        Assert.Null(MpvInput.Parse(JsonNode.Parse("[\"other-client\",\"key\",\"SPACE\"]")));
        Assert.Null(MpvInput.Parse(JsonNode.Parse("[\"vroom-input\",\"key\",\"run\"]")));
        Assert.Null(MpvInput.Parse(JsonNode.Parse("[\"vroom-input\",\"click\",\"NaN\",\"1\",\"100\",\"100\"]")));
        Assert.Null(MpvInput.Parse(JsonNode.Parse("[\"vroom-input\",\"click\",\"1\",\"1\",\"0\",\"100\"]")));
        Assert.Null(MpvInput.Parse(JsonNode.Parse("[\"vroom-input\",\"key\",4]")));
        Assert.Equal(
            new MpvInput("click", "", .5, .5),
            MpvInput.Parse(JsonNode.Parse("[\"vroom-input\",\"click\",\"100\",\"75\",\"200\",\"150\"]"))
        );
    }

    private static async Task<string> Fixture(string directory)
    {
        var subtitle = Path.Combine(directory, "fixture.srt");
        await File.WriteAllTextAsync(subtitle, "1\n00:00:00,000 --> 00:00:10,000\nNative playback fixture\n");
        var chapters = Path.Combine(directory, "chapters.txt");
        await File.WriteAllTextAsync(
            chapters,
            ";FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=5000\ntitle=First\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=5000\nEND=10000\ntitle=Second\n"
        );
        var file = Path.Combine(directory, "fixture.mkv");
        var info = new ProcessStartInfo(Environment.GetEnvironmentVariable("VROOM_TEST_FFMPEG")!)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardError = true,
        };
        foreach (
            var arg in new[]
            {
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=320x180:rate=25",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=880",
                "-i",
                subtitle,
                "-i",
                chapters,
                "-map",
                "0:v",
                "-map",
                "1:a",
                "-map",
                "2:a",
                "-map",
                "3:s",
                "-map_metadata",
                "4",
                "-map_chapters",
                "4",
                "-t",
                "10",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-c:a",
                "aac",
                "-c:s",
                "ass",
                file,
            }
        )
            info.ArgumentList.Add(arg);
        using var process = Process.Start(info)!;
        var errors = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        Assert.True(process.ExitCode == 0, await errors);
        return file;
    }
}

public sealed class NativeMpvFactAttribute : FactAttribute
{
    public NativeMpvFactAttribute()
    {
        if (
            !File.Exists(Environment.GetEnvironmentVariable("VROOM_TEST_MPV"))
            || !File.Exists(Environment.GetEnvironmentVariable("VROOM_TEST_FFMPEG"))
        )
            Skip = "Set VROOM_TEST_MPV and VROOM_TEST_FFMPEG to run real decoder integration tests.";
    }
}
