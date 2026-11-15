using System.Text.Json;
using System.Text.Json.Nodes;
using Vroom.Core.Domain;
using Vroom.Core.Jobs;
using Vroom.Core.Media;
using Vroom.Core.Storage;
using Vroom.Core.Tagging;

namespace Vroom.Tests;

internal static class ExportTestRuntime
{
    internal static string HandBrake =>
        Environment.GetEnvironmentVariable("VROOM_TEST_HANDBRAKE")
        ?? Path.Combine(HandBrakeProtocolTests.Root(), "runtime", "handbrake", Executable("HandBrakeCLI"));

    internal static string Ffmpeg =>
        Environment.GetEnvironmentVariable("VROOM_TEST_FFMPEG")
        ?? Path.Combine(HandBrakeProtocolTests.Root(), "runtime", "ffmpeg", Executable("ffmpeg"));

    internal static string Ffprobe =>
        Environment.GetEnvironmentVariable("VROOM_TEST_FFPROBE")
        ?? Path.Combine(HandBrakeProtocolTests.Root(), "runtime", "ffmpeg", Executable("ffprobe"));

    private static string Executable(string name) => OperatingSystem.IsWindows() ? name + ".exe" : name;
}

public sealed class HandBrakeFactAttribute : FactAttribute
{
    public HandBrakeFactAttribute()
    {
        if (
            !File.Exists(ExportTestRuntime.HandBrake)
            || !File.Exists(ExportTestRuntime.Ffmpeg)
            || !File.Exists(ExportTestRuntime.Ffprobe)
        )
            Skip =
                "Install the desktop media runtime or set VROOM_TEST_HANDBRAKE, VROOM_TEST_FFMPEG and VROOM_TEST_FFPROBE.";
    }
}

// Real HandBrake encodes measure pause/cancel timing; running them beside the rest of the suite made them flaky.
[CollectionDefinition("RealEncoder", DisableParallelization = true)]
public sealed class RealEncoderCollection;

[Collection("RealEncoder")]
public sealed class VideoExportTests
{
    [HandBrakeFact]
    public async Task SettingsSummaryResolvesRealOverridesAndRejectsHostManagedPaths()
    {
        var directory = Path.Combine(Path.GetTempPath(), "vroom-exports", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            using var db = new CatalogDatabase(directory);
            var repository = new CatalogRepository(db);
            await repository.SaveSettingsAsync(new() { HandBrakePath = ExportTestRuntime.HandBrake });
            await using var jobs = new JobCoordinator(db);
            var exports = new VideoExportService(repository, new(repository), new(repository), new(repository), jobs);
            var settings = new
            {
                presetName = "Fast 1080p30",
                options = new Dictionary<string, string?>
                {
                    ["quality"] = "17",
                    ["format"] = "av_mkv",
                    ["encoder-preset"] = "slow",
                },
            };
            var resolved = Assert.IsType<JsonObject>(
                await exports.DispatchAsync("export.preset.resolve", JsonSerializer.SerializeToElement(settings))
            );
            var preset = resolved["PresetList"]![0]!;
            Assert.Equal(17, preset["VideoQualitySlider"]!.GetValue<double>());
            Assert.Equal("av_mkv", preset["FileFormat"]!.GetValue<string>());
            Assert.Equal("slow", preset["VideoPreset"]!.GetValue<string>());
            await Assert.ThrowsAsync<ArgumentException>(() =>
                exports.DispatchAsync(
                    "export.preset.resolve",
                    JsonSerializer.SerializeToElement(
                        new { presetName = "Fast 1080p30", options = new { output = "forbidden.mp4" } }
                    )
                )
            );
            Assert.Empty(jobs.Jobs);
        }
        finally
        {
            Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
            Directory.Delete(directory, true);
        }
    }

    [HandBrakeFact]
    public async Task RealCancellationPauseRecoveryAndPreparedOutputRecoveryPreserveFiles()
    {
        var directory = Path.Combine(Path.GetTempPath(), "vroom-exports", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            using var db = new CatalogDatabase(Path.Combine(directory, "catalog"));
            var repository = new CatalogRepository(db);
            var ffmpeg = ExportTestRuntime.Ffmpeg;
            await repository.SaveSettingsAsync(
                new()
                {
                    HandBrakePath = ExportTestRuntime.HandBrake,
                    FfmpegPath = ffmpeg,
                    FfprobePath = ExportTestRuntime.Ffprobe,
                }
            );
            var source = Path.Combine(directory, "source.mp4");
            var output = Path.Combine(directory, "finished.mp4");
            await FfmpegService.CaptureAsync(
                ffmpeg,
                [
                    "-v",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc2=size=640x360:rate=24",
                    "-t",
                    "6",
                    "-c:v",
                    "libx264",
                    source,
                ],
                TimeSpan.FromSeconds(30),
                default
            );
            string id;
            await using (var jobs = new JobCoordinator(db))
            {
                var exports = new VideoExportService(
                    repository,
                    new(repository),
                    new(repository),
                    new(repository),
                    jobs
                );
                var preview = await exports.PreviewAsync(
                    new(
                        [new(output, SourcePath: source)],
                        "Fast 1080p30",
                        new()
                        {
                            ["encoder"] = "x264",
                            ["encoder-preset"] = "veryslow",
                            ["audio"] = "none",
                        }
                    )
                );
                await exports.CommitAsync(preview.PreviewToken);
                id = preview.Targets[0].JobId;
                await Until(() => jobs.Get(id).Telemetry?.Phase == "WORKING");
                await jobs.PauseAsync(id);
                await Until(() =>
                {
                    var state = jobs.Get(id);
                    Assert.False(JobCoordinator.IsTerminal(state.State), JsonSerializer.Serialize(state));
                    return state.State == JobState.Paused;
                });
                Assert.False(File.Exists(output));
                Assert.Empty(Directory.GetFiles(directory, "output.mp4", SearchOption.AllDirectories));
                await jobs.ResumeAsync(id);
                await Until(() => jobs.Get(id).State == JobState.Running && jobs.Get(id).Telemetry?.Phase == "WORKING");
                await jobs.StopAsync(id);
                var stopped = await jobs.WaitAsync(id);
                Assert.True(stopped.State == JobState.Cancelled, JsonSerializer.Serialize(stopped));
                Assert.False(File.Exists(output));
            }
            JobInfo completed;
            await using (var recovered = new JobCoordinator(db))
            {
                _ = new VideoExportService(repository, new(repository), new(repository), new(repository), recovered);
                await recovered.InitializeAsync();
                Assert.Equal(JobState.Cancelled, recovered.Get(id).State);
                await recovered.ResumeAsync(id);
                completed = await recovered.WaitAsync(id);
                Assert.True(completed.State == JobState.Completed, completed.Error);
                Assert.Equal(3, completed.Attempt);
            }
            // Simulate a crash after atomic rename but before the final job state was persisted.
            var stamp = VideoExportService.Stamp(output);
            var interrupted = completed with { State = JobState.Interrupted, ResultJson = null };
            await db.RunAsync(connection =>
            {
                using var command = connection.CreateCommand();
                command.CommandText = "UPDATE background_jobs SET state=8,payload=@payload WHERE id=@id";
                command.Parameters.AddWithValue(
                    "@payload",
                    JsonSerializer.Serialize(interrupted, new JsonSerializerOptions(JsonSerializerDefaults.Web))
                );
                command.Parameters.AddWithValue("@id", id);
                command.ExecuteNonQuery();
            });
            await using (var recovered = new JobCoordinator(db))
            {
                _ = new VideoExportService(repository, new(repository), new(repository), new(repository), recovered);
                await recovered.InitializeAsync();
                await recovered.ResumeAsync(id);
                var result = await recovered.WaitAsync(id);
                Assert.Equal(JobState.Completed, result.State);
                Assert.Equal(stamp, VideoExportService.Stamp(output));
                Assert.Contains("sha256", result.ResultJson);
            }
        }
        finally
        {
            Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
            Directory.Delete(directory, true);
        }
    }

    private static async Task Until(Func<bool> condition)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        while (!condition())
            await Task.Delay(10, timeout.Token);
    }

    [HandBrakeFact]
    public async Task RealEngineScansEncodesFourContainersAndRejectsConflicts()
    {
        var directory = Path.Combine(Path.GetTempPath(), "vroom-exports", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            using var db = new CatalogDatabase(Path.Combine(directory, "catalog"));
            var repository = new CatalogRepository(db);
            var ffmpeg = ExportTestRuntime.Ffmpeg;
            var ffprobe = ExportTestRuntime.Ffprobe;
            await repository.SaveSettingsAsync(
                new()
                {
                    HandBrakePath = ExportTestRuntime.HandBrake,
                    FfmpegPath = ffmpeg,
                    FfprobePath = ffprobe,
                }
            );
            var source = Path.Combine(directory, "测试 source.mp4");
            await FfmpegService.CaptureAsync(
                ffmpeg,
                [
                    "-v",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc2=size=320x180:rate=24",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=440:sample_rate=48000",
                    "-t",
                    "2",
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "aac",
                    source,
                ],
                TimeSpan.FromSeconds(30),
                default
            );
            var original = VideoExportService.Stamp(source);
            var subtitle = Path.Combine(directory, "外部 subtitle.srt");
            await File.WriteAllTextAsync(subtitle, "1\n00:00:00,000 --> 00:00:01,800\nTest subtitle\n");
            var engine = new HandBrakeService(repository);
            var tags = new TagEngine(repository);
            await repository.SaveLibraryAsync(new("fixture", "Fixture", [], []));
            var work = await repository.ImportMediaAsync(
                new()
                {
                    LibraryId = "fixture",
                    Path = source,
                    Size = new FileInfo(source).Length,
                    Modified = File.GetLastWriteTimeUtc(source),
                }
            );
            var alternate = Path.Combine(directory, "alternate.mp4");
            File.Copy(source, alternate);
            var structure = await repository.AddVersionAsync(work.Id, 1, "Another version", [alternate]);
            await using var jobs = new JobCoordinator(db);
            var exports = new VideoExportService(repository, tags, engine, new(repository), jobs);
            var capabilities = await engine.DescribeAsync();
            Assert.Contains(capabilities.Presets, p => p.Name == "Fast 1080p30");
            var scan = await jobs.WaitAsync(await exports.StartScanAsync(null, source));
            Assert.Equal(JobState.Completed, scan.State);
            Assert.Contains("TitleList", scan.ResultJson);
            Assert.Contains("AudioList", scan.ResultJson);
            foreach (
                var (format, codec) in new[] { ("mp4", "x264"), ("mkv", "x264"), ("webm", "VP9"), ("mov", "x264") }
            )
            {
                var output = Path.Combine(directory, "output." + format);
                var request = new ExportRequest(
                    [new(output, SourcePath: source)],
                    "Fast 1080p30",
                    new()
                    {
                        ["format"] = "av_" + format,
                        ["encoder"] = codec,
                        ["audio"] = "none",
                        ["width"] = "320",
                        ["height"] = "180",
                        ["crop"] = "0:0:0:0",
                    }
                );
                if (format == "mp4")
                {
                    request = request with { Targets = [new(output, FilmId: work.Id, PartId: work.PartId)] };
                    request.Options["audio"] = "1,1";
                    request.Options["aencoder"] = "av_aac,ac3";
                    request.Options["srt-file"] = subtitle;
                    request.Options["srt-codeset"] = "UTF-8";
                    request.Options["srt-lang"] = "eng";
                }
                var preview = await exports.PreviewAsync(request);
                if (format == "mp4")
                {
                    Assert.Equal(work.PartId, preview.Targets[0].PartId);
                    Assert.NotNull(FileIdentity.Read(source));
                    Assert.Equal(FileIdentity.Read(source), FileIdentity.Read(preview.Targets[0].Source.Path));
                    await repository.ChangeResourcesAsync(
                        work.Id,
                        structure.Revision,
                        "select-part",
                        structure.Versions.Last().Parts[0].Id
                    );
                    Assert.Equal(alternate, (await repository.GetMediaAsync(work.Id)).Path);
                }
                await exports.CommitAsync(preview.PreviewToken);
                await exports.CommitAsync(preview.PreviewToken);
                var result = await jobs.WaitAsync(preview.Targets[0].JobId);
                Assert.True(result.State == JobState.Completed, result.Error ?? result.Detail);
                Assert.True(File.Exists(output));
                Assert.NotNull(result.CheckpointJson);
                Assert.Single(jobs.Jobs, j => j.Id == result.Id);
                var facts = await new FfmpegService(repository).ProbeAsync(output);
                Assert.Equal(320, facts.Width);
                Assert.InRange(facts.Duration, 1.8, 2.3);
                if (format == "mp4")
                {
                    var streams = await FfmpegService.CaptureAsync(
                        ffprobe,
                        ["-v", "error", "-show_streams", "-of", "json", output],
                        TimeSpan.FromSeconds(20),
                        default
                    );
                    using var parsed = JsonDocument.Parse(streams);
                    Assert.Equal(
                        2,
                        parsed
                            .RootElement.GetProperty("streams")
                            .EnumerateArray()
                            .Count(s => s.GetProperty("codec_type").GetString() == "audio")
                    );
                    Assert.Contains(
                        parsed.RootElement.GetProperty("streams").EnumerateArray(),
                        s => s.GetProperty("codec_type").GetString() == "subtitle"
                    );
                }
                await Assert.ThrowsAsync<IOException>(() => exports.PreviewAsync(request));
                await exports.CommitAsync(preview.PreviewToken); // Replaying a commit keeps the completed identity.
                Assert.Equal(1, jobs.Get(result.Id).Attempt);
            }
            Assert.Equal(original, VideoExportService.Stamp(source));
            // Revision conflict after a reviewed preview must not overwrite or start encoding.
            var conflict = await exports.PreviewAsync(
                new([new(Path.Combine(directory, "conflict.mp4"), SourcePath: source)], "Fast 1080p30", new())
            );
            File.SetLastWriteTimeUtc(source, File.GetLastWriteTimeUtc(source).AddSeconds(2));
            var commit = JsonSerializer.Serialize(await exports.CommitAsync(conflict.PreviewToken));
            var rejected = JsonNode.Parse(commit)!["conflicts"]!.AsArray().Single()!;
            Assert.Equal("host.export.sourceChanged", rejected["error"]!.GetValue<string>());
            Assert.Equal(
                FileIdentity.Read(source),
                FileIdentity.Read(rejected["errorArgs"]!["p0"]!.GetValue<string>())
            );
            Assert.DoesNotContain(jobs.Jobs, j => j.Id == conflict.Targets[0].JobId);
        }
        finally
        {
            Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
            Directory.Delete(directory, true);
        }
    }
}
