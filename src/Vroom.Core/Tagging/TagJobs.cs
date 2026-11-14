using System.Text.Json.Nodes;
using Vroom.Core.Jobs;
using Vroom.Core.Storage;

namespace Vroom.Core.Tagging;

public sealed partial class TagJobs
{
    private readonly TagEngine engine;
    private readonly JobCoordinator jobs;
    private readonly SemaphoreSlim startGate = new(1, 1);

    public TagJobs(TagEngine engine, JobCoordinator jobs)
    {
        this.engine = engine;
        this.jobs = jobs;
        jobs.Register(
            "annotations.bulk",
            async (context, payload) =>
            {
                var token = payload.GetProperty("previewToken").GetString()!;
                var items = await engine.Repository.Database.RunAsync(
                    db =>
                        TagEngine.ReadRows(
                            db,
                            "SELECT ordinal,payload,state FROM tag_bulk_items WHERE preview_id=@id ORDER BY ordinal",
                            r => new
                            {
                                Ordinal = r.GetInt32(0),
                                Payload = JsonNode.Parse(r.GetString(1))!.AsObject(),
                                State = r.GetString(2),
                            },
                            ("@id", token)
                        ),
                    context.CancellationToken
                );
                var generation = await engine.Repository.Database.RunAsync(
                    db => TagEngine.Preview(db, token, "bulk").Generation,
                    context.CancellationToken
                );
                var completed = items.Count(x => x.State != "pending");
                foreach (var item in items.Where(x => x.State == "pending"))
                {
                    await context.CheckpointAsync();
                    string? error = null;
                    try
                    {
                        await engine.BatchAsync(
                            new JsonObject
                            {
                                ["expectedGeneration"] = generation,
                                ["writes"] = item.Payload["writes"].Copy(),
                                ["idempotencyKey"] = "bulk:" + token + ":" + item.Ordinal,
                            },
                            "agent",
                            context.CancellationToken
                        );
                    }
                    catch (TagException e)
                    {
                        error = e.Code + ":" + e.Pointer;
                    }
                    await engine.Repository.Database.RunAsync(
                        db =>
                            db.Execute(
                                "UPDATE tag_bulk_items SET state=@s,error=@e WHERE preview_id=@id AND ordinal=@n",
                                ("@s", error is null ? "completed" : "conflict"),
                                ("@e", error),
                                ("@id", token),
                                ("@n", item.Ordinal)
                            ),
                        context.CancellationToken
                    );
                    await context.ReportAsync(++completed, items.Count, $"{completed} / {items.Count}");
                }
                return await engine.BulkStatusAsync(token, context.CancellationToken);
            },
            canPause: true,
            canRetry: true
        );
        jobs.Register(
            "automation.bulk",
            async (context, payload) =>
            {
                var token = payload.GetProperty("previewToken").GetString()!;
                var generation = await engine.Repository.Database.ReadAsync(
                    db => TagEngine.Preview(db, token, "automation").Generation,
                    context.CancellationToken
                );
                var items = await engine.Repository.Database.ReadAsync(
                    db =>
                        TagEngine.ReadRows(
                            db,
                            "SELECT ordinal,payload,state FROM tag_bulk_items WHERE preview_id=@id ORDER BY ordinal",
                            r => new
                            {
                                Ordinal = r.GetInt32(0),
                                Payload = JsonNode.Parse(r.GetString(1))!.AsObject(),
                                State = r.GetString(2),
                            },
                            ("@id", token)
                        ),
                    context.CancellationToken
                );
                var completed = items.Count(x => x.State != "pending");
                foreach (var item in items.Where(x => x.State == "pending"))
                {
                    await context.CheckpointAsync();
                    string? error = null;
                    try
                    {
                        await engine.BatchAsync(
                            new JsonObject
                            {
                                ["expectedGeneration"] = generation,
                                ["writes"] = item.Payload["writes"].Copy(),
                                ["idempotencyKey"] = "automation:" + token + ":" + item.Ordinal,
                            },
                            "event",
                            context.CancellationToken
                        );
                    }
                    catch (TagException e)
                    {
                        error = e.Code + ":" + e.Pointer;
                    }
                    await engine.Repository.Database.RunAsync(
                        db =>
                            db.Execute(
                                "UPDATE tag_bulk_items SET state=@s,error=@e WHERE preview_id=@id AND ordinal=@n",
                                ("@s", error is null ? "completed" : "conflict"),
                                ("@e", error),
                                ("@id", token),
                                ("@n", item.Ordinal)
                            ),
                        context.CancellationToken
                    );
                    await context.ReportAsync(++completed, items.Count, $"{completed} / {items.Count}");
                }
                return await engine.BulkStatusAsync(token, context.CancellationToken);
            },
            canPause: true,
            canRetry: true
        );
        jobs.Register(
            "config.publish",
            async (context, payload) =>
            {
                await context.ReportAsync(0, 1, "config.publish");
                var result = await engine.ApplyConfigAsync(
                    JsonNode.Parse(payload.GetRawText())!.AsObject(),
                    context.CancellationToken,
                    count =>
                        context.ReportTransactionProgress(
                            count,
                            Vroom.Core.Application.UiMessage.Of("host.TagJobs.updatingEffectiveAnnotations", count)
                        ),
                    context.BeginCommit
                );
                await context.ReportAsync(
                    (int)result.Number("projectedCount"),
                    (int)result.Number("projectedCount"),
                    "config.published"
                );
                return result;
            },
            canRetry: true
        );
    }

    public async Task<object> StartBulkAsync(string token)
    {
        await engine.InitializeAsync();
        await startGate.WaitAsync();
        try
        {
            var result = await engine.Repository.Database.RunAsync(db => TagEngine.Preview(db, token, "bulk").Result);
            if (result is not null)
                return JsonNode.Parse(result)!;
            var job = await jobs.StartAsync(
                "annotations.bulk",
                "host.TagJobs.bulkAnnotation",
                new { previewToken = token },
                "annotations.bulk:" + token
            );
            var response = new JsonObject { ["jobId"] = job, ["previewToken"] = token };
            await engine.Repository.Database.RunAsync(db =>
                db.Execute(
                    "UPDATE tag_previews SET result=@r WHERE id=@id",
                    ("@r", response.ToJsonString()),
                    ("@id", token)
                )
            );
            return response;
        }
        finally
        {
            startGate.Release();
        }
    }

    public Task<string> StartConfigAsync(JsonObject args) =>
        jobs.StartAsync("config.publish", "host.TagJobs.publishTagConfiguration", args, "config.publish");

    public async Task<object> PrepareAutomationAsync(JsonObject args, CancellationToken ct = default)
    {
        var ids = await engine.AutomationProbeIdsAsync(args, ct);
        return new
        {
            jobId = ids.Length > 0
                ? await jobs.StartAsync(
                    "media.prepare",
                    "host.BackgroundOperations.readMediaInformation",
                    new { ids, tagKey = args.Text("tagKey") },
                    "media.prepare"
                )
                : null,
            count = ids.Length,
        };
    }

    public async Task<object> StartAutomationAsync(string token)
    {
        await engine.InitializeAsync();
        await startGate.WaitAsync();
        try
        {
            var preview = await engine.Repository.Database.ReadAsync(db => TagEngine.Preview(db, token, "automation"));
            if (preview.Result is not null)
                return JsonNode.Parse(preview.Result)!;
            var job = await jobs.StartAsync(
                "automation.bulk",
                "host.Journey.applyRules",
                new { previewToken = token },
                "automation:" + token
            );
            var response = new JsonObject { ["jobId"] = job, ["previewToken"] = token };
            await engine.Repository.Database.RunAsync(db =>
                db.Execute(
                    "UPDATE tag_previews SET result=@r WHERE id=@id",
                    ("@r", response.ToJsonString()),
                    ("@id", token)
                )
            );
            return response;
        }
        finally
        {
            startGate.Release();
        }
    }
}

public sealed partial class TagEngine
{
    public async Task<JsonObject> PreviewBulkAsync(JsonObject args, CancellationToken ct = default)
    {
        await InitializeAsync(ct);
        return await repository.Database.RunAsync(
            db =>
            {
                using var tx = db.BeginTransaction();
                var c = Current(db);
                var generation = Generation(db);
                if (args.Number("expectedGeneration", generation) != generation)
                    throw new TagException("STALE_GENERATION");
                var changes = args.List("changes").OfType<JsonObject>().ToArray();
                if (changes.Length is 0 or > 100)
                    throw new TagException("BATCH_LIMIT");
                if (changes.Select(x => x.Text("tagKey")).Distinct().Count() != changes.Length)
                    throw new TagException("DUPLICATE_WRITE");
                var subjectKind = args.Text("subjectKind", "film");
                if (subjectKind is not ("film" or "term"))
                    throw new TagException("SUBJECT_KIND_UNAVAILABLE");
                var ids = args.List("subjectIds").Select(n => n!.ToString()).Distinct().ToArray();
                if (ids.Length == 0)
                {
                    if (args["query"] is not JsonObject query)
                        throw new TagException("TARGETS_REQUIRED");
                    if (subjectKind == "film")
                    {
                        var (where, q) = CompileQuery(c, query);
                        ids = ReadRows(
                                db,
                                $"SELECT f.id FROM films f WHERE {where} ORDER BY f.id LIMIT 100001",
                                r => r.GetString(0),
                                [.. q.Parameters]
                            )
                            .ToArray();
                    }
                    else
                    {
                        var q = new TagQuery(c);
                        var where = q.Compile(query["where"], subjectKind: "term");
                        ids = ReadRows(
                                db,
                                $"SELECT f.id FROM tag_term_catalog f WHERE {where} ORDER BY f.id LIMIT 100001",
                                r => r.GetString(0),
                                [.. q.Parameters]
                            )
                            .Where(id =>
                                query.Text("vocabulary").Length == 0
                                || c.InVocabulary(c.RequireTerm(id), query.Text("vocabulary"))
                            )
                            .ToArray();
                    }
                }
                if (ids.Length > 100000)
                    throw new TagException("BATCH_LIMIT");
                var token = Guid.NewGuid().ToString("N");
                var sample = new JsonArray();
                var ordinal = 0;
                foreach (var id in ids)
                {
                    ct.ThrowIfCancellationRequested();
                    var film = subjectKind == "film" ? CatalogRepository.RequireFilm(db, id) : null;
                    var term = subjectKind == "term" ? c.RequireTerm(id) : null;
                    var subject = new JsonObject { ["kind"] = subjectKind, ["id"] = id };
                    var scope = new JsonObject { ["kind"] = "whole" };
                    var writes = new JsonArray();
                    foreach (var change in changes)
                    {
                        var d = c.Require(change.Text("tagKey"));
                        if (!d["writes"].Flag("manual", true))
                            throw new TagException("VALUE_READ_ONLY", d.Text("key"));
                        if (!AnnotationTargets.Supports(d, subjectKind, "whole"))
                            throw new TagException("SCOPE_UNSUPPORTED");
                        var op = change.Text("operation", "set");
                        if (op is not ("set" or "clear" or "add" or "remove"))
                            throw new TagException("OPERATION_UNAVAILABLE");
                        if (op == "set" && !c.Accepts(d, change["value"]))
                            throw new TagException("VALUE_OUT_OF_DOMAIN", d.Text("key"));
                        if (op is "add" or "remove" && d["value"].Text("cardinality") != "many")
                            throw new TagException("CARDINALITY_MISMATCH");
                        var head = Head(db, subject, scope, d.Text("key"));
                        var write = change.DeepClone().AsObject();
                        write["subject"] = subject.DeepClone();
                        write["scope"] = scope.DeepClone();
                        write["expectedRevision"] = head?.Number("revision") ?? 0;
                        if (film is not null)
                            write["mediaRevision"] = MediaRevision(film);
                        if (term is not null)
                            write["subjectRevision"] = term.Number("revision");
                        writes.Add(write);
                    }
                    db.Execute(
                        "INSERT INTO tag_bulk_items VALUES(@id,@n,@p,'pending',NULL)",
                        ("@id", token),
                        ("@n", ordinal++),
                        ("@p", new JsonObject { ["writes"] = writes }.ToJsonString())
                    );
                    if (sample.Count < 20)
                        sample.Add(
                            new JsonObject
                            {
                                ["id"] = id,
                                ["presentation"] = film is null
                                    ? new JsonObject { ["title"] = term!["label"].Copy() }
                                    : FilmView(db, c, film)["presentation"].Copy(),
                                ["before"] = Values(db, c, subjectKind, id),
                                ["changes"] = args["changes"].Copy(),
                            }
                        );
                }
                db.Execute("SAVEPOINT validate_bulk");
                try
                {
                    foreach (
                        var payload in ReadRows(
                            db,
                            "SELECT payload FROM tag_bulk_items WHERE preview_id=@id ORDER BY ordinal",
                            r => JsonNode.Parse(r.GetString(0))!,
                            ("@id", token)
                        )
                    )
                    foreach (var write in payload.List("writes").OfType<JsonObject>())
                        Write(db, c, write, "agent");
                    ValidateTermGraph(db);
                }
                finally
                {
                    db.Execute("ROLLBACK TO validate_bulk; RELEASE validate_bulk;");
                }
                db.Execute(
                    "INSERT INTO tag_previews VALUES(@id,'bulk',@g,@p,NULL,@t)",
                    ("@id", token),
                    ("@g", generation),
                    ("@p", args.ToJsonString()),
                    ("@t", Now)
                );
                var result = new JsonObject
                {
                    ["previewToken"] = token,
                    ["generation"] = generation,
                    ["count"] = ids.Length,
                    ["sample"] = sample,
                };
                Audit(
                    db,
                    "annotations.bulk.preview",
                    new JsonObject { ["previewToken"] = token, ["count"] = ids.Length }
                );
                tx.Commit();
                return result;
            },
            ct
        );
    }

    public async Task<object> BulkStatusAsync(string token, CancellationToken ct = default)
    {
        await InitializeAsync(ct);
        return await repository.Database.ReadAsync<object>(
            db => new
            {
                previewToken = token,
                counts = ReadRows(
                    db,
                    "SELECT state,COUNT(*) FROM tag_bulk_items WHERE preview_id=@id GROUP BY state",
                    r => new { state = r.GetString(0), count = r.GetInt64(1) },
                    ("@id", token)
                ),
                conflicts = ReadRows(
                    db,
                    "SELECT ordinal,error,payload FROM tag_bulk_items WHERE preview_id=@id AND state='conflict' LIMIT 100",
                    r => new
                    {
                        ordinal = r.GetInt32(0),
                        error = r.GetString(1),
                        write = JsonNode.Parse(r.GetString(2)),
                    },
                    ("@id", token)
                ),
            },
            ct
        );
    }
}
