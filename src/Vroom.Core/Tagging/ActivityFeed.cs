using System.Text.Json.Nodes;
using Vroom.Core.Domain;
using Vroom.Core.Storage;

namespace Vroom.Core.Tagging;

public sealed partial class TagEngine
{
    /// <summary>A read model over durable tasks and proposals, never a second annotation store.</summary>
    public async Task<JsonObject> ActivityAsync(JsonObject args, CancellationToken ct = default)
    {
        await InitializeAsync(ct);
        return await repository.Database.ReadAsync(
            db =>
            {
                var c = Current(db);
                var sources = args.List("sources").Select(s => s!.ToString()).ToArray();
                if (sources.Length == 0 || sources.Any(s => s is not ("jobs" or "candidates")))
                    throw new TagException("ACTIVITY_SOURCE_INVALID");
                if (args.Text("filter", "all") is not ("all" or "attention"))
                    throw new TagException("ACTIVITY_FILTER_INVALID");
                const string feed = """
                    WITH task_feed AS (
                      SELECT 'job:'||id AS id, 'job' AS kind, updated, payload,
                        (json_extract(payload,'$.state') IN ('failed','interrupted','paused')
                          OR COALESCE(json_array_length(json_extract(payload,'$.resultJson'),'$.failures'),0)>0
                          OR EXISTS(SELECT 1 FROM json_each(json_extract(payload,'$.resultJson'),'$.counts') count
                            WHERE (count.key IN ('failed','conflict') AND count.value>0)
                              OR (json_extract(count.value,'$.state') IN ('failed','conflict') AND json_extract(count.value,'$.count')>0))) AS attention
                      FROM background_jobs WHERE @jobs
                    ), feed AS (
                      SELECT * FROM task_feed WHERE json_extract(payload,'$.parentId') IS NULL OR attention
                      UNION ALL
                      SELECT 'candidate:'||p.id, 'candidate', COALESCE(json_extract(p.payload,'$.updated'),''), p.payload, 1
                      FROM tag_candidates p
                      JOIN json_each(@definitions) d ON json_extract(d.value,'$.key')=p.tag_key
                      WHERE @candidates AND p.state='pending' AND COALESCE(json_extract(d.value,'$.enabled'),1)
                        AND ((json_extract(p.payload,'$.subjectKind')='film' AND EXISTS(SELECT 1 FROM films f WHERE f.id=p.subject_id))
                          OR (json_extract(p.payload,'$.subjectKind')='term' AND EXISTS(SELECT 1 FROM tag_term_catalog t WHERE t.id=p.subject_id)))
                    )
                    """;
                var parameters = new (string, object?)[]
                {
                    ("@jobs", sources.Contains("jobs")),
                    ("@candidates", sources.Contains("candidates")),
                    ("@definitions", c.Package["definitions"]!.ToJsonString()),
                };
                var counts = ReadRows(
                        db,
                        feed + "SELECT COUNT(*),COALESCE(SUM(attention),0) FROM feed",
                        r => (Total: r.GetInt64(0), Attention: r.GetInt64(1)),
                        parameters
                    )
                    .Single();
                var limit = Math.Clamp((int)args.Number("limit", 20), 1, 100);
                var rows = ReadRows(
                    db,
                    feed
                        + """
                        SELECT id,kind,updated,payload,attention FROM feed
                        WHERE (@attention=0 OR attention=1)
                          AND (@cursor=0 OR updated<@updated OR (updated=@updated AND id<@id))
                        ORDER BY updated DESC,id DESC LIMIT @limit
                        """,
                    r => new JsonObject
                    {
                        ["id"] = r.GetString(0),
                        ["kind"] = r.GetString(1),
                        ["updated"] = r.GetString(2),
                        ["data"] = JsonNode.Parse(r.GetString(3)),
                        ["attention"] = r.GetInt64(4) != 0,
                    },
                    [
                        .. parameters,
                        ("@attention", args.Text("filter") == "attention"),
                        ("@cursor", args["before"] is not null),
                        ("@updated", args["before"].Text("updated")),
                        ("@id", args["before"].Text("id")),
                        ("@limit", limit + 1),
                    ]
                );
                var hasMore = rows.Count > limit;
                var items = rows.Take(limit).ToArray();
                // Batch title projections from the same committed generation as the proposals.
                var ids = items
                    .Where(x => x.Text("kind") == "candidate" && x["data"].Text("subjectKind") == "film")
                    .Select(x => x["data"].Text("subjectId"))
                    .Distinct()
                    .ToArray();
                var values = ValuesForMany(db, c, "film", ids);
                var films = ReadRows(
                        db,
                        "SELECT payload FROM film_projection WHERE id IN (SELECT value FROM json_each(@ids))",
                        r => CatalogRepository.Deserialize<Film>(r.GetString(0)),
                        ("@ids", System.Text.Json.JsonSerializer.Serialize(ids))
                    )
                    .ToDictionary(f => f.Id);
                foreach (var item in items.Where(x => x.Text("kind") == "candidate"))
                {
                    var id = item["data"].Text("subjectId");
                    item["subjectLabel"] =
                        item["data"].Text("subjectKind") == "film" && films.TryGetValue(id, out var film)
                            ? FilmView(db, c, film, values[id])["presentation"]!["title"].Copy()
                            : c.Terms.GetValueOrDefault(id)?["label"].Copy();
                }
                var last = items.LastOrDefault();
                return new JsonObject
                {
                    ["items"] = new JsonArray(items.Cast<JsonNode?>().ToArray()),
                    ["total"] = counts.Total,
                    ["attention"] = counts.Attention,
                    ["next"] =
                        hasMore && last is not null
                            ? new JsonObject { ["id"] = last["id"].Copy(), ["updated"] = last["updated"].Copy() }
                            : null,
                };
            },
            ct
        );
    }
}
