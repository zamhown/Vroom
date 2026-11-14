using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;
using Vroom.Core.Jobs;
using Vroom.Core.Storage;

namespace Vroom.Core.Tagging;

public sealed partial class TagEngine
{
    public async Task<JsonObject> PreviewEnrichmentAsync(JsonObject args, CancellationToken ct = default)
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
                string[] ids;
                if (args["subjectIds"] is JsonArray explicitIds)
                    ids = explicitIds.Select(n => n!.GetValue<string>()).Distinct().ToArray();
                else if (args["query"] is JsonObject query)
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
                    throw new TagException("TARGETS_REQUIRED");
                if (ids.Length > 100000)
                    throw new TagException("BATCH_LIMIT");
                var token = Guid.NewGuid().ToString("N");
                var sample = new JsonArray();
                for (var ordinal = 0; ordinal < ids.Length; ordinal++)
                {
                    ct.ThrowIfCancellationRequested();
                    var film = CatalogRepository.RequireFilm(db, ids[ordinal]);
                    var payload = new JsonObject
                    {
                        ["previewToken"] = token,
                        ["ordinal"] = ordinal,
                        ["id"] = film.Id,
                        ["generation"] = generation,
                        ["mediaRevision"] = MediaRevision(film),
                        ["valuesHash"] = TagJson.Hash(Values(db, c, "film", film.Id)),
                    };
                    db.Execute(
                        "INSERT INTO tag_bulk_items VALUES(@id,@n,@p,'pending',NULL)",
                        ("@id", token),
                        ("@n", ordinal),
                        ("@p", payload.ToJsonString())
                    );
                    if (sample.Count < 20)
                        sample.Add(
                            new JsonObject
                            {
                                ["id"] = film.Id,
                                ["presentation"] = FilmView(db, c, film)["presentation"].Copy(),
                            }
                        );
                }
                db.Execute(
                    "INSERT INTO tag_previews VALUES(@id,'enrichment',@g,@p,NULL,@t)",
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
                Audit(db, "metadata.bulk.preview", result);
                tx.Commit();
                return result;
            },
            ct
        );
    }

    internal static void ValidateEnrichmentTarget(SourceSnapshot snapshot, JsonObject target)
    {
        if (
            snapshot.Generation != target.Number("generation")
            || snapshot.Film is null
            || MediaRevision(snapshot.Film) != target.Text("mediaRevision")
            || TagJson.Hash(snapshot.Values) != target.Text("valuesHash")
        )
            throw new TagException("STALE_SOURCE_RESULT");
    }

    internal static void CompleteEnrichmentItem(
        SqliteConnection db,
        JsonObject target,
        string state,
        string? error,
        object? result
    )
    {
        var payload = target.DeepClone().AsObject();
        payload["result"] = result is null
            ? null
            : System.Text.Json.JsonSerializer.SerializeToNode(result, TagJson.Options);
        db.Execute(
            "UPDATE tag_bulk_items SET state=@s,error=@e,payload=@p WHERE preview_id=@id AND ordinal=@n",
            ("@s", state),
            ("@e", error),
            ("@p", payload.ToJsonString()),
            ("@id", target.Text("previewToken")),
            ("@n", (int)target.Number("ordinal"))
        );
    }

    public async Task<JsonObject> EnrichmentStatusAsync(string token, CancellationToken ct = default)
    {
        await InitializeAsync(ct);
        return await repository.Database.ReadAsync(
            db =>
            {
                Preview(db, token, "enrichment");
                var counts = new JsonObject();
                foreach (
                    var row in ReadRows(
                        db,
                        "SELECT state,COUNT(*) FROM tag_bulk_items WHERE preview_id=@id GROUP BY state",
                        r => (State: r.GetString(0), Count: r.GetInt64(1)),
                        ("@id", token)
                    )
                )
                    counts[row.State] = row.Count;
                var items = ReadRows(
                    db,
                    "SELECT state,error,payload FROM tag_bulk_items WHERE preview_id=@id ORDER BY CASE state WHEN 'deferred' THEN 0 WHEN 'conflict' THEN 1 WHEN 'failed' THEN 2 ELSE 3 END,ordinal LIMIT 100",
                    r =>
                        (JsonNode)
                            new JsonObject
                            {
                                ["state"] = r.GetString(0),
                                ["error"] = r.IsDBNull(1) ? null : r.GetString(1),
                                ["target"] = JsonNode.Parse(r.GetString(2)),
                            },
                    ("@id", token)
                );
                return new JsonObject
                {
                    ["previewToken"] = token,
                    ["counts"] = counts,
                    ["items"] = new JsonArray(items.ToArray()),
                };
            },
            ct
        );
    }
}

public sealed partial class TagSources
{
    internal void RegisterBulkJobs(JobCoordinator jobs) =>
        jobs.Register(
            "metadata.batch",
            async (context, args) =>
            {
                var token = args.GetProperty("previewToken").GetString()!;
                var ct = context.CancellationToken;
                var items = await engine.Repository.Database.ReadAsync(
                    db =>
                    {
                        TagEngine.Preview(db, token, "enrichment");
                        return TagEngine.ReadRows(
                            db,
                            "SELECT payload FROM tag_bulk_items WHERE preview_id=@id AND state IN ('pending','failed','deferred') ORDER BY ordinal",
                            r => JsonNode.Parse(r.GetString(0))!.AsObject(),
                            ("@id", token)
                        );
                    },
                    ct
                );
                var status = await engine.EnrichmentStatusAsync(token, ct);
                var total = (int)status.Map("counts").Sum(x => status["counts"].Number(x.Key));
                var completed = total - items.Count;
                foreach (var item in items)
                {
                    await context.CheckpointAsync();
                    var blocked = false;
                    try
                    {
                        await EnrichCoreAsync(
                            "film",
                            item.Text("id"),
                            ct,
                            message => context.ReportAsync(completed, total, message),
                            null,
                            false,
                            item
                        );
                    }
                    catch (Exception e) when (e is not OperationCanceledException && !ct.IsCancellationRequested)
                    {
                        // A source-wide outage is not a fresh failure for every remaining film.
                        // Leave this target retryable and the remaining frozen targets untouched.
                        blocked =
                            e is JobResultFailure { Result: EnrichmentResult enrichment }
                            && enrichment.Sources.Any(s =>
                                s.Error is not null
                                && (
                                    s.RetryAt is not null
                                    || s.Status
                                        is "browser-unavailable"
                                            or "browser-proxy-auth"
                                            or "browser-proxy-route"
                                            or "configuration-invalid"
                                )
                            );
                        await engine.Repository.Database.RunAsync(
                            db =>
                                TagEngine.CompleteEnrichmentItem(
                                    db,
                                    item,
                                    blocked ? "deferred"
                                        : e is TagException ? "conflict"
                                        : "failed",
                                    e is TagException tagError ? "error." + tagError.Code
                                        : e is JobResultFailure ? e.Message
                                        : "error.unexpected",
                                    e is JobResultFailure failure ? failure.Result : null
                                ),
                            ct
                        );
                    }
                    if (blocked)
                    {
                        await context.ReportAsync(completed, total, "host.SourceAccess.batchBlocked");
                        throw new JobResultFailure(
                            "host.SourceAccess.batchBlocked",
                            await engine.EnrichmentStatusAsync(token, ct)
                        );
                    }
                    await context.ReportAsync(++completed, total, $"{completed} / {total}");
                }
                status = await engine.EnrichmentStatusAsync(token, ct);
                if (status["counts"].Number("failed") > 0)
                    throw new JobResultFailure("host.SourceAccess.failed", status);
                return status;
            },
            canPause: true,
            canRetry: true
        );
}

public sealed partial class TagJobs
{
    public async Task<object> StartEnrichmentAsync(string token)
    {
        await engine.InitializeAsync();
        await startGate.WaitAsync();
        try
        {
            var preview = await engine.Repository.Database.ReadAsync(db => TagEngine.Preview(db, token, "enrichment"));
            if (preview.Result is not null)
                return JsonNode.Parse(preview.Result)!;
            var job = await jobs.StartAsync(
                "metadata.batch",
                "host.BackgroundOperations.enrichMetadataInBulk",
                new { previewToken = token },
                "metadata.batch:" + token
            );
            var result = new JsonObject { ["jobId"] = job, ["previewToken"] = token };
            await engine.Repository.Database.RunAsync(db =>
            {
                using var tx = db.BeginTransaction();
                db.Execute(
                    "UPDATE tag_previews SET result=@r WHERE id=@id",
                    ("@r", result.ToJsonString()),
                    ("@id", token)
                );
                TagEngine.Audit(db, "metadata.bulk.commit", result);
                tx.Commit();
            });
            return result;
        }
        finally
        {
            startGate.Release();
        }
    }
}
