using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;
using Vroom.Core.Domain;
using Vroom.Core.Storage;

namespace Vroom.Core.Tagging;

/// <summary>One transaction boundary for UI, automation and Agent. No business tag is known here.</summary>
public sealed partial class TagEngine(CatalogRepository repository)
{
    internal CatalogRepository Repository => repository;
    private readonly DefinitionCompiler compiler = new();
    private readonly System.Collections.Concurrent.ConcurrentDictionary<
        (string Package, string Terms),
        CompiledDefinitions
    > cache = new();
    private volatile bool ready;
    private JsonObject? initializationWarning;

    public Task InitializeAsync(CancellationToken ct = default) =>
        ready
            ? Task.CompletedTask
            : repository.Database.RunAsync(
                db =>
                {
                    var system = TagResources.Json("core.tagdefs.json");
                    var systemHash = TagJson.Hash(system);
                    var initialized = db.Scalar("SELECT system_hash FROM tag_state WHERE id=1") as string;
                    if (initialized == systemHash)
                    {
                        using var unchanged = db.BeginTransaction();
                        RefreshMediaProjection(db);
                        unchanged.Commit();
                        ready = true;
                        return;
                    }
                    using var tx = db.BeginTransaction();
                    var effective = Merge(db, system);
                    CompiledDefinitions compiled;
                    try
                    {
                        compiled = Compile(db, effective);
                    }
                    catch (TagException e) when (initialized is not null)
                    {
                        tx.Rollback();
                        _ = Current(db);
                        initializationWarning = new JsonObject
                        {
                            ["code"] = "SYSTEM_UPDATE_CONFLICT",
                            ["cause"] = e.Code,
                            ["path"] = e.Pointer,
                        };
                        using var fallback = db.BeginTransaction();
                        RefreshMediaProjection(db);
                        Audit(
                            db,
                            "config.system-update-conflict",
                            new() { ["error"] = initializationWarning.DeepClone() }
                        );
                        fallback.Commit();
                        ready = true;
                        return;
                    }
                    var generation = Generation(db) + 1;
                    db.Execute(
                        "INSERT INTO tag_state VALUES(1,@g,@h,@p) ON CONFLICT(id) DO UPDATE SET generation=@g,system_hash=@h,package=@p",
                        ("@g", generation),
                        ("@h", systemHash),
                        ("@p", effective.ToJsonString())
                    );
                    db.Execute(
                        "INSERT INTO tag_generations VALUES(@g,@p,@t)",
                        ("@g", generation),
                        ("@p", effective.ToJsonString()),
                        ("@t", Now)
                    );
                    Reproject(db, compiled);
                    db.Execute("DELETE FROM settings WHERE key='media.projectionPending'");
                    ValidateTermGraph(db);
                    Emit(
                        db,
                        "definition.activated",
                        new JsonObject
                        {
                            ["generation"] = generation,
                            ["reason"] = initialized is null ? "initialization" : "system-update",
                        }
                    );
                    tx.Commit();
                    ready = true;
                },
                ct
            );

    private void RefreshMediaProjection(SqliteConnection db)
    {
        if (db.Scalar("SELECT value FROM settings WHERE key='media.projectionPending'") as string != "true")
            return;
        var c = Current(db);
        foreach (
            var record in Records(db)
                .Where(r => r["subject"].Text("kind") == "film" && r["scope"].Text("kind") != "whole")
        )
            ProjectRecord(db, c, record);
        ValidateTermGraph(db);
        db.Execute("DELETE FROM settings WHERE key='media.projectionPending'");
    }

    private static JsonObject ClientPackage(CompiledDefinitions c)
    {
        // Include disabled overrides so clients cannot resurrect a built-in seed.
        var p = c.Package.DeepClone().AsObject();
        p["terms"] = new JsonArray(c.Terms.Values.Select(t => t.DeepClone()).ToArray());
        return p;
    }

    internal static string Now => DateTimeOffset.UtcNow.ToString("O");

    internal static long Generation(SqliteConnection db) =>
        Convert.ToInt64(db.Scalar("SELECT generation FROM tag_state WHERE id=1") ?? 0);

    internal CompiledDefinitions Current(SqliteConnection db)
    {
        var json =
            (string?)db.Scalar("SELECT package FROM tag_state WHERE id=1") ?? throw new TagException("NOT_INITIALIZED");
        // Keyed by the stored package text and the term stamp (no concatenated copy). The package text
        // stays part of the key so a rolled-back publication can never be served under a reused generation.
        var key = (json, (string?)db.Scalar("SELECT stamp FROM tag_terms_stamp WHERE id=1") ?? "");
        if (cache.TryGetValue(key, out var c))
            return c;
        c = Compile(db, JsonNode.Parse(json)!.AsObject());
        // Bounded: evict single entries instead of discarding every compiled package at once.
        while (cache.Count >= 4 && cache.Keys.FirstOrDefault() is var oldest && oldest != default)
            cache.TryRemove(oldest, out _);
        cache[key] = c;
        return c;
    }

    internal static JsonObject Merge(SqliteConnection db, JsonObject system, IEnumerable<JsonObject>? changes = null)
    {
        var objects = new Dictionary<(string, string), JsonNode>();
        using (var cmd = db.Command("SELECT kind,key,payload FROM tag_objects"))
        using (var r = cmd.ExecuteReader())
            while (r.Read())
                objects[(r.GetString(0), r.GetString(1))] = JsonNode.Parse(r.GetString(2))!;
        foreach (var change in changes ?? [])
        {
            var key = (change.Text("kind"), change.Text("key"));
            if (change.Flag("restore"))
                objects.Remove(key);
            else
                objects[key] = change["value"]!.DeepClone();
        }
        var merged = system.DeepClone().AsObject();
        var defs = merged.List("definitions").OfType<JsonObject>().ToDictionary(d => d.Text("key"), d => d.DeepClone());
        foreach (var ((kind, key), value) in objects)
        {
            if (kind == "definition")
                defs[key] = value.DeepClone();
            else if (kind == "catalogPolicy")
                merged["catalogPolicy"] = value.DeepClone();
            else if (kind.StartsWith("ui.", StringComparison.Ordinal))
            {
                var field = kind[3..];
                var container = merged["ui"]!.AsObject();
                container[field] ??= new JsonObject();
                container[field]![key] = value.DeepClone();
            }
            else if (kind == "message")
            {
                merged["i18n"]!["messages"]![key] = value.DeepClone();
            }
            else
            {
                merged[kind] ??= new JsonObject();
                merged[kind]![key] = value.DeepClone();
            }
        }
        merged["definitions"] = new JsonArray(
            defs.OrderBy(p => p.Key, StringComparer.Ordinal).Select(p => p.Value).ToArray()
        );
        return merged;
    }

    public async Task<JsonObject> SnapshotAsync(CancellationToken ct = default)
    {
        await InitializeAsync(ct);
        return await repository.Database.ReadAsync(
            db => new JsonObject
            {
                ["generation"] = Generation(db),
                ["package"] = ClientPackage(Current(db)),
                ["issueCount"] = Convert.ToInt64(db.Scalar("SELECT COUNT(*) FROM tag_issues")),
                ["warning"] = initializationWarning?.DeepClone(),
                ["cursor"] = Convert.ToInt64(db.Scalar("SELECT COALESCE(MAX(sequence),0) FROM tag_events")),
            },
            ct
        );
    }

    public async Task<JsonObject> GetConfigAsync(JsonObject args, CancellationToken ct = default)
    {
        await InitializeAsync(ct);
        return await repository.Database.ReadAsync(
            db =>
            {
                var kind = args.Text("kind", "definition");
                var key = args.Text("key");
                var saved =
                    db.Scalar("SELECT payload FROM tag_objects WHERE kind=@k AND key=@id", ("@k", kind), ("@id", key))
                    as string;
                var package = Current(db).Package;
                JsonNode? Value(JsonObject p) =>
                    kind == "definition" ? p.List("definitions").FirstOrDefault(d => d.Text("key") == key)
                    : kind == "catalogPolicy" ? p["catalogPolicy"]
                    : kind == "message" ? p["i18n"]?["messages"]?[key]
                    : kind.StartsWith("ui.") ? p["ui"]?[kind[3..]]?[key]
                    : p[kind]?[key];
                return new JsonObject
                {
                    ["generation"] = Generation(db),
                    ["system"] = Value(TagResources.Json("core.tagdefs.json")).Copy(),
                    ["user"] = saved is null ? null : JsonNode.Parse(saved),
                    ["effective"] = Value(package).Copy(),
                };
            },
            ct
        );
    }

    private static readonly HashSet<string> ConfigKinds =
    [
        "definition",
        "groups",
        "vocabularies",
        "rules",
        "sources",
        "catalogPolicy",
        "message",
        "i18n",
        "eventBindings",
        "ui.layouts",
        "ui.placementOrder",
        "ui.surfaceBindings",
        "ui.actions",
        "ui.identity",
        "ui.naming",
        "ui.agentHints",
    ];

    internal static JsonObject[] Changes(JsonObject args)
    {
        if (args.Text("layer", "user") != "user")
            throw new TagException("SYSTEM_LAYER_READ_ONLY");
        var input = args.List("changes");
        if (input.Any(c => c is not JsonObject))
            throw new TagException("CHANGE_INVALID");
        var changes = input.OfType<JsonObject>().ToArray();
        if (changes.Length == 0 || changes.Length > 50000)
            throw new TagException("CHANGES_REQUIRED");
        var seen = new HashSet<string>();
        foreach (var c in changes)
        {
            if (!ConfigKinds.Contains(c.Text("kind")) || c.Text("key").Length == 0)
                throw new TagException("CONFIG_KIND_UNAVAILABLE");
            if (c.Text("kind") == "i18n" && c.Text("key") != "defaultLocale")
                throw new TagException("CONFIG_KEY_UNAVAILABLE");
            if (!seen.Add(c.Text("kind") + ":" + c.Text("key")))
                throw new TagException("DUPLICATE_KEY");
            if (!c.Flag("restore") && c["value"] is null)
                throw new TagException("VALUE_REQUIRED");
            if (c.Text("kind") == "definition" && !c.Flag("restore") && c["value"].Text("key") != c.Text("key"))
                throw new TagException("KEY_MISMATCH");
        }
        return changes;
    }

    public async Task<JsonObject> PreviewConfigAsync(JsonObject args, CancellationToken ct = default)
    {
        await InitializeAsync(ct);
        var changes = Changes(args);
        return await repository.Database.RunAsync(
            db =>
            {
                if (args["expectedGeneration"] is not null && args.Number("expectedGeneration") != Generation(db))
                    throw new TagException("STALE_GENERATION");
                var current = Current(db);
                var candidate = Compile(db, Merge(db, TagResources.Json("core.tagdefs.json"), changes));
                var affected = new JsonArray();
                var valueChanges = new JsonArray();
                long count;
                int projected;
                long changedValues;
                var priorIssues = ReadRows(
                        db,
                        "SELECT subject_kind||':'||subject_id||':'||scope_id||':'||tag_key||':'||code FROM tag_issues",
                        r => r.GetString(0)
                    )
                    .ToHashSet();
                db.Execute("CREATE TEMP TABLE config_effective_before AS SELECT * FROM tag_effective");
                var newIssues = 0;
                db.Execute("SAVEPOINT config_graph");
                try
                {
                    projected = ReprojectChanged(db, current, candidate, ct);
                    ValidateTermGraph(db);
                    count = Convert.ToInt64(db.Scalar("SELECT COUNT(*) FROM tag_issues"));
                    newIssues = ReadRows(
                            db,
                            "SELECT subject_kind||':'||subject_id||':'||scope_id||':'||tag_key||':'||code FROM tag_issues",
                            r => r.GetString(0)
                        )
                        .Count(key => !priorIssues.Contains(key));
                    const string diff =
                        "SELECT subject_kind,subject_id,scope_id,tag_key FROM (SELECT subject_kind,subject_id,scope_id,tag_key,value_json FROM config_effective_before EXCEPT SELECT subject_kind,subject_id,scope_id,tag_key,value_json FROM tag_effective) UNION SELECT subject_kind,subject_id,scope_id,tag_key FROM (SELECT subject_kind,subject_id,scope_id,tag_key,value_json FROM tag_effective EXCEPT SELECT subject_kind,subject_id,scope_id,tag_key,value_json FROM config_effective_before)";
                    changedValues = Convert.ToInt64(db.Scalar("SELECT COUNT(*) FROM (" + diff + ")"));
                    foreach (
                        var row in ReadRows(
                            db,
                            "WITH changes AS ("
                                + diff
                                + ") SELECT k.subject_kind,k.subject_id,k.tag_key,b.value_json,a.value_json FROM changes k LEFT JOIN config_effective_before b USING(subject_kind,subject_id,scope_id,tag_key) LEFT JOIN tag_effective a USING(subject_kind,subject_id,scope_id,tag_key) LIMIT 40",
                            r =>
                                (JsonNode?)
                                    new JsonObject
                                    {
                                        ["subject"] = new JsonObject
                                        {
                                            ["kind"] = r.GetString(0),
                                            ["id"] = r.GetString(1),
                                        },
                                        ["tagKey"] = r.GetString(2),
                                        ["before"] = r.IsDBNull(3) ? null : JsonNode.Parse(r.GetString(3)),
                                        ["after"] = r.IsDBNull(4) ? null : JsonNode.Parse(r.GetString(4)),
                                    }
                        )
                    )
                        valueChanges.Add(row);
                    foreach (
                        var issue in ReadRows(
                                db,
                                "SELECT subject_kind,subject_id,scope_id,tag_key,code FROM tag_issues",
                                r => new
                                {
                                    Key = string.Join(":", Enumerable.Range(0, 5).Select(r.GetString)),
                                    Value = (JsonNode)
                                        new JsonObject
                                        {
                                            ["subject"] = new JsonObject
                                            {
                                                ["kind"] = r.GetString(0),
                                                ["id"] = r.GetString(1),
                                            },
                                            ["tagKey"] = r.GetString(3),
                                            ["code"] = r.GetString(4),
                                        },
                                }
                            )
                            .Where(i => !priorIssues.Contains(i.Key))
                            .Take(100)
                    )
                        affected.Add(issue.Value);
                }
                finally
                {
                    db.Execute("ROLLBACK TO config_graph; RELEASE config_graph; DROP TABLE config_effective_before;");
                }
                var automaticChanged = changes.Any(change =>
                    change.Text("kind") is "eventBindings" or "catalogPolicy" or "sources"
                    || change.Text("kind") == "definition"
                        && current.Definitions.TryGetValue(change.Text("key"), out var old)
                        && new[] { "initialization", "automation", "enrichment" }.Any(k =>
                            !JsonNode.DeepEquals(old[k], change["value"]?[k])
                        )
                );
                var token = Guid.NewGuid().ToString("N");
                var payload = new JsonObject
                {
                    ["changes"] = new JsonArray(changes.Select(c => c.DeepClone()).ToArray()),
                    ["hash"] = candidate.Hash,
                };
                db.Execute(
                    "INSERT INTO tag_previews VALUES(@id,'config',@g,@p,NULL,@t)",
                    ("@id", token),
                    ("@g", Generation(db)),
                    ("@p", payload.ToJsonString()),
                    ("@t", Now)
                );
                return new JsonObject
                {
                    ["previewToken"] = token,
                    ["generation"] = Generation(db),
                    ["hash"] = candidate.Hash,
                    ["affectedCount"] = count,
                    ["projectedCount"] = projected,
                    ["impact"] = new JsonObject
                    {
                        ["newInvalid"] = newIssues,
                        ["changedValues"] = changedValues,
                        ["automaticChanged"] = automaticChanged,
                        ["requiresReview"] = newIssues > 0 || changedValues > 0,
                    },
                    ["valueChanges"] = valueChanges,
                    ["issues"] = affected,
                    ["package"] = candidate.Package.DeepClone(),
                };
            },
            ct
        );
    }

    public async Task<JsonObject> ApplyConfigAsync(
        JsonObject args,
        CancellationToken ct = default,
        Action<int>? progress = null,
        Action? beforeCommit = null
    )
    {
        await InitializeAsync(ct);
        var result = await repository.Database.RunAsync(
            db =>
            {
                using var tx = db.BeginTransaction();
                var (preview, gen, existing) = Preview(db, args.Text("previewToken"), "config");
                if (existing is not null)
                    return JsonNode.Parse(existing)!.AsObject();
                if (gen != Generation(db) || args.Number("expectedGeneration", gen) != gen)
                    throw new TagException("STALE_GENERATION");
                var current = Current(db);
                var changes = preview.List("changes").OfType<JsonObject>().ToArray();
                var compiled = Compile(db, Merge(db, TagResources.Json("core.tagdefs.json"), changes));
                if (compiled.Hash != preview.Text("hash"))
                    throw new TagException("PREVIEW_CHANGED");
                foreach (var c in changes)
                    StoreObject(db, c);
                var next = gen + 1;
                db.Execute(
                    "UPDATE tag_state SET generation=@g,package=@p WHERE id=1",
                    ("@g", next),
                    ("@p", compiled.Package.ToJsonString())
                );
                db.Execute(
                    "INSERT INTO tag_generations VALUES(@g,@p,@t)",
                    ("@g", next),
                    ("@p", compiled.Package.ToJsonString()),
                    ("@t", Now)
                );
                var projected = ReprojectChanged(db, current, compiled, ct, progress);
                ValidateTermGraph(db);
                Emit(
                    db,
                    "definition.activated",
                    new JsonObject { ["generation"] = next, ["previousGeneration"] = gen }
                );
                var output = new JsonObject
                {
                    ["generation"] = next,
                    ["projectedCount"] = projected,
                    ["issueCount"] = Convert.ToInt64(db.Scalar("SELECT COUNT(*) FROM tag_issues")),
                };
                db.Execute(
                    "UPDATE tag_previews SET result=@r WHERE id=@id",
                    ("@r", output.ToJsonString()),
                    ("@id", args.Text("previewToken"))
                );
                Audit(
                    db,
                    "config.apply",
                    new JsonObject { ["changes"] = preview["changes"].Copy(), ["generation"] = next }
                );
                ct.ThrowIfCancellationRequested();
                beforeCommit?.Invoke();
                tx.Commit();
                return output;
            },
            ct
        );
        try
        {
            await PersistUserFilesAsync(CancellationToken.None);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            await repository.AuditAsync("config.mirror-pending", e.Message, CancellationToken.None);
            result["mirrorPending"] = true;
        }
        return result;
    }

    internal static void StoreObject(SqliteConnection db, JsonObject c)
    {
        if (c.Flag("restore"))
            db.Execute(
                "DELETE FROM tag_objects WHERE kind=@k AND key=@id",
                ("@k", c.Text("kind")),
                ("@id", c.Text("key"))
            );
        else
            db.Execute(
                "INSERT INTO tag_objects VALUES(@k,@id,@p) ON CONFLICT(kind,key) DO UPDATE SET payload=@p",
                ("@k", c.Text("kind")),
                ("@id", c.Text("key")),
                ("@p", c["value"]!.ToJsonString())
            );
    }

    private async Task PersistUserFilesAsync(CancellationToken ct)
    {
        var snapshot = await repository.Database.RunAsync(
            db => new
            {
                Generation = Generation(db),
                Objects = ReadRows(
                    db,
                    "SELECT kind,key,payload FROM tag_objects",
                    r => new JsonObject
                    {
                        ["kind"] = r.GetString(0),
                        ["key"] = r.GetString(1),
                        ["value"] = JsonNode.Parse(r.GetString(2)),
                    }
                ),
            },
            ct
        );
        var path = Path.Combine(
            repository.Database.DataDirectory,
            "config",
            "user",
            "revisions",
            snapshot.Generation.ToString()
        );
        Directory.CreateDirectory(path);
        var destination = Path.Combine(path, "objects.json");
        var temp = destination + "." + Guid.NewGuid().ToString("N") + ".tmp";
        await File.WriteAllTextAsync(temp, JsonSerializer.Serialize(snapshot.Objects, TagJson.Options), ct);
        File.Move(temp, destination, true);
    }

    internal static List<T> ReadRows<T>(
        SqliteConnection db,
        string sql,
        Func<SqliteDataReader, T> read,
        params (string Name, object? Value)[] args
    )
    {
        using var cmd = db.Command(sql, args);
        using var r = cmd.ExecuteReader();
        var list = new List<T>();
        while (r.Read())
            list.Add(read(r));
        return list;
    }

    internal static List<JsonObject> Records(SqliteConnection db, string? subject = null) =>
        ReadRows(
            db,
            "SELECT payload FROM tag_heads" + (subject is null ? "" : " WHERE subject_id=@id"),
            r => JsonNode.Parse(r.GetString(0))!.AsObject(),
            ("@id", subject)
        );

    internal static (JsonObject Payload, long Generation, string? Result) Preview(
        SqliteConnection db,
        string id,
        string kind
    )
    {
        using var cmd = db.Command(
            "SELECT payload,generation,result FROM tag_previews WHERE id=@id AND kind=@k",
            ("@id", id),
            ("@k", kind)
        );
        using var r = cmd.ExecuteReader();
        if (!r.Read())
            throw new TagException("PREVIEW_NOT_FOUND");
        return (JsonNode.Parse(r.GetString(0))!.AsObject(), r.GetInt64(1), r.IsDBNull(2) ? null : r.GetString(2));
    }

    internal static string ScopeId(JsonNode scope) => scope.Text("kind") == "whole" ? "whole" : scope.Text("scopeId");

    internal static void SaveRecord(SqliteConnection db, CompiledDefinitions c, JsonObject record)
    {
        var subject = record["subject"]!;
        db.Execute(
            "INSERT INTO tag_history VALUES(@id,@r,@p)",
            ("@id", record.Text("id")),
            ("@r", record.Number("revision")),
            ("@p", record.ToJsonString())
        );
        db.Execute(
            "INSERT INTO tag_heads VALUES(@k,@s,@scope,@tag,@id,@r,@p) ON CONFLICT(subject_kind,subject_id,scope_id,tag_key) DO UPDATE SET id=@id,revision=@r,payload=@p",
            ("@k", subject.Text("kind")),
            ("@s", subject.Text("id")),
            ("@scope", ScopeId(record["scope"]!)),
            ("@tag", record.Text("tagKey")),
            ("@id", record.Text("id")),
            ("@r", record.Number("revision")),
            ("@p", record.ToJsonString())
        );
        ProjectRecord(db, c, record);
    }

    internal static readonly AsyncLocal<(string Root, int Depth)?> EventFlow = new();

    internal static string Emit(SqliteConnection db, string type, JsonObject payload, string? eventId = null)
    {
        eventId ??= Guid.NewGuid().ToString("N");
        var envelope = new JsonObject
        {
            ["eventId"] = eventId,
            ["type"] = type,
            ["schemaVersion"] = 1,
            ["generation"] = Generation(db),
            ["occurredAt"] = Now,
            ["payload"] = payload,
            ["rootEventId"] = EventFlow.Value?.Root ?? eventId,
            ["depth"] = EventFlow.Value?.Depth ?? 0,
        };
        db.Execute(
            "INSERT OR IGNORE INTO tag_events(event_id,payload) VALUES(@id,@p)",
            ("@id", eventId),
            ("@p", envelope.ToJsonString())
        );
        return eventId;
    }

    internal static void Audit(SqliteConnection db, string operation, JsonObject data) =>
        db.Execute(
            "INSERT INTO audit(time,tool,summary) VALUES(@t,@op,@p)",
            ("@t", Now),
            ("@op", operation),
            ("@p", data.ToJsonString())
        );
}
