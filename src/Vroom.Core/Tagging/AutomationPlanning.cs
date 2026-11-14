using System.Text.Json.Nodes;
using Vroom.Core.Storage;

namespace Vroom.Core.Tagging;

public sealed partial class TagEngine
{
    internal sealed record Decision(string State, JsonNode? Value, string? CaseId, string[] Missing, int Matches);

    internal static IEnumerable<string> FactDependencies(JsonNode? node)
    {
        if (node is JsonObject o)
        {
            if (o["fact"] is JsonValue v)
                yield return v.ToString();
            foreach (var pair in o)
            foreach (var path in FactDependencies(pair.Value))
                yield return path;
        }
        else if (node is JsonArray a)
            foreach (var item in a)
            foreach (var path in FactDependencies(item))
                yield return path;
    }

    internal static Decision MatchDecision(JsonObject rule, JsonObject values, JsonObject facts)
    {
        var missing = FactDependencies(rule).Distinct().Where(p => TagJson.Get(facts, p) is null).ToArray();
        if (missing.Length > 0)
            return new("waiting", null, null, missing, 0);
        if (rule["when"] is not null)
        {
            var gate = Evaluate(rule["when"], values, facts);
            if (gate is null)
                return new("waiting", null, null, [], 0);
            if (gate.ToString() != "true")
                return new("unmatched", null, null, [], 0);
        }
        var matches = new List<JsonNode>();
        foreach (var row in rule["args"].List("cases"))
        {
            var result = Evaluate(row?["when"], values, facts);
            if (result is null)
                return new("waiting", null, null, [], 0);
            if (result is JsonValue b && b.TryGetValue<bool>(out var flag) && flag)
                matches.Add(row!);
        }
        return matches.Count == 0
            ? new("unmatched", null, null, [], 0)
            : new("matched", matches[0]["value"].Copy(), matches[0].Text("id"), [], matches.Count);
    }

    internal static JsonObject DependencyFacts(JsonObject facts, IEnumerable<string> paths) =>
        new(paths.Distinct().Order().Select(p => new KeyValuePair<string, JsonNode?>(p, TagJson.Get(facts, p).Copy())));

    internal static JsonObject DependencyValues(JsonObject values, JsonNode rule)
    {
        IEnumerable<string> Tags(JsonNode? n)
        {
            if (n is JsonObject o)
            {
                if (o["tag"] is JsonValue t)
                    yield return t.ToString();
                foreach (var v in o)
                foreach (var p in Tags(v.Value))
                    yield return p;
            }
            else if (n is JsonArray a)
                foreach (var v in a)
                foreach (var p in Tags(v))
                    yield return p;
        }
        return new(Tags(rule).Distinct().Order().Select(p => new KeyValuePair<string, JsonNode?>(p, values[p].Copy())));
    }

    public async Task<bool> RequiresProbeAsync(CancellationToken ct = default)
    {
        await InitializeAsync(ct);
        return await repository.Database.ReadAsync(
            db =>
                Current(db)
                    .Definitions.Values.Where(d => d.Flag("enabled", true))
                    .Any(d =>
                        d.List("initialization")
                            .Concat(d.List("automation"))
                            .Any(r =>
                                r.Text("event") == "media.probed"
                                || FactDependencies(r).Any(p => p.StartsWith("probe."))
                            )
                    ),
            ct
        );
    }

    public async Task<string[]> AutomationProbeIdsAsync(JsonObject args, CancellationToken ct = default)
    {
        await InitializeAsync(ct);
        return await repository.Database.ReadAsync(
            db =>
            {
                var c =
                    args.List("changes").Count > 0
                        ? Compile(db, Merge(db, TagResources.Json("core.tagdefs.json"), Changes(args)))
                        : Current(db);
                var field = c.Require(args.Text("tagKey"));
                var paths = FactDependencies(
                        new JsonArray(
                            field
                                .List("initialization")
                                .Concat(field.List("automation"))
                                .Select(r => r.Copy())
                                .ToArray()
                        )
                    )
                    .Where(p => p.StartsWith("probe."))
                    .Distinct()
                    .ToArray();
                var ids = args.List("subjectIds").Select(id => id!.ToString()).Distinct().ToArray();
                if (args["subjectIds"] is not null && ids.Length == 0)
                    throw new TagException("TARGETS_REQUIRED");
                if (ids.Length == 0)
                {
                    var (where, q) = CompileQuery(c, args["query"] as JsonObject ?? new());
                    ids = ReadRows(
                            db,
                            $"SELECT f.id FROM films f WHERE {where} ORDER BY f.id LIMIT 100001",
                            r => r.GetString(0),
                            [.. q.Parameters]
                        )
                        .ToArray();
                }
                if (ids.Length > 100000)
                    throw new TagException("BATCH_LIMIT");
                return ids.Where(id =>
                    {
                        var film = CatalogRepository.RequireFilm(db, id);
                        return film.ProbeState != "ready" && paths.Any(p => TagJson.Get(Facts(film), p) is null);
                    })
                    .ToArray();
            },
            ct
        );
    }

    // A frozen, ordered ID list is shared by playback and selection-based tasks; pagination is presentation only.
    public async Task<JsonObject> QueryIdsAsync(JsonObject args, CancellationToken ct = default)
    {
        await InitializeAsync(ct);
        return await repository.Database.ReadAsync(
            db =>
            {
                var c = Current(db);
                var (where, q) = CompileQuery(c, args);
                var (columns, join) = q.Groups(args);
                var order = q.Order(args);
                var ids = ReadRows(
                    db,
                    Sectioned(args, columns)
                        ? $"SELECT f.id FROM films f {join} WHERE {where} ORDER BY {GroupTuple(columns)},{order}"
                        : $"SELECT f.id FROM films f WHERE {where} ORDER BY {order}",
                    r => (JsonNode?)JsonValue.Create(r.GetString(0)),
                    [.. q.Parameters]
                );
                return new JsonObject
                {
                    ["ids"] = new JsonArray(ids.ToArray()),
                    ["count"] = ids.Count,
                    ["generation"] = Generation(db),
                };
            },
            ct
        );
    }

    public async Task<JsonObject> PreviewAutomationAsync(JsonObject args, CancellationToken ct = default)
    {
        await InitializeAsync(ct);
        return await repository.Database.RunAsync(
            db =>
            {
                using var tx = db.BeginTransaction();
                var generation = Generation(db);
                if (args["expectedGeneration"] is not null && args.Number("expectedGeneration") != generation)
                    throw new TagException("STALE_GENERATION");
                var draft = args.List("changes").Count > 0;
                var c = draft
                    ? Compile(db, Merge(db, TagResources.Json("core.tagdefs.json"), Changes(args)))
                    : Current(db);
                var field = c.Require(args.Text("tagKey"));
                if (!field.Flag("enabled", true) || !AnnotationTargets.Supports(field, "film", "whole"))
                    throw new TagException("RULE_TARGET_UNSUPPORTED");
                var rules = field
                    .List("initialization")
                    .Concat(field.List("automation"))
                    .Where(r => r.Text("executor") == "value.match@1")
                    .OfType<JsonObject>()
                    .ToArray();
                if (rules.Length == 0)
                    throw new TagException("RULE_REQUIRED");
                var token = Guid.NewGuid().ToString("N");
                var samples = new JsonArray();
                var counts = new Dictionary<string, int>();
                var ordinal = 0;
                var ids = args.List("subjectIds").Select(x => x!.ToString()).Distinct().ToArray();
                var synthetic = args.List("samples");
                if (synthetic.Count > 0 && ids.Length > 0)
                    throw new TagException("TARGETS_INVALID");
                if (
                    args["subjectIds"] is not null && ids.Length == 0
                    || args["samples"] is not null && synthetic.Count == 0
                )
                    throw new TagException("TARGETS_REQUIRED");
                if (synthetic.Count > 100)
                    throw new TagException("BATCH_LIMIT");
                if (ids.Length == 0 && synthetic.Count == 0)
                {
                    var query = args["query"] as JsonObject ?? new();
                    var (where, q) = CompileQuery(c, query);
                    ids = ReadRows(
                            db,
                            $"SELECT f.id FROM films f WHERE {where} ORDER BY f.id LIMIT 100001",
                            r => r.GetString(0),
                            [.. q.Parameters]
                        )
                        .ToArray();
                }
                if (ids.Length > 100000)
                    throw new TagException("BATCH_LIMIT");
                void Inspect(string? id, JsonObject facts, JsonNode? title)
                {
                    ct.ThrowIfCancellationRequested();
                    var values = id is null ? new JsonObject() : Values(db, c, "film", id);
                    var subject = new JsonObject { ["kind"] = "film", ["id"] = id };
                    var scope = new JsonObject { ["kind"] = "whole" };
                    var old = id is null ? null : Head(db, subject, scope, field.Text("key"));
                    foreach (var rule in rules)
                    {
                        var decision = MatchDecision(rule, values, facts);
                        var state = decision.State;
                        var source = field.Text("key") + ":" + rule.Text("id");
                        if (state == "matched" && !c.Accepts(field, decision.Value))
                            state = "invalid";
                        if (
                            state == "matched"
                            && old is not null
                            && (
                                old["editPolicy"].Flag("locked")
                                || old["editPolicy"].List("suppressedMembers").Count > 0
                                || old.Text("operation") == "clear"
                                || old["provenance"].Text("source") != source
                            )
                        )
                            state = "protected";
                        if (state == "matched" && JsonNode.DeepEquals(old?["value"], decision.Value))
                            state = "unchanged";
                        if (state == "unmatched" && rule != rules[^1])
                            continue;
                        counts[state] = counts.GetValueOrDefault(state) + 1;
                        var row = new JsonObject
                        {
                            ["id"] = id,
                            ["title"] = title.Copy(),
                            ["state"] = state,
                            ["facts"] = facts.Copy(),
                            ["before"] = old?["value"].Copy(),
                            ["after"] = decision.Value.Copy(),
                            ["caseId"] = decision.CaseId,
                            ["matches"] = decision.Matches,
                            ["missing"] = new JsonArray(
                                decision.Missing.Select(p => (JsonNode?)JsonValue.Create(p)).ToArray()
                            ),
                        };
                        if (samples.Count < 40)
                            samples.Add(row);
                        if (!draft && synthetic.Count == 0 && id is not null && state == "matched")
                        {
                            var film = CatalogRepository.RequireFilm(db, id);
                            var write = new JsonObject
                            {
                                ["subject"] = subject.Copy(),
                                ["scope"] = scope.Copy(),
                                ["tagKey"] = field.Text("key"),
                                ["value"] = decision.Value.Copy(),
                                ["operation"] = "set",
                                ["locked"] = false,
                                ["expectedRevision"] = old?.Number("revision") ?? 0,
                                ["mediaRevision"] = MediaRevision(film),
                                ["factsHash"] = TagJson.Hash(DependencyFacts(facts, FactDependencies(rule))),
                                ["factPaths"] = new JsonArray(
                                    FactDependencies(rule)
                                        .Distinct()
                                        .Select(p => (JsonNode?)JsonValue.Create(p))
                                        .ToArray()
                                ),
                                ["dependencyHash"] = TagJson.Hash(DependencyValues(values, rule)),
                                ["dependencyRule"] = rule.Copy(),
                                ["provenance"] = new JsonObject
                                {
                                    ["source"] = source,
                                    ["ruleHash"] = TagJson.Hash(rule),
                                    ["observedAt"] = Now,
                                },
                            };
                            db.Execute(
                                "INSERT INTO tag_bulk_items VALUES(@id,@n,@p,'pending',NULL)",
                                ("@id", token),
                                ("@n", ordinal++),
                                (
                                    "@p",
                                    new JsonObject
                                    {
                                        ["factsHash"] = TagJson.Hash(facts),
                                        ["writes"] = new JsonArray(write),
                                    }.ToJsonString()
                                )
                            );
                        }
                        // A field has one outcome. A later rule cannot overwrite an earlier decision.
                        if (state != "unmatched")
                            break;
                    }
                }
                foreach (var id in ids)
                {
                    var film = CatalogRepository.RequireFilm(db, id);
                    Inspect(id, Facts(film), FilmView(db, c, film)["presentation"]?["title"]);
                }
                foreach (var sample in synthetic)
                {
                    var facts = sample?["facts"]?.DeepClone().AsObject() ?? new();
                    Inspect(null, facts, sample?["title"]);
                }
                var committable = !draft && synthetic.Count == 0;
                if (committable)
                    db.Execute(
                        "INSERT INTO tag_previews VALUES(@id,'automation',@g,@p,NULL,@t)",
                        ("@id", token),
                        ("@g", generation),
                        ("@p", args.ToJsonString()),
                        ("@t", Now)
                    );
                db.Execute(
                    "INSERT INTO audit(time,tool,summary) VALUES(@time,'automation.preview',@summary)",
                    ("@time", Now),
                    ("@summary", token + ":" + (ids.Length + synthetic.Count))
                );
                tx.Commit();
                return new JsonObject
                {
                    ["previewToken"] = committable ? token : null,
                    ["committable"] = committable,
                    ["generation"] = generation,
                    ["count"] = ids.Length + synthetic.Count,
                    ["changedCount"] = counts.GetValueOrDefault("matched"),
                    ["counts"] = new JsonObject(
                        counts.Select(p => new KeyValuePair<string, JsonNode?>(p.Key, JsonValue.Create(p.Value)))
                    ),
                    ["samples"] = samples,
                };
            },
            ct
        );
    }
}
