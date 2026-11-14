using System.Text.Json;
using System.Text.Json.Nodes;
using Vroom.Core.Application;
using Vroom.Core.Catalog;
using Vroom.Core.Domain;
using Vroom.Core.Jobs;
using Vroom.Core.Media;
using Vroom.Core.Storage;
using Vroom.Core.Tagging;

namespace Vroom.Core.Intelligence;

public sealed record ToolDefinition(string Name, JsonNode Description, string Arguments, bool Mutates);

public sealed record AgentPlan(
    string Id,
    string Tool,
    JsonElement Arguments,
    bool NeedsReview,
    JsonNode Description,
    JsonNode? Preview = null
);

public sealed record ToolResult(string Tool, string Json);

public sealed class AgentTools
{
    private readonly CatalogRepository repository;
    private readonly TagEngine tagging;
    private readonly Dictionary<
        string,
        (ToolDefinition Definition, Func<JsonElement, CancellationToken, Task<object?>> Handler)
    > tools = [];
    public IReadOnlyList<ToolDefinition> Definitions => tools.Values.Select(x => x.Definition).ToArray();

    public AgentTools(
        CatalogRepository repository,
        LibraryScanner scanner,
        JobCoordinator jobs,
        LocalMediaServer media,
        TagEngine tagging,
        TagRpc rpc,
        TagSources sources,
        TagJobs tagJobs,
        VideoExportService? exports = null,
        MediaIdentity? mediaIdentity = null
    )
    {
        this.repository = repository;
        this.tagging = tagging;
        if (exports is not null)
            foreach (var item in TagResources.Json("media-export.json")["tools"]!.AsArray())
            {
                var name = item.Text("name");
                Add(
                    name,
                    item!["description"]!,
                    item.Text("arguments"),
                    item.Flag("mutates"),
                    (args, ct) => exports.DispatchAsync(name, args, ct)
                );
            }
        foreach (var item in JsonNode.Parse(TagResources.Read("tools.json"))!.AsArray())
        {
            var name = item.Text("name");
            Add(
                name,
                item!["description"]!,
                item.Text("arguments"),
                item.Flag("mutates"),
                (args, ct) => rpc.DispatchAsync(name, JsonNode.Parse(args.GetRawText())!.AsObject(), ct, "agent")
            );
        }
        Add(
            "library.list",
            "host.AgentTools.listLibraries",
            "{}",
            false,
            async (_, ct) => await repository.LibrariesAsync(ct)
        );
        Add(
            "library.import",
            "host.AgentTools.importMedia",
            "{kind:'files'|'folder',paths:string[],name?:string,libraryId?:string,excludes?:string[],autoEnrich?:boolean,probeOnScan?:boolean}",
            true,
            async (a, ct) => await scanner.ImportAsync(JsonNode.Parse(a.GetRawText())!.AsObject(), ct)
        );
        Add(
            "library.save",
            "host.AgentTools.createOrUpdateALibrary",
            "{id?:string,name:string,roots:string[],excludes?:string[]}",
            true,
            async (a, ct) =>
            {
                await repository.SaveLibraryAsync(
                    new(
                        Optional(a, "id") ?? Guid.NewGuid().ToString("N"),
                        Str(a, "name"),
                        Strings(a, "roots"),
                        Strings(a, "excludes")
                    ),
                    ct
                );
                return true;
            }
        );
        Add(
            "library.remove",
            "host.AgentTools.removeIndexedRecordsKeepingSourceFiles",
            "{id:string}",
            true,
            async (a, ct) => await this.tagging.RemoveLibraryAsync(Str(a, "id"), ct)
        );
        Add(
            "library.scan",
            "host.AgentTools.scanALibrary",
            "{id:string}",
            true,
            async (a, ct) =>
                await scanner.StartAsync((await repository.LibrariesAsync(ct)).Single(l => l.Id == Str(a, "id")))
        );
        Add(
            "film.get",
            "host.AgentTools.readMediaAndEffectiveAnnotations",
            "{id:string,partId?:string}",
            false,
            async (a, ct) => await this.tagging.FilmAsync(Str(a, "id"), ct, partId: Optional(a, "partId"))
        );
        Add(
            "media.resources.get",
            "host.AgentTools.readMediaResources",
            "{filmId:string}",
            false,
            async (a, ct) => await repository.ResourcesAsync(Str(a, "filmId"), ct)
        );
        if (mediaIdentity is not null)
        {
            Add(
                "media.identity.prepare",
                "host.MediaIdentity.identifying",
                "{filmId:string,fileId:string}",
                true,
                async (a, _) => new { jobId = await mediaIdentity.IdentifyAsync(Str(a, "filmId"), Str(a, "fileId")) }
            );
            Add(
                "media.identity.preview",
                "host.MediaIdentity.verifying",
                "{filmId:string,fileId:string,revision:integer,path:string}",
                false,
                async (a, _) =>
                    new
                    {
                        jobId = await mediaIdentity.PreviewAsync(
                            Str(a, "filmId"),
                            Str(a, "fileId"),
                            a.GetProperty("revision").GetInt64(),
                            Str(a, "path")
                        ),
                    }
            );
            Add(
                "media.identity.commit",
                "host.MediaIdentity.relinking",
                "{previewToken:string}",
                true,
                async (a, _) => new { jobId = await mediaIdentity.CommitAsync(Str(a, "previewToken")) }
            );
        }
        Add(
            "metadata.enrich",
            "host.AgentTools.runEnrichmentRulesFromDefinitions",
            "{id:string,subjectKind?:'film'|'term'}",
            true,
            async (a, ct) => await sources.EnrichSubjectAsync(Optional(a, "subjectKind") ?? "film", Str(a, "id"), ct)
        );
        Add(
            "view.list",
            "host.AgentTools.listSmartLists",
            "{}",
            false,
            async (_, ct) => await repository.ViewsAsync(ct)
        );
        Add(
            "view.delete",
            "host.AgentTools.deleteASmartList",
            "{id:string}",
            true,
            async (a, ct) =>
            {
                await repository.DeleteViewAsync(Str(a, "id"), ct);
                return true;
            }
        );
        Add(
            "view.save",
            "host.AgentTools.saveASmartList",
            "{id:string,name:string,query:object}",
            true,
            async (a, ct) =>
            {
                await this.tagging.SaveViewAsync(JsonNode.Parse(a.GetRawText())!.AsObject(), ct);
                return true;
            }
        );
        Add(
            "jobs.list",
            "host.AgentTools.listBackgroundTasks",
            "{}",
            false,
            (_, _) => Task.FromResult<object?>(jobs.Jobs)
        );
        Add(
            "jobs.get",
            "host.AgentTools.readTaskStatusAndResults",
            "{id:string}",
            false,
            (a, _) => Task.FromResult<object?>(jobs.Get(Str(a, "id")))
        );
        Add(
            "jobs.pause",
            "host.AgentTools.pauseATask",
            "{id:string}",
            true,
            async (a, _) =>
            {
                await jobs.PauseAsync(Str(a, "id"));
                return true;
            }
        );
        Add(
            "jobs.resume",
            "host.AgentTools.resumeATask",
            "{id:string}",
            true,
            async (a, _) =>
            {
                await jobs.ResumeAsync(Str(a, "id"));
                return true;
            }
        );
        Add(
            "jobs.cancel",
            "host.AgentTools.stopATask",
            "{id:string}",
            true,
            async (a, _) =>
            {
                await jobs.StopAsync(Str(a, "id"));
                return true;
            }
        );
        Add(
            "settings.get",
            "host.AgentTools.readSettings",
            "{}",
            false,
            async (_, ct) => await repository.SettingsAsync(ct)
        );
        Add(
            "audit.list",
            "host.AgentTools.readAuditHistory",
            "{}",
            false,
            async (_, ct) => await repository.AuditLogAsync(ct)
        );
    }

    private void Add(
        string name,
        JsonNode description,
        string args,
        bool mutates,
        Func<JsonElement, CancellationToken, Task<object?>> handler
    ) => tools.Add(name, (new(name, description, args, mutates), handler));

    public async Task<ToolResult> ExecuteAsync(
        string name,
        JsonElement args,
        bool allowMutation,
        CancellationToken ct = default
    )
    {
        if (!tools.TryGetValue(name, out var tool))
            throw new TagException("TOOL_UNAVAILABLE");
        if (args.ValueKind != JsonValueKind.Object)
            throw new TagException("ARGUMENTS_INVALID");
        if (tool.Definition.Mutates && !allowMutation)
            throw new InvalidOperationException("host.AgentTools.reviewChangesBeforePerformingThisAction");
        var result = await tool.Handler(args, ct);
        await repository.AuditAsync(name, tool.Definition.Description.ToJsonString(), ct);
        return new(name, JsonSerializer.Serialize(result, CatalogRepository.Json));
    }

    public Task<JsonObject> SnapshotAsync(CancellationToken ct) => tagging.SnapshotAsync(ct);

    private static string Str(JsonElement a, string name) =>
        Optional(a, name) is { Length: > 0 } v ? v : throw new TagException("ARGUMENT_REQUIRED", name);

    private static string? Optional(JsonElement a, string name) =>
        a.TryGetProperty(name, out var v) && v.ValueKind != JsonValueKind.Null ? v.GetString() : null;

    private static string[] Strings(JsonElement a, string name) =>
        a.TryGetProperty(name, out var v) ? v.EnumerateArray().Select(x => x.GetString()!).ToArray() : [];
}

public sealed class LocalAgent(ILocalModel model, AgentTools tools)
{
    public async Task<AgentPlan> PlanAsync(string request, CancellationToken ct = default)
    {
        var snapshot = await tools.SnapshotAsync(ct);
        var available = snapshot["package"]!
            .List("definitions")
            .Where(d => d.Flag("enabled", true))
            .Take(80)
            .Select(d => new
            {
                key = d.Text("key"),
                label = TagJson.Label(d?["label"], package: snapshot["package"]),
                cardinality = d?["value"].Text("cardinality"),
                type = d?["value"]?["schema"].Text("type"),
                targets = AnnotationTargets.Read(d!),
                subjectVocabularies = d.List("subjectVocabularies"),
                vocabulary = d?["value"]?["vocabulary"],
            });
        var system =
            TagResources.Json("agent-prompts.json").Text("system")
            + TagResources.Read("KNOWLEDGE.md")
            + "\nAvailable tools:\n"
            + string.Join(
                '\n',
                tools.Definitions.Select(t => $"{t.Name}: {HostMessages.Resolve(t.Description)} {t.Arguments}")
            );
        var context =
            "USER REQUEST:\n"
            + request
            + "\nCURRENT GENERATION: "
            + snapshot["generation"]
            + "\nDEFINITION DATA:\n"
            + JsonSerializer.Serialize(available);
        AgentPlan? last = null;
        JsonNode? preview = null;
        string? previewTool = null;
        for (int step = 0; step < 6; step++)
        {
            ct.ThrowIfCancellationRequested();
            var route =
                JsonNode.Parse(TagResources.Read("agent-prompts.json"))!.Text("route")
                + string.Join('\n', tools.Definitions.Select(t => $"{t.Name}: {HostMessages.Resolve(t.Description)}"));
            var json = await model.CompleteToolAsync(
                step == 0 ? route : system,
                step == 0 ? request : context,
                tools.Definitions.Select(t => t.Name).ToArray(),
                ct
            );
            AgentPlan plan;
            try
            {
                plan = ParsePlan(json);
            }
            catch (Exception e) when (e is TagException or JsonException or KeyNotFoundException)
            {
                context += "\nInvalid tool result: " + e.Message;
                continue;
            }
            if (plan.NeedsReview)
            {
                var requiredPreview = plan.Tool switch
                {
                    "automation.commit" => "automation.preview",
                    "metadata.bulk.commit" => "metadata.bulk.preview",
                    "config.apply" => "config.preview",
                    "annotations.bulk.commit" => "annotations.bulk.preview",
                    "export.commit" => "export.preview",
                    _ => null,
                };
                if (
                    requiredPreview is not null
                    && (
                        previewTool != requiredPreview
                        || !plan.Arguments.TryGetProperty("previewToken", out var token)
                        || token.GetString() != preview.Text("previewToken")
                    )
                )
                {
                    context +=
                        "\nTOOL ERROR: First call "
                        + requiredPreview
                        + " and use that exact returned previewToken. Never invent a token.";
                    continue;
                }
                return plan with { Preview = requiredPreview is null ? null : preview };
            }
            last = plan;
            if (
                plan.Tool
                is not (
                    "automation.preview"
                    or "metadata.bulk.preview"
                    or "metadata.bulk.status"
                    or "films.ids"
                    or "knowledge.read"
                    or "knowledge.list"
                    or "schema.get"
                    or "definitions.get"
                    or "definitions.snapshot"
                    or "config.get"
                    or "config.preview"
                    or "annotations.get"
                    or "annotations.bulk.preview"
                    or "terms.query"
                    or "terms.get"
                    or "films.query"
                    or "tag.options.query"
                    or "export.capabilities"
                    or "export.preview"
                )
            )
                return plan;
            ToolResult result;
            try
            {
                result = await tools.ExecuteAsync(plan.Tool, plan.Arguments, false, ct);
            }
            catch (Exception e) when (e is TagException or ArgumentException or KeyNotFoundException)
            {
                context += "\nTOOL ERROR: " + e.Message;
                continue;
            }
            if (plan.Tool.EndsWith(".preview", StringComparison.Ordinal))
            {
                previewTool = plan.Tool;
                preview = JsonNode.Parse(result.Json);
                if (preview is JsonObject po)
                    po.Remove("package");
            }
            context += "\nTOOL DATA " + plan.Tool + ":\n" + result.Json[..Math.Min(result.Json.Length, 8000)];
            if (context.Length > 18000)
                context =
                    "USER REQUEST:\n"
                    + request
                    + "\nRECENT TOOL DATA:\n"
                    + result.Json[..Math.Min(result.Json.Length, 8000)];
        }
        return last ?? throw new TagException("AGENT_PLAN_UNAVAILABLE");
    }

    public AgentPlan ParsePlan(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        var name = root.GetProperty("tool").GetString();
        var definition =
            tools.Definitions.SingleOrDefault(t => t.Name == name) ?? throw new TagException("TOOL_UNAVAILABLE");
        var args = root.GetProperty("arguments");
        if (args.ValueKind != JsonValueKind.Object)
            throw new TagException("ARGUMENTS_INVALID");
        return new(
            Guid.NewGuid().ToString("N"),
            definition.Name,
            args.Clone(),
            definition.Mutates,
            definition.Description
        );
    }
}
