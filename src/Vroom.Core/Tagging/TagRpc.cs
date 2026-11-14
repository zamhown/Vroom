using System.Text.Json.Nodes;

namespace Vroom.Core.Tagging;

public sealed class TagRpc(TagEngine engine, TagJobs jobs)
{
    public static readonly string[] Methods =
    [
        "activity.list",
        "metadata.bulk.preview",
        "metadata.bulk.commit",
        "metadata.bulk.status",
        "automation.preview",
        "automation.prepare",
        "automation.commit",
        "films.ids",
        "terms.query",
        "terms.get",
        "terms.put",
        "assets.import",
        "knowledge.list",
        "knowledge.read",
        "schema.get",
        "capabilities.describe",
        "definitions.snapshot",
        "definitions.get",
        "config.get",
        "config.preview",
        "config.apply",
        "annotations.get",
        "annotations.batch",
        "annotations.history",
        "annotations.bulk.preview",
        "annotations.bulk.commit",
        "annotations.bulk.status",
        "tag.options.query",
        "tag.options.create",
        "candidates.resolve",
        "issues.list",
        "events.subscribe",
        "events.resume",
        "exchange.export",
        "exchange.preview",
        "exchange.commit",
        "films.query",
        "duplicates.query",
        "duplicates.apply",
    ];

    public static bool Handles(string method) => Methods.Contains(method);

    public async Task<object?> DispatchAsync(
        string method,
        JsonObject args,
        CancellationToken ct = default,
        string origin = "manual"
    ) =>
        method switch
        {
            "activity.list" => await engine.ActivityAsync(args, ct),
            "metadata.bulk.preview" => await engine.PreviewEnrichmentAsync(args, ct),
            "metadata.bulk.commit" => await jobs.StartEnrichmentAsync(args.Text("previewToken")),
            "metadata.bulk.status" => await engine.EnrichmentStatusAsync(args.Text("previewToken"), ct),
            "automation.preview" => await engine.PreviewAutomationAsync(args, ct),
            "automation.prepare" => await jobs.PrepareAutomationAsync(args, ct),
            "automation.commit" => await jobs.StartAutomationAsync(args.Text("previewToken")),
            "films.ids" => await engine.QueryIdsAsync(args, ct),
            "terms.query" => await engine.QueryTermsAsync(args, ct),
            "terms.get" => await engine.GetTermAsync(args.Text("id"), ct),
            "terms.put" => await engine.PutTermAsync(args, ct),
            "assets.import" => await engine.ImportAssetAsync(args, ct),
            "knowledge.list" => TagResources.Names.Select(n => new
            {
                name = n,
                bytes = System.Text.Encoding.UTF8.GetByteCount(TagResources.Read(n)),
            }),
            "knowledge.read" => TagResources.Slice(
                args.Text("resource", "KNOWLEDGE.md"),
                (int)args.Number("offset"),
                (int)args.Number("limit", 12000)
            ),
            "schema.get" => args["kind"] is not null
                ? SchemaKnowledge.Fragment(args.Text("kind"))
                : TagResources.Json(args.Text("resource", "tag-definition.schema.json")),
            "capabilities.describe" => new
            {
                manifest = TagResources.Json("host-capabilities.json"),
                commands = Methods,
                knowledge = TagResources.Names,
                components = CapabilityContract.Registry.Map("components").Select(c => c.Key),
            },
            "definitions.snapshot" => await engine.SnapshotAsync(ct),
            "definitions.get" or "config.get" => await engine.GetConfigAsync(args, ct),
            "config.preview" => await engine.PreviewConfigAsync(args, ct),
            "config.apply" => new { jobId = await jobs.StartConfigAsync(args) },
            "annotations.get" => await engine.AnnotationsAsync(args, ct),
            "annotations.batch" => await engine.BatchAsync(args, origin, ct),
            "annotations.history" => await engine.HistoryAsync(args.Text("id"), ct),
            "annotations.bulk.preview" => await engine.PreviewBulkAsync(args, ct),
            "annotations.bulk.commit" => await jobs.StartBulkAsync(args.Text("previewToken")),
            "annotations.bulk.status" => await engine.BulkStatusAsync(args.Text("previewToken"), ct),
            "tag.options.query" => await engine.OptionsAsync(args, ct),
            "tag.options.create" => await engine.CreateOptionAsync(args, ct),
            "candidates.resolve" => await engine.ResolveCandidateAsync(args, ct),
            "issues.list" => await engine.IssuesAsync(ct),
            "events.subscribe" or "events.resume" => await engine.EventsAsync((long)args.Number("cursor"), ct),
            "exchange.export" => await engine.ExportAsync(args.Text("kind", "bundle"), args.Flag("archive"), ct),
            "exchange.preview" => await engine.PreviewImportAsync(args, ct),
            "exchange.commit" => await engine.CommitImportAsync(args, ct),
            "films.query" => await engine.QueryAsync(args, ct),
            "duplicates.query" => await engine.FindDuplicatesAsync(args, ct),
            "duplicates.apply" => await engine.ResolveDuplicatesAsync(args, ct),
            _ => throw new TagException("METHOD_UNAVAILABLE"),
        };
}
