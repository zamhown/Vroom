using System.Text.Json.Nodes;
using Vroom.Core.Catalog;
using Vroom.Core.Jobs;
using Vroom.Core.Media;
using Vroom.Core.Storage;
using Vroom.Core.Tagging;

namespace Vroom.Tests;

public sealed partial class TaggingTests
{
    private async Task ConfigureFeedbackSource(JsonObject source, bool linked = true)
    {
        var document = await engine.ExportAsync("definitions");
        var changes = new JsonArray();
        // Tests never use installed online sources, even when exercising online permission.
        foreach (var entry in document.Map("sources"))
        {
            var disabled = entry.Value!.DeepClone();
            disabled["enabled"] = false;
            changes.Add(
                new JsonObject
                {
                    ["kind"] = "sources",
                    ["key"] = entry.Key,
                    ["value"] = disabled,
                }
            );
        }
        changes.Add(
            new JsonObject
            {
                ["kind"] = "sources",
                ["key"] = "user.feedback.provider",
                ["value"] = source,
            }
        );
        if (linked)
        {
            var field = Parse(
                """{"key":"user.feedback.note","revision":1,"enabled":true,"label":{"en":"External note"},"parents":[],"targets":["film-whole"],"placements":[],"value":{"cardinality":"one","schema":{"type":"string"},"semanticVersion":1},"input":{"component":"text@1"},"enrichment":[{"id":"review-note","source":"user.feedback.provider","field":"note","apply":"suggest-only"}]}"""
            );
            changes.Add(
                new JsonObject
                {
                    ["kind"] = "definition",
                    ["key"] = field.Text("key"),
                    ["value"] = field,
                }
            );
        }
        var preview = await engine.PreviewConfigAsync(new() { ["changes"] = changes });
        await engine.ApplyConfigAsync(
            new()
            {
                ["previewToken"] = preview["previewToken"]!.DeepClone(),
                ["expectedGeneration"] = preview["generation"]!.DeepClone(),
            }
        );
    }

    private static JsonObject FeedbackSidecar() =>
        Parse(
            """{"label":{"en":"Local review source"},"transport":"sidecar","extension":".review","parse":{"format":"json","fields":{"note":{"pointer":"/note","cardinality":"one"}}}}"""
        );

    [Theory]
    [InlineData(null, "sidecar-unavailable", false)]
    [InlineData("", "sidecar-unavailable", false)]
    [InlineData("{}", "no-values", false)]
    [InlineData("{\"note\":\"Suggested note\"}", "found", true)]
    public async Task EnrichmentReportsMissingEmptyAndUsableSourcesWithoutClaimingSuggestionsWereApplied(
        string? content,
        string status,
        bool found
    )
    {
        await ConfigureFeedbackSource(FeedbackSidecar());
        if (content is not null)
            await File.WriteAllTextAsync(Path.ChangeExtension(film.Path, ".review"), content);
        using var sources = new TagSources(engine);
        var result = await sources.EnrichAsync(film.Id);
        Assert.Equal(found, result.Found);
        var outcome = Assert.Single(result.Sources, s => s.SourceId == "user.feedback.provider");
        Assert.Equal(status, outcome.Status);
        Assert.Equal(found ? 1 : 0, outcome.FieldCount);
        var detail = await engine.FilmAsync(film.Id);
        Assert.Null(detail["film"]!["values"]?["user.feedback.note"]?["value"]);
        Assert.Equal(found ? 1 : 0, detail.List("candidates").Count(c => c.Text("tagKey") == "user.feedback.note"));
    }

    [Theory]
    [InlineData(false, "online-disabled")]
    [InlineData(true, "missing-parameters")]
    public async Task EnrichmentExplainsWhyAnOnlineSourceWasNotQueried(bool online, string status)
    {
        var source = FeedbackSidecar();
        source.Remove("extension");
        source["transport"] = "http";
        source["request"] = Parse(
            """{"urlTemplate":"https://127.0.0.1/should-not-be-requested/{value}","parameters":{"value":{"literal":null}}}"""
        );
        await ConfigureFeedbackSource(source);
        await repo.SaveSettingsAsync((await repo.SettingsAsync()) with { OnlineMetadata = online });
        using var sources = new TagSources(engine);
        var result = await sources.EnrichAsync(film.Id);
        Assert.False(result.Found);
        Assert.Equal(status, Assert.Single(result.Sources, s => s.SourceId == "user.feedback.provider").Status);
    }

    [Theory]
    [InlineData(false, true, "disabled")]
    [InlineData(true, false, "no-rules")]
    public async Task EnrichmentExplainsDisabledAndUnmappedSources(bool enabled, bool linked, string status)
    {
        var source = FeedbackSidecar();
        source["enabled"] = enabled;
        await ConfigureFeedbackSource(source, linked);
        using var sources = new TagSources(engine);
        var result = await sources.EnrichAsync(film.Id);
        Assert.False(result.Found);
        Assert.Equal(status, Assert.Single(result.Sources, s => s.SourceId == "user.feedback.provider").Status);
    }

    [Fact]
    public async Task EnrichmentReadsTheSavedPermissionAgainAfterEachToggle()
    {
        var source = FeedbackSidecar();
        source.Remove("extension");
        source["transport"] = "http";
        source["request"] = Parse(
            """{"urlTemplate":"https://127.0.0.1/never-requested/{value}","parameters":{"value":{"literal":null}}}"""
        );
        await ConfigureFeedbackSource(source);
        using var sources = new TagSources(engine);
        foreach (var online in new[] { false, true, false })
        {
            await repo.PatchSettingsAsync(new() { ["onlineMetadata"] = online });
            var result = await sources.EnrichAsync(film.Id);
            Assert.Equal(
                online ? "missing-parameters" : "online-disabled",
                Assert.Single(result.Sources, s => s.SourceId == "user.feedback.provider").Status
            );
        }
    }

    [Fact]
    public async Task EnrichmentJobPersistsSourceReasonsForTheFilmPageAndTaskCenter()
    {
        await ConfigureFeedbackSource(FeedbackSidecar());
        using var jobs = new JobCoordinator(db);
        using var scanner = new LibraryScanner(repo, new FfmpegService(repo), jobs, engine, new TagSources(engine));
        var id = await jobs.StartAsync(
            "metadata.enrich",
            "host.BackgroundOperations.enrichFilmMetadata",
            new { id = film.Id }
        );
        for (var i = 0; i < 200 && !JobCoordinator.IsTerminal(jobs.Get(id).State); i++)
            await Task.Delay(20);
        var job = jobs.Get(id);
        Assert.Equal(Vroom.Core.Domain.JobState.Completed, job.State);
        var result = JsonNode.Parse(job.ResultJson!)!;
        Assert.False(result.Flag("found"));
        Assert.Equal(
            "sidecar-unavailable",
            Assert.Single(result.List("sources"), s => s.Text("sourceId") == "user.feedback.provider").Text("status")
        );
        var persisted = await db.RunAsync(c =>
        {
            using var command = c.CreateCommand();
            command.CommandText = "SELECT payload FROM background_jobs WHERE id=@id";
            command.Parameters.AddWithValue("@id", id);
            return command.ExecuteScalar()!.ToString();
        });
        Assert.Contains("sidecar-unavailable", persisted);
    }
}
