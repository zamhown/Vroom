using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;
using Vroom.Core.Storage;

namespace Vroom.Core.Tagging;

public sealed partial class TagEngine
{
    internal static JsonObject NewRecord(
        CompiledDefinitions c,
        JsonObject definition,
        JsonNode subject,
        JsonNode scope,
        JsonNode? value,
        string origin,
        bool locked
    ) =>
        new()
        {
            ["id"] = Guid.NewGuid().ToString("N"),
            ["revision"] = 1,
            ["subject"] = subject.Copy(),
            ["scope"] = scope.Copy(),
            ["tagKey"] = definition.Text("key"),
            ["operation"] = "set",
            ["value"] = value.Copy(),
            ["note"] = "",
            ["definitionHash"] = TagJson.Hash(definition),
            ["valueContractHash"] = c.ValueHash(definition),
            ["origin"] = new JsonObject
            {
                ["kind"] = origin,
                ["contract"] = new JsonObject
                {
                    ["semanticVersion"] = definition["value"]?["semanticVersion"].Copy(),
                    ["unit"] = definition["value"]?["unit"].Copy(),
                    ["cardinality"] = definition["value"]?["cardinality"].Copy(),
                },
            },
            ["provenance"] = new JsonObject { ["observedAt"] = Now },
            ["editPolicy"] = new JsonObject { ["locked"] = locked },
            ["modified"] = Now,
        };

    internal static JsonObject? Head(SqliteConnection db, JsonNode subject, JsonNode scope, string key) =>
        db.Scalar(
            "SELECT payload FROM tag_heads WHERE subject_kind=@k AND subject_id=@id AND scope_id=@s AND tag_key=@t",
            ("@k", subject.Text("kind")),
            ("@id", subject.Text("id")),
            ("@s", ScopeId(scope)),
            ("@t", key)
        )
            is string s
            ? JsonNode.Parse(s)!.AsObject()
            : null;

    internal static void ValidateScope(SqliteConnection db, CompiledDefinitions c, JsonNode subject, JsonObject scope)
    {
        if (subject.Text("kind") == "term")
        {
            c.RequireTerm(subject.Text("id"));
            if (scope.Text("kind") != "whole")
                throw new TagException("SCOPE_UNSUPPORTED");
            return;
        }
        if (subject.Text("kind") != "film")
            throw new TagException("SUBJECT_UNRESOLVED");
        var film = CatalogRepository.RequireFilm(db, subject.Text("id"));
        if (scope.Text("kind") == "whole")
        {
            if (scope.Count > 1)
                throw new TagException("SCOPE_INVALID");
            return;
        }
        if (scope.Text("kind") is not ("point" or "interval") || scope.Text("scopeId").Length is 0 or > 160)
            throw new TagException("SCOPE_INVALID");
        if (scope["partId"] is not null)
            film = CatalogRepository.RequirePart(db, subject.Text("id"), scope.Text("partId"));
        else if (scope.Text("mediaRevision").Length > 0 && scope.Text("mediaRevision") != MediaRevision(film))
            film =
                ReadRows(
                        db,
                        "SELECT payload FROM media_part_projection WHERE id=@id",
                        r => CatalogRepository.Deserialize<Vroom.Core.Domain.Film>(r.GetString(0)),
                        ("@id", film.Id)
                    )
                    .FirstOrDefault(f => MediaRevision(f) == scope.Text("mediaRevision"))
                ?? throw new TagException("STALE_MEDIA");
        if (!long.TryParse(scope.Text("startUs"), out var start) || start < 0)
            throw new TagException("SCOPE_INVALID");
        if (scope.Text("mediaRevision").Length > 0 && scope.Text("mediaRevision") != MediaRevision(film))
            throw new TagException("STALE_MEDIA");
        if (
            scope.Text("kind") == "interval"
            && (
                !long.TryParse(scope.Text("endUs"), out var end)
                || end <= start
                || film.Duration > 0 && end > film.Duration * 1_000_000
            )
        )
            throw new TagException("SCOPE_INVALID");
        if (film.Duration > 0 && start > film.Duration * 1_000_000)
            throw new TagException("SCOPE_INVALID");
        scope["mediaRevision"] = MediaRevision(film);
        scope["partId"] = film.PartId;
    }

    internal static string MediaRevision(Vroom.Core.Domain.Film film) => Vroom.Core.Domain.MediaRevisions.Of(film);

    internal JsonObject Write(
        SqliteConnection db,
        CompiledDefinitions c,
        JsonObject write,
        string origin = "manual",
        bool requireRevision = true
    )
    {
        var subject = write["subject"] ?? throw new TagException("SUBJECT_REQUIRED");
        var scope = write["scope"]?.DeepClone().AsObject() ?? new JsonObject { ["kind"] = "whole" };
        ValidateScope(db, c, subject, scope);
        if (scope.Text("kind") != "whole")
        {
            var existing = ReadRows(
                db,
                "SELECT payload FROM tag_heads WHERE subject_kind=@kind AND subject_id=@id AND scope_id=@scope AND tag_key<>@key",
                r => JsonNode.Parse(r.GetString(0))!,
                ("@kind", subject.Text("kind")),
                ("@id", subject.Text("id")),
                ("@scope", ScopeId(scope)),
                ("@key", write.Text("tagKey"))
            );
            if (
                existing.Any(r =>
                    r["scope"].Text("kind") != scope.Text("kind")
                    || r["scope"].Text("startUs") != scope.Text("startUs")
                    || r["scope"].Text("endUs") != scope.Text("endUs")
                )
            )
                throw new TagException("SCOPE_ID_CONFLICT", ScopeId(scope));
        }
        if (
            subject.Text("kind") == "film"
            && write["mediaRevision"] is not null
            && write.Text("mediaRevision")
                != MediaRevision(
                    scope["partId"] is { } part
                        ? CatalogRepository.RequirePart(db, subject.Text("id"), part.ToString())
                        : CatalogRepository.RequireFilm(db, subject.Text("id"))
                )
        )
            throw new TagException("STALE_MEDIA");
        if (
            subject.Text("kind") == "film"
            && write["factsHash"] is not null
            && write.Text("factsHash")
                != TagJson.Hash(
                    DependencyFacts(
                        Facts(CatalogRepository.RequireFilm(db, subject.Text("id"))),
                        write.List("factPaths").Select(p => p!.ToString())
                    )
                )
        )
            throw new TagException("STALE_MEDIA");
        if (
            write["dependencyHash"] is not null
            && write.Text("dependencyHash")
                != TagJson.Hash(
                    DependencyValues(Values(db, c, subject.Text("kind"), subject.Text("id")), write["dependencyRule"]!)
                )
        )
            throw new TagException("VALUE_REVISION_CONFLICT");
        var d = c.Require(write.Text("tagKey"));
        if (!AnnotationTargets.Supports(d, subject.Text("kind"), scope.Text("kind")))
            throw new TagException("SCOPE_UNSUPPORTED", d.Text("key"));
        if (origin is "manual" or "agent" && !d["writes"].Flag("manual", true))
            throw new TagException("VALUE_READ_ONLY", d.Text("key"));
        if (c.SubjectIssue(d, subject) is { } issue)
            throw new TagException(issue, subject.Text("id"));
        if (
            subject.Text("kind") == "term"
            && write["subjectRevision"] is not null
            && write.Number("subjectRevision") != c.RequireTerm(subject.Text("id")).Number("revision")
        )
            throw new TagException("TERM_REVISION_CONFLICT", subject.Text("id"));
        var old = Head(db, subject, scope, d.Text("key"));
        long revision = (long)(old?.Number("revision") ?? 0);
        if (requireRevision && (write["expectedRevision"] is null || write.Number("expectedRevision") != revision))
            throw new TagException("VALUE_REVISION_CONFLICT", d.Text("key"));
        var op = write.Text("operation", "set");
        if (op is not ("set" or "clear" or "add" or "remove"))
            throw new TagException("OPERATION_UNAVAILABLE");
        JsonNode? value = write["value"].Copy();
        if (op is "add" or "remove")
        {
            if (d["value"].Text("cardinality") != "many")
                throw new TagException("CARDINALITY_MISMATCH");
            var current = old is null ? new JsonArray() : c.Project(old).Value as JsonArray ?? [];
            var items = current.Select(x => x.Copy()).ToList();
            var delta = value as JsonArray ?? new JsonArray(value.Copy());
            foreach (var item in delta)
            {
                if (op == "remove")
                    items.RemoveAll(x => JsonNode.DeepEquals(x, item));
                else if (!items.Any(x => JsonNode.DeepEquals(x, item)))
                    items.Add(item.Copy());
            }
            value = new JsonArray(items.ToArray());
        }
        if (op != "clear" && !c.Accepts(d, value))
            throw new TagException("VALUE_OUT_OF_DOMAIN", d.Text("key"));
        var note = write["note"]?.ToString() ?? old?.Text("note") ?? "";
        if (note.Length > 16000)
            throw new TagException("NOTE_TOO_LONG");
        var locked = write["locked"] is not null ? write.Flag("locked") : origin is "manual" or "agent";
        var finalOp = op == "clear" ? "clear" : "set";
        if (
            old is not null
            && old.Text("operation") == finalOp
            && JsonNode.DeepEquals(old["value"], op == "clear" ? null : value)
            && old.Text("note") == note
            && old["editPolicy"].Flag("locked") == locked
            && JsonNode.DeepEquals(old["scope"], scope)
            && (write["provenance"] is null || JsonNode.DeepEquals(old["provenance"], write["provenance"]))
        )
            return EffectiveRecord(c, old, db);
        var record = NewRecord(c, d, subject, scope, op == "clear" ? null : value, origin, locked);
        record["id"] = old?.Text("id") ?? record.Text("id");
        record["revision"] = revision + 1;
        record["operation"] = finalOp;
        record["note"] = note;
        if (write["provenance"] is JsonObject provenance)
            record["provenance"] = provenance.DeepClone();
        if (old?["editPolicy"]?["suppressedMembers"] is JsonArray prior)
            record["editPolicy"]!["suppressedMembers"] = prior.DeepClone();
        if (op == "remove")
        {
            var suppressed = record["editPolicy"].List("suppressedMembers").DeepClone().AsArray();
            foreach (var member in write["value"] as JsonArray ?? new JsonArray(write["value"].Copy()))
                if (!suppressed.Any(s => JsonNode.DeepEquals(s, member)))
                    suppressed.Add(member.Copy());
            record["editPolicy"]!["suppressedMembers"] = suppressed;
        }
        var changed = new JsonArray(
            new[] { "value", "operation", "note", "scope", "provenance", "editPolicy" }
                .Where(f => !JsonNode.DeepEquals(old?[f], record[f]))
                .Select(f => (JsonNode?)JsonValue.Create(f))
                .ToArray()
        );
        SaveRecord(db, c, record);
        Emit(
            db,
            op == "clear" ? "annotation.cleared" : "annotation.changed",
            new JsonObject
            {
                ["subject"] = subject.Copy(),
                ["scope"] = scope.Copy(),
                ["tagKey"] = d.Text("key"),
                ["oldRevision"] = revision,
                ["newRevision"] = revision + 1,
                ["origin"] = origin,
                ["changedFields"] = changed,
            }
        );
        return EffectiveRecord(c, record, db);
    }

    internal static JsonObject EffectiveRecord(CompiledDefinitions c, JsonObject record, SqliteConnection? db = null)
    {
        var (value, issue) = db is null ? c.Project(record) : Project(db, c, record);
        var result = record.DeepClone().AsObject();
        result["value"] = value;
        result["status"] = issue ?? (record.Text("operation") == "clear" ? "unset" : "valid");
        result["canWrite"] =
            c.Definitions.TryGetValue(record.Text("tagKey"), out var d)
            && d.Flag("enabled", true)
            && d["writes"].Flag("manual", true)
            && c.SubjectIssue(d, record["subject"]!) is null;
        return result;
    }

    public async Task<JsonObject> BatchAsync(JsonObject args, string origin = "manual", CancellationToken ct = default)
    {
        await InitializeAsync(ct);
        return await repository.Database.RunAsync(
            db =>
            {
                using var tx = db.BeginTransaction();
                var hash = TagJson.Hash(args);
                var key = args.Text("idempotencyKey");
                if (key.Length > 0)
                {
                    using var cmd = db.Command(
                        "SELECT request_hash,result FROM tag_idempotency WHERE key=@k",
                        ("@k", key)
                    );
                    using var r = cmd.ExecuteReader();
                    if (r.Read())
                    {
                        if (r.GetString(0) != hash)
                            throw new TagException("IDEMPOTENCY_CONFLICT");
                        return JsonNode.Parse(r.GetString(1))!.AsObject();
                    }
                }
                if (args["expectedGeneration"] is null || args.Number("expectedGeneration") != Generation(db))
                    throw new TagException("STALE_GENERATION");
                var writes = args.List("writes");
                if (writes.Count is 0 or > 1000)
                    throw new TagException("BATCH_LIMIT");
                if (writes.Any(w => w is not JsonObject))
                    throw new TagException("WRITE_INVALID");
                var seen = new HashSet<string>();
                var result = new JsonArray();
                var c = Current(db);
                foreach (var w in writes.OfType<JsonObject>())
                {
                    ct.ThrowIfCancellationRequested();
                    var binding =
                        TagJson.Canonical(w["subject"])
                        + ScopeId(w["scope"] ?? new JsonObject { ["kind"] = "whole" })
                        + w.Text("tagKey");
                    if (!seen.Add(binding))
                        throw new TagException("DUPLICATE_WRITE");
                    result.Add(Write(db, c, w, origin));
                }
                ValidateTermGraph(db);
                var output = new JsonObject { ["generation"] = Generation(db), ["records"] = result };
                if (key.Length > 0)
                    db.Execute(
                        "INSERT INTO tag_idempotency VALUES(@k,@h,@r)",
                        ("@k", key),
                        ("@h", hash),
                        ("@r", output.ToJsonString())
                    );
                Audit(
                    db,
                    "annotations.batch",
                    new JsonObject
                    {
                        ["origin"] = origin,
                        ["count"] = writes.Count,
                        ["idempotencyKey"] = key,
                    }
                );
                tx.Commit();
                return output;
            },
            ct
        );
    }

    internal static JsonObject Values(
        SqliteConnection db,
        CompiledDefinitions c,
        string kind,
        string id,
        JsonNode? scope = null
    )
    {
        return ValuesForMany(db, c, kind, [id], scope is null ? "whole" : ScopeId(scope))[id];
    }

    public async Task<JsonObject> AnnotationsAsync(JsonObject args, CancellationToken ct = default)
    {
        await InitializeAsync(ct);
        return await repository.Database.ReadAsync(
            db =>
            {
                var c = Current(db);
                var subject = args["subject"] ?? new JsonObject { ["kind"] = "film", ["id"] = args.Text("id") };
                var records = Records(db, subject.Text("id"))
                    .Where(r => r["subject"].Text("kind") == subject.Text("kind"))
                    .ToArray();
                return new JsonObject
                {
                    ["generation"] = Generation(db),
                    ["values"] = Values(db, c, subject.Text("kind"), subject.Text("id"), args["scope"]),
                    ["annotations"] = new JsonArray(
                        records
                            .Where(r => r["scope"].Text("kind") != "whole" && Project(db, c, r).Value is not null)
                            .Select(r => (JsonNode?)EffectiveRecord(c, r, db))
                            .ToArray()
                    ),
                };
            },
            ct
        );
    }

    public async Task<object> EventsAsync(long cursor, CancellationToken ct = default)
    {
        await InitializeAsync(ct);
        return await repository.Database.ReadAsync(
            db =>
                ReadRows(
                    db,
                    "SELECT sequence,payload FROM tag_events WHERE sequence>@c ORDER BY sequence LIMIT 200",
                    r => new { sequence = r.GetInt64(0), data = JsonNode.Parse(r.GetString(1)) },
                    ("@c", cursor)
                ),
            ct
        );
    }

    public async Task<object> IssuesAsync(CancellationToken ct = default)
    {
        await InitializeAsync(ct);
        return await repository.Database.ReadAsync(
            db =>
                ReadRows(
                    db,
                    "SELECT subject_kind,subject_id,scope_id,tag_key,code,revision FROM tag_issues LIMIT 500",
                    r => new
                    {
                        subject = new { kind = r.GetString(0), id = r.GetString(1) },
                        scopeId = r.GetString(2),
                        tagKey = r.GetString(3),
                        code = r.GetString(4),
                        revision = r.GetInt64(5),
                    }
                ),
            ct
        );
    }

    public async Task<object> HistoryAsync(string id, CancellationToken ct = default)
    {
        await InitializeAsync(ct);
        return await repository.Database.ReadAsync(
            db =>
                ReadRows(
                    db,
                    "SELECT payload FROM tag_history WHERE id=@id ORDER BY revision DESC LIMIT 100",
                    r => JsonNode.Parse(r.GetString(0)),
                    ("@id", id)
                ),
            ct
        );
    }
}
