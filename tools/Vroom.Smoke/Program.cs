using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.DependencyInjection;
using Vroom.Core;
using Vroom.Core.Catalog;
using Vroom.Core.Domain;
using Vroom.Core.Intelligence;
using Vroom.Core.Jobs;
using Vroom.Core.Media;
using Vroom.Core.Storage;
using Vroom.Core.Tagging;

var root = Path.GetFullPath(args.FirstOrDefault(a => !a.StartsWith("--")) ?? Environment.CurrentDirectory);
if (args.Contains("--tag-benchmark"))
{
    await TagBenchmark.RunAsync(root);
    return;
}
var runtime = Path.Combine(root, "runtime");
var data = Path.GetFullPath(
    args.FirstOrDefault(a => a.StartsWith("--data="))?[7..] ?? Path.Combine(root, "artifacts", "smoke-data")
);
var mediaDir = Path.Combine(root, "artifacts", "smoke-media");
Directory.CreateDirectory(mediaDir);
await using var services = new ServiceCollection().AddVroom(data).BuildServiceProvider();
await services.InitializeVroomAsync(runtime);
var tagging = services.GetRequiredService<TagEngine>();
var repo = services.GetRequiredService<CatalogRepository>();
var media = services.GetRequiredService<LocalMediaServer>();
var ffmpeg = services.GetRequiredService<FfmpegService>();
var settings = await repo.SettingsAsync();
using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(5));
var ct = timeout.Token;
if (args.Contains("--playback-benchmark"))
{
    await PlaybackBenchmark.RunAsync(root, services, ct);
    return;
}
if (!args.Contains("--model-only"))
{
    var colors = new[] { "0x405847", "0x485a70", "0x795d46", "0x52573d", "0x534759", "0x34595c" };
    var titles = new[]
    {
        "Forest study",
        "Blue hour",
        "Quiet afternoon",
        "Mountain air",
        "Evening notes",
        "Ocean light",
    };
    for (var i = 0; i < 6; i++)
    {
        var path = Path.Combine(mediaDir, $"DEMO-{i + 1:000} {titles[i]}.mp4");
        if (File.Exists(path))
            continue;
        await FfmpegService.CaptureAsync(
            MediaRuntime.Ffmpeg(settings),
            [
                "-v",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                $"color=c={colors[i]}:s=960x540:r=24:d=20",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=44100:duration=20",
                "-vf",
                "drawgrid=w=80:h=80:t=1:c=white@0.12",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-movflags",
                "+faststart",
                "-shortest",
                path,
            ],
            TimeSpan.FromSeconds(45),
            ct
        );
    }
    var first = Directory.GetFiles(mediaDir, "*.mp4").Order().First();
    var duplicate = Path.Combine(mediaDir, "DEMO-001 alternate.mkv");
    if (!File.Exists(duplicate))
        await FfmpegService.CaptureAsync(
            MediaRuntime.Ffmpeg(settings),
            ["-v", "error", "-y", "-i", first, "-c", "copy", duplicate],
            TimeSpan.FromSeconds(30),
            ct
        );
    var nfo = Path.ChangeExtension(first, ".nfo");
    await File.WriteAllTextAsync(
        nfo,
        "<movie><id>DEMO-001</id><title>林间习作 · Forest study</title><actor><name>Demo Creator</name></actor><tag>演示素材</tag><plot>由 FFmpeg 生成的无人物测试视频，用于验证扫描与播放。</plot></movie>",
        ct
    );
    var lib = new Library("smoke", "演示资料馆", [mediaDir], [], true, true);
    await repo.SaveLibraryAsync(lib, ct);
    await services
        .GetRequiredService<LibraryScanner>()
        .ScanAsync(
            lib,
            new InlineProgress<(int Count, string Detail)>(p => Console.WriteLine($"SCAN {p.Count} {p.Detail}")),
            ct
        );
    var result = await tagging.QueryAsync(new JsonObject { ["libraryId"] = lib.Id, ["limit"] = 100 }, ct);
    if (result.Number("total") != 7)
        throw new Exception($"Expected 7 demo films; got {result.Number("total")}");
    foreach (var film in result.List("films"))
    {
        var writes = new JsonArray();
        var code = film?["values"]?["core.code"]?.Text("value");
        foreach (
            var (key, value) in new (string, JsonNode)[]
            {
                ("core.favorite", JsonValue.Create(code is "DEMO-001" or "DEMO-003")!),
                ("core.rating", JsonValue.Create(code == "DEMO-001" ? 10 : 6)!),
            }
        )
            writes.Add(
                new JsonObject
                {
                    ["subject"] = new JsonObject { ["kind"] = "film", ["id"] = film.Text("id") },
                    ["tagKey"] = key,
                    ["value"] = value,
                    ["expectedRevision"] = film?["values"]?[key]?.Number("revision") ?? 0,
                }
            );
        await tagging.BatchAsync(
            new JsonObject
            {
                ["expectedGeneration"] = (await tagging.SnapshotAsync(ct))["generation"].Copy(),
                ["writes"] = writes,
            },
            ct: ct
        );
    }
    var selected = await repo.GetMediaAsync(result.List("films").First(f => f.Text("path") == first).Text("id"), ct);
    var stream = await media.OpenAsync(selected.Id, false, 0, ct);
    using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
    using var request = new HttpRequestMessage(HttpMethod.Get, stream.Url);
    request.Headers.Range = new(0, 99);
    using var response = await client.SendAsync(request, ct);
    if (
        response.StatusCode != HttpStatusCode.PartialContent
        || (await response.Content.ReadAsByteArrayAsync(ct)).Length != 100
    )
        throw new Exception("Range failed");
    using var forbidden = await client.GetAsync(
        new Uri(stream.Url).GetLeftPart(UriPartial.Authority) + "/media/" + selected.Id,
        ct
    );
    if (forbidden.StatusCode != HttpStatusCode.Forbidden)
        throw new Exception("Capability guard failed");
    Console.WriteLine("PASS Range and capability authorization");
    var transcoded = await media.OpenAsync(selected.Id, true, 5, ct);
    var playlist = await client.GetStringAsync(transcoded.Url, ct);
    if (!playlist.Contains("#EXTM3U"))
        throw new Exception("HLS failed");
    var segment = playlist.Split('\n').First(x => x.Trim().EndsWith(".ts")).Trim();
    using var ts = await client.GetAsync(new Uri(new Uri(transcoded.Url), segment), ct);
    if (!ts.IsSuccessStatusCode || ts.Content.Headers.ContentLength < 100)
        throw new Exception("HLS segment failed");
    await media.StopPlaybackAsync(transcoded.SessionId);
    Console.WriteLine("PASS FFmpeg HLS seek at 5s, segment streaming, session cleanup");
    var duplicates = JsonSerializer
        .SerializeToNode(await tagging.FindDuplicatesAsync(new JsonObject { ["libraryId"] = lib.Id }, ct))!
        .AsArray();
    if (duplicates.Count != 1)
        throw new Exception("Dedup failed");
    var definition = JsonNode.Parse(
        """{"key":"smoke.segment","revision":1,"enabled":true,"label":{"en":"Segment"},"parents":[],"targets":["film-interval"],"value":{"cardinality":"one","semanticVersion":1,"schema":{"type":"boolean"}},"input":{"component":"toggle@1"},"placements":[]}"""
    )!;
    var preview = await tagging.PreviewConfigAsync(
        new JsonObject
        {
            ["changes"] = new JsonArray(
                new JsonObject
                {
                    ["kind"] = "definition",
                    ["key"] = "smoke.segment",
                    ["value"] = definition,
                }
            ),
        },
        ct
    );
    await tagging.ApplyConfigAsync(new JsonObject { ["previewToken"] = preview["previewToken"].Copy() }, ct);
    await tagging.BatchAsync(
        new JsonObject
        {
            ["expectedGeneration"] = (await tagging.SnapshotAsync(ct))["generation"].Copy(),
            ["writes"] = new JsonArray(
                new JsonObject
                {
                    ["subject"] = new JsonObject { ["kind"] = "film", ["id"] = selected.Id },
                    ["scope"] = new JsonObject
                    {
                        ["kind"] = "interval",
                        ["scopeId"] = Guid.NewGuid().ToString("N"),
                        ["startUs"] = "2000000",
                        ["endUs"] = "6000000",
                    },
                    ["tagKey"] = "smoke.segment",
                    ["value"] = true,
                    ["expectedRevision"] = 0,
                }
            ),
        },
        ct: ct
    );
    await tagging.SaveViewAsync(
        JsonNode
            .Parse(
                """{"id":"favorites","name":"精选收藏","query":{"where":{"op":"eq","tag":"core.favorite","value":true},"sort":"core.rating"}}"""
            )!
            .AsObject(),
        ct
    );
    var detail = await tagging.FilmAsync(selected.Id, ct);
    if (!detail["film"]!["presentation"].Text("title").Contains("Forest study"))
        throw new Exception("NFO title missing");
    Console.WriteLine("PASS scan, NFO, media probe, tags, duplicates, annotation, saved view");
}
var tools = services.GetRequiredService<AgentTools>();
using var argsJson = JsonDocument.Parse("{\"name\":\"no mutation\"}");
try
{
    await tools.ExecuteAsync("annotations.batch", argsJson.RootElement, false, ct);
    throw new Exception("Mutation unexpectedly allowed");
}
catch (InvalidOperationException) { }
Console.WriteLine($"PASS {tools.Definitions.Count} tools registered, mutation review boundary enforced");
if (!args.Contains("--skip-model"))
{
    var model = services.GetRequiredService<ILocalModel>();
    var answer = await model.CompleteJsonAsync(
        "Return a JSON object with a key named ok and boolean value true. Nothing else.",
        "输出 JSON",
        ct
    );
    using var parsed = JsonDocument.Parse(answer);
    if (!parsed.RootElement.GetProperty("ok").GetBoolean())
        throw new Exception("Model output failed");
    Console.WriteLine("PASS real local Qwen inference: " + answer);
    var plan = await services.GetRequiredService<LocalAgent>().PlanAsync("列出所有影片库", ct);
    if (plan.Tool != "library.list")
        throw new Exception("Agent selected unexpected tool: " + plan.Tool);
    var r = await tools.ExecuteAsync(plan.Tool, plan.Arguments, false, ct);
    Console.WriteLine("PASS natural-language agent selected and ran " + r.Tool);
}
Console.WriteLine("ALL SMOKE CHECKS PASSED");
