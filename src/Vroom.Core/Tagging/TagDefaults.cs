using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;
using Vroom.Core.Storage;

namespace Vroom.Core.Tagging;

/// <summary>
/// Read-time defaults. A film field may declare <c>value.default</c> as a rule expression over media
/// facts (for example a literal or <c>{"fact":"file.path"}</c>). The host projects the result into the
/// effective projection with revision 0 for films that have no effective annotation; no head, history
/// or event is written, so defaults cost one projection row instead of an annotation per film.
/// A field that cannot be written manually and has no rules is <em>derived</em>: its default always
/// wins and follows the media facts. Every reader (UI, query, dedup, Agent) sees the same projection.
/// </summary>
public sealed partial class TagEngine
{
    internal static bool HasDefault(JsonObject d) =>
        d.Flag("enabled", true) && d["value"]?["default"] is not null && AnnotationTargets.Supports(d, "film", "whole");

    internal static bool IsDerived(JsonObject d) =>
        HasDefault(d)
        && !d["writes"].Flag("manual", true)
        && d.List("initialization").Count == 0
        && d.List("automation").Count == 0;

    /// <summary>Projects defaults for the given films (or all films) and fields (or all defaulted fields).</summary>
    internal static void ProjectDefaults(
        SqliteConnection db,
        CompiledDefinitions c,
        IReadOnlyCollection<string>? films = null,
        IReadOnlyCollection<string>? keys = null
    )
    {
        if (keys is not null)
            foreach (var key in keys)
                // Defaults of changed or removed fields are recomputed from scratch.
                db.Execute(
                    "DELETE FROM tag_reference_edges WHERE subject_kind='film' AND scope_id='whole' AND tag_key=@k AND EXISTS(SELECT 1 FROM tag_effective e WHERE e.subject_kind='film' AND e.subject_id=tag_reference_edges.subject_id AND e.scope_id='whole' AND e.tag_key=@k AND e.revision=0);DELETE FROM tag_effective WHERE subject_kind='film' AND scope_id='whole' AND tag_key=@k AND revision=0",
                    ("@k", key)
                );
        var fields = c
            .Definitions.Values.Where(HasDefault)
            .Where(d => keys is null || keys.Contains(d.Text("key")))
            .ToArray();
        if (fields.Length == 0)
            return;
        var ids = films ?? ReadRows(db, "SELECT id FROM films", r => r.GetString(0));
        foreach (var id in ids)
        {
            if (db.Scalar("SELECT payload FROM film_projection WHERE id=@id", ("@id", id)) is not string json)
                continue;
            var facts = Facts(CatalogRepository.Deserialize<Vroom.Core.Domain.Film>(json));
            foreach (var d in fields)
                ProjectDefault(db, c, d, id, facts);
        }
    }

    private static void ProjectDefault(
        SqliteConnection db,
        CompiledDefinitions c,
        JsonObject d,
        string filmId,
        JsonObject facts
    )
    {
        var key = d.Text("key");
        var derived = IsDerived(d);
        var existing = db.Scalar(
            "SELECT revision FROM tag_effective WHERE subject_kind='film' AND subject_id=@id AND scope_id='whole' AND tag_key=@k",
            ("@id", filmId),
            ("@k", key)
        );
        // An effective annotation wins over a default; a derived field always follows the facts.
        if (existing is long revision && revision > 0 && !derived)
            return;
        var record = new JsonObject
        {
            ["subject"] = new JsonObject { ["kind"] = "film", ["id"] = filmId },
            ["scope"] = new JsonObject { ["kind"] = "whole" },
            ["tagKey"] = key,
            ["operation"] = "set",
            ["revision"] = 0,
            ["value"] = Evaluate(d["value"]!["default"], [], facts)?.DeepClone(),
        };
        db.Execute(
            "DELETE FROM tag_effective WHERE subject_kind='film' AND subject_id=@id AND scope_id='whole' AND tag_key=@k",
            ("@id", filmId),
            ("@k", key)
        );
        var (value, _) = record["value"] is null ? (null, null) : c.Project(record);
        if (value is not null)
            db.Execute(
                "INSERT INTO tag_effective VALUES('film',@id,'whole',@k,@v,0)",
                ("@id", filmId),
                ("@k", key),
                ("@v", TagJson.Canonical(value))
            );
        IndexReferences(db, c, record, value);
    }

    /// <summary>Re-applies a field default after an annotation projection removed or replaced it.</summary>
    internal static void ProjectDefaultAfterRecord(
        SqliteConnection db,
        CompiledDefinitions c,
        JsonObject record,
        bool projected
    )
    {
        if (
            record["subject"].Text("kind") != "film"
            || record["scope"].Text("kind") != "whole"
            || !c.Definitions.TryGetValue(record.Text("tagKey"), out var d)
            || !HasDefault(d)
            || projected && !IsDerived(d)
        )
            return;
        var id = record["subject"].Text("id");
        if (db.Scalar("SELECT payload FROM film_projection WHERE id=@id", ("@id", id)) is string json)
            ProjectDefault(db, c, d, id, Facts(CatalogRepository.Deserialize<Vroom.Core.Domain.Film>(json)));
    }

    /// <summary>Default and derived values (revision 0) that have no annotation head.</summary>
    internal static void AddDefaultValues(
        SqliteConnection db,
        CompiledDefinitions c,
        Dictionary<string, JsonObject> result,
        string kind,
        string scopeId
    )
    {
        if (kind != "film" || scopeId != "whole" || result.Count == 0)
            return;
        using var cmd = db.Command(
            "SELECT subject_id,tag_key,value_json FROM tag_effective WHERE subject_kind='film' AND scope_id='whole' AND revision=0 AND subject_id IN(SELECT value FROM json_each(@ids))",
            ("@ids", System.Text.Json.JsonSerializer.Serialize(result.Keys))
        );
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
        {
            var id = reader.GetString(0);
            var key = reader.GetString(1);
            if (!c.Definitions.TryGetValue(key, out var d))
                continue;
            var value = JsonNode.Parse(reader.GetString(2));
            var head = result[id][key] as JsonObject;
            if (head?.Text("status") == "valid")
            {
                // A derived field ignores stale annotations; only its fact-based value is effective.
                if (IsDerived(d))
                    head!["value"] = value;
                continue;
            }
            result[id][key] = new JsonObject
            {
                ["subject"] = new JsonObject { ["kind"] = "film", ["id"] = id },
                ["scope"] = new JsonObject { ["kind"] = "whole" },
                ["tagKey"] = key,
                ["value"] = value,
                // A cleared annotation keeps its head revision for the next optimistic write.
                ["revision"] = head?["revision"]?.DeepClone() ?? 0,
                ["status"] = "valid",
                ["origin"] = new JsonObject { ["kind"] = IsDerived(d) ? "derived" : "default" },
                ["canWrite"] = d.Flag("enabled", true) && d["writes"].Flag("manual", true),
            };
        }
    }
}
