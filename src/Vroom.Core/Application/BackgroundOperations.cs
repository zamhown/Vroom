using System.Text.Json;
using Vroom.Core.Application;
using Vroom.Core.Catalog;
using Vroom.Core.Domain;
using Vroom.Core.Intelligence;
using Vroom.Core.Jobs;
using Vroom.Core.Media;
using Vroom.Core.Storage;
using Vroom.Core.Tagging;

namespace Vroom.Core.Application;

public sealed class BackgroundOperations
{
    private readonly JobCoordinator jobs;
    private readonly CatalogRepository repository;
    private readonly LibraryScanner scanner;

    public BackgroundOperations(
        JobCoordinator jobs,
        CatalogRepository repository,
        LibraryScanner scanner,
        FfmpegService ffmpeg,
        LocalMediaServer media,
        LocalAgent agent,
        AgentTools tools,
        TagEngine tagging,
        TagSources sources
    )
    {
        this.jobs = jobs;
        this.repository = repository;
        this.scanner = scanner;
        jobs.Register(
            "media.thumbnail",
            async (context, args) =>
            {
                var film = await repository.GetMediaAsync(Id(args), context.CancellationToken);
                var at = args.TryGetProperty("at", out var time) ? time.GetDouble() : 0;
                await context.ReportAsync(0, 1, "host.BackgroundOperations.generatingPreviewFrame");
                await ffmpeg.ThumbnailAsync(film, at, context.CancellationToken);
                await context.ReportAsync(1, 1, "host.BackgroundOperations.previewFrameCached");
                return new { url = media.ThumbnailUrl(film.Id, at) };
            },
            canRetry: true
        );
        jobs.Register(
            "duplicates.find",
            async (context, args) =>
            {
                await context.ReportAsync(0, null, "host.BackgroundOperations.checkingTheFilmIndexAgainstTheSelected");
                var result = await tagging.FindDuplicatesAsync(
                    System.Text.Json.Nodes.JsonNode.Parse(args.GetRawText())!.AsObject(),
                    context.CancellationToken
                );
                await context.ReportAsync(1, 1, "duplicates.completed");
                return result;
            },
            canRetry: true
        );
        jobs.Register(
            "agent.plan",
            async (context, args) =>
            {
                await context.ReportAsync(0, null, "host.BackgroundOperations.runningLocalModelInference");
                return await agent.PlanAsync(args.GetProperty("request").GetString()!, context.CancellationToken);
            },
            canRetry: true
        );
        jobs.Register(
            "agent.execute",
            async (context, args) =>
            {
                var plan = agent.ParsePlan(args.GetRawText());
                await context.ReportAsync(0, 1, UiMessage.Of("host.agent.executing", plan.Tool));
                var result = await tools.ExecuteAsync(plan.Tool, plan.Arguments, true, context.CancellationToken);
                await context.ReportAsync(1, 1, "host.BackgroundOperations.operationCompleted");
                return result;
            }
        );
    }

    public async Task<string> StartAsync(string kind, JsonElement args)
    {
        if (kind == "library.scan")
            return await scanner.StartAsync((await repository.LibrariesAsync()).Single(l => l.Id == Id(args)));
        var name = kind switch
        {
            "media.probe" => "host.BackgroundOperations.readMediaInformation",
            "media.thumbnail" => "host.BackgroundOperations.generatePreviewFrame",
            "metadata.enrich" => "host.BackgroundOperations.enrichFilmMetadata",
            "duplicates.find" => "host.BackgroundOperations.findDuplicates",
            "agent.plan" => "host.BackgroundOperations.localAssistantPlanAction",
            "agent.execute" => "host.BackgroundOperations.localAssistantRunAction",
            _ => throw new ArgumentException("host.BackgroundOperations.unsupportedBackgroundTask"),
        };
        return await jobs.StartAsync(
            kind,
            name,
            args,
            kind == "media.probe"
                    ? "probe:" + Id(args) + ":" + (args.TryGetProperty("partId", out var part) ? part.GetString() : "")
                : kind == "metadata.enrich"
                    ? "enrich:"
                        + (args.TryGetProperty("subjectKind", out var kindValue) ? kindValue.GetString() : "film")
                        + ":"
                        + Id(args)
                : null
        );
    }

    private static string Id(JsonElement args) =>
        args.GetProperty("id").GetString() ?? throw new ArgumentException("host.BackgroundOperations.missingId");
}
