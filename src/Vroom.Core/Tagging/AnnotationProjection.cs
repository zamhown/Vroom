using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;
using Vroom.Core.Storage;

namespace Vroom.Core.Tagging;

// Projection work stays inside the caller's unit of work. WAL readers keep seeing the
// preceding committed generation until the complete projection and graph check commit.
public sealed partial class TagEngine
{
    private static JsonObject ValueContract(JsonObject d) =>
        new(
            new[] { "enabled", "targets", "subjectVocabularies", "value" }.Select(k => new KeyValuePair<
                string,
                JsonNode?
            >(k, d[k].Copy()))
        );

    private static JsonObject TermMembership(CompiledDefinitions c, JsonObject? t) =>
        new()
        {
            ["available"] = t is not null && c.TermAvailable(t),
            ["vocabularies"] = t is null
                ? null
                : new JsonArray(
                    t.List("vocabularyIds")
                        .Where(v => c.InVocabulary(t, v!.ToString()))
                        .OrderBy(v => v!.ToString(), StringComparer.Ordinal)
                        .Select(v => v.Copy())
                        .ToArray()
                ),
        };

    internal static int ReprojectChanged(
        SqliteConnection db,
        CompiledDefinitions previous,
        CompiledDefinitions next,
        CancellationToken ct = default,
        Action<int>? progress = null
    )
    {
        var keys = previous
            .Definitions.Keys.Union(next.Definitions.Keys)
            .Where(k =>
                !previous.Definitions.TryGetValue(k, out var old)
                || !next.Definitions.TryGetValue(k, out var current)
                || !JsonNode.DeepEquals(ValueContract(old), ValueContract(current))
            )
            .ToArray();
        var terms = previous
            .Terms.Keys.Union(next.Terms.Keys)
            .Where(k =>
                !JsonNode.DeepEquals(
                    TermMembership(previous, previous.Terms.GetValueOrDefault(k)),
                    TermMembership(next, next.Terms.GetValueOrDefault(k))
                )
            )
            .ToArray();
        SyncTermCatalog(db, next, previous);
        if (keys.Length == 0 && terms.Length == 0)
            return 0;
        // Raw references also find excluded members that become valid again.
        var records = StreamRecords(
            db,
            """
            SELECT h.payload FROM tag_heads h WHERE h.tag_key IN(SELECT value FROM json_each(@keys))
            OR (h.subject_kind='term' AND h.subject_id IN(SELECT value FROM json_each(@terms)))
            OR EXISTS(SELECT 1 FROM tag_raw_references r WHERE r.subject_kind=h.subject_kind AND r.subject_id=h.subject_id AND r.scope_id=h.scope_id AND r.tag_key=h.tag_key AND r.target_id IN(SELECT value FROM json_each(@terms)))
            """,
            ("@keys", JsonSerializer.Serialize(keys)),
            ("@terms", JsonSerializer.Serialize(terms))
        );
        var count = 0;
        foreach (var record in records)
        {
            ct.ThrowIfCancellationRequested();
            ProjectRecord(db, next, record);
            count++;
            if (count % 1000 == 0)
                progress?.Invoke(count);
        }
        ProjectDefaults(
            db,
            next,
            keys: keys.Where(k =>
                    next.Definitions.TryGetValue(k, out var d) && HasDefault(d)
                    || previous.Definitions.TryGetValue(k, out var old) && HasDefault(old)
                )
                .ToArray()
        );
        progress?.Invoke(count);
        return count;
    }

    private static IEnumerable<JsonObject> StreamRecords(
        SqliteConnection db,
        string sql,
        params (string Name, object? Value)[] parameters
    )
    {
        using var command = db.Command(sql, parameters);
        using var reader = command.ExecuteReader();
        while (reader.Read())
            yield return JsonNode.Parse(reader.GetString(0))!.AsObject();
    }

    private static void SyncTermCatalog(
        SqliteConnection db,
        CompiledDefinitions c,
        CompiledDefinitions? previous = null
    )
    {
        if (previous is null)
            db.Execute("DELETE FROM tag_term_catalog;");
        else
            foreach (
                var term in previous.Terms.Values.Where(t =>
                    !c.Terms.TryGetValue(t.Text("id"), out var next) || !c.TermAvailable(next)
                )
            )
                db.Execute("DELETE FROM tag_term_catalog WHERE id=@id", ("@id", term.Text("id")));
        foreach (var term in c.Terms.Values.Where(c.TermAvailable))
            if (
                previous is null
                || !JsonNode.DeepEquals(previous.Terms.GetValueOrDefault(term.Text("id")), term)
                || !previous.TermAvailable(term)
            )
                db.Execute(
                    "INSERT INTO tag_term_catalog VALUES(@id,@p) ON CONFLICT(id) DO UPDATE SET payload=@p",
                    ("@id", term.Text("id")),
                    ("@p", term.ToJsonString())
                );
    }

    internal static void Reproject(SqliteConnection db, CompiledDefinitions c, CancellationToken ct = default)
    {
        db.Execute(
            "DELETE FROM tag_effective;DELETE FROM tag_issues;DELETE FROM tag_reference_edges;DELETE FROM tag_scope_index;DELETE FROM tag_raw_references;DELETE FROM media_scope_projection;"
        );
        SyncTermCatalog(db, c);
        foreach (var record in StreamRecords(db, "SELECT payload FROM tag_heads"))
        {
            ct.ThrowIfCancellationRequested();
            ProjectRecord(db, c, record);
        }
        ProjectDefaults(db, c);
    }

    internal static (JsonNode? Value, string? Issue) Project(
        SqliteConnection db,
        CompiledDefinitions c,
        JsonObject record
    )
    {
        if (record["scope"].Text("kind") != "whole" && record["subject"].Text("kind") == "film")
        {
            try
            {
                ValidateScope(db, c, record["subject"]!, record["scope"]!.DeepClone().AsObject());
            }
            catch (TagException e)
            {
                return (null, e.Code);
            }
            catch (KeyNotFoundException)
            {
                return (null, "SUBJECT_UNRESOLVED");
            }
        }
        return c.Project(record);
    }

    internal static void ProjectRecord(SqliteConnection db, CompiledDefinitions c, JsonObject record)
    {
        var subject = record["subject"]!;
        var scope = record["scope"]!;
        var scopeId = ScopeId(scope);
        var key = record.Text("tagKey");
        var revision = (long)record.Number("revision");
        (string, object?)[] p =
        [
            ("@kind", subject.Text("kind")),
            ("@id", subject.Text("id")),
            ("@scope", scopeId),
            ("@tag", key),
        ];
        const string binding = "subject_kind=@kind AND subject_id=@id AND scope_id=@scope AND tag_key=@tag";
        db.Execute("DELETE FROM tag_effective WHERE " + binding, p);
        db.Execute("DELETE FROM tag_issues WHERE " + binding, p);
        db.Execute("DELETE FROM tag_raw_references WHERE " + binding, p);
        foreach (var v in record["value"] as JsonArray ?? new JsonArray(record["value"].Copy()))
            if (v is JsonObject r && r.Count == 1 && r["term"] is not null)
                db.Execute(
                    "INSERT OR IGNORE INTO tag_raw_references VALUES(@kind,@id,@scope,@tag,@target)",
                    [.. p, ("@target", r.Text("term"))]
                );
        var (value, issue) = Project(db, c, record);
        if (value is not null)
        {
            db.Execute(
                "INSERT INTO tag_effective VALUES(@kind,@id,@scope,@tag,@v,@r)",
                [.. p, ("@v", TagJson.Canonical(value)), ("@r", revision)]
            );
            var start = long.TryParse(scope.Text("startUs"), out var s) ? s : 0;
            var end = long.TryParse(scope.Text("endUs"), out var e) ? e : start;
            db.Execute(
                "INSERT INTO tag_scope_index VALUES(@kind,@id,@scope,@sk,@s,@e) ON CONFLICT(subject_kind,subject_id,scope_id) DO UPDATE SET kind=@sk,start_us=@s,end_us=@e",
                [.. p, ("@sk", scope.Text("kind")), ("@s", start), ("@e", end)]
            );
            if (subject.Text("kind") == "film" && scope.Text("kind") != "whole")
            {
                var bindingScope = scope.DeepClone().AsObject();
                ValidateScope(db, c, subject, bindingScope);
                db.Execute(
                    "INSERT INTO media_scope_projection VALUES(@id,@scope,@part) ON CONFLICT(subject_id,scope_id) DO UPDATE SET part_id=@part",
                    ("@id", subject.Text("id")),
                    ("@scope", scopeId),
                    ("@part", bindingScope.Text("partId"))
                );
            }
        }
        else
            db.Execute(
                "DELETE FROM tag_scope_index WHERE subject_kind=@kind AND subject_id=@id AND scope_id=@scope AND NOT EXISTS(SELECT 1 FROM tag_effective e WHERE e.subject_kind=@kind AND e.subject_id=@id AND e.scope_id=@scope)",
                p
            );
        if (subject.Text("kind") == "film")
            db.Execute(
                "DELETE FROM media_scope_projection WHERE subject_id=@id AND scope_id=@scope AND NOT EXISTS(SELECT 1 FROM tag_scope_index WHERE subject_kind='film' AND subject_id=@id AND scope_id=@scope)",
                ("@id", subject.Text("id")),
                ("@scope", scopeId)
            );
        IndexReferences(db, c, record, value);
        if (issue is not null)
            db.Execute(
                "INSERT INTO tag_issues VALUES(@kind,@id,@scope,@tag,@code,@r)",
                [.. p, ("@code", issue), ("@r", revision)]
            );
        ProjectDefaultAfterRecord(db, c, record, value is not null);
    }

    internal static Dictionary<string, JsonObject> ValuesForMany(
        SqliteConnection db,
        CompiledDefinitions c,
        string kind,
        IEnumerable<string> ids,
        string scopeId = "whole"
    )
    {
        var result = ids.Distinct().ToDictionary(id => id, _ => new JsonObject());
        using var cmd = db.Command(
            """
            SELECT h.subject_id,h.tag_key,h.payload,e.value_json,i.code FROM tag_heads h
            LEFT JOIN tag_effective e USING(subject_kind,subject_id,scope_id,tag_key)
            LEFT JOIN tag_issues i USING(subject_kind,subject_id,scope_id,tag_key)
            WHERE h.subject_kind=@kind AND h.scope_id=@scope AND h.subject_id IN(SELECT value FROM json_each(@ids))
            """,
            ("@kind", kind),
            ("@scope", scopeId),
            ("@ids", JsonSerializer.Serialize(result.Keys))
        );
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
        {
            var record = JsonNode.Parse(reader.GetString(2))!.AsObject();
            record["value"] = reader.IsDBNull(3) ? null : JsonNode.Parse(reader.GetString(3));
            record["status"] = reader.IsDBNull(4)
                ? record.Text("operation") == "clear"
                    ? "unset"
                    : "valid"
                : reader.GetString(4);
            record["canWrite"] =
                c.Definitions.TryGetValue(reader.GetString(1), out var d)
                && d.Flag("enabled", true)
                && d["writes"].Flag("manual", true)
                && c.SubjectIssue(d, record["subject"]!) is null;
            result[reader.GetString(0)][reader.GetString(1)] = record;
        }
        reader.Close();
        AddDefaultValues(db, c, result, kind, scopeId);
        return result;
    }
}
