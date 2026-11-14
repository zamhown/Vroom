using System.Text.Json.Nodes;
using Json.Schema;
using Microsoft.Data.Sqlite;
using Vroom.Core.Storage;

namespace Vroom.Core.Tagging;

public sealed partial class CompiledDefinitions
{
    public Dictionary<string, JsonObject> Terms { get; } = new(StringComparer.Ordinal);

    public CompiledDefinitions LoadTerms(IEnumerable<JsonObject> userTerms)
    {
        Terms.Clear();
        foreach (var vocabulary in Package.Map("vocabularies"))
        foreach (var term in vocabulary.Value.List("items").OfType<JsonObject>())
            if (!Terms.TryAdd(term.Text("id"), term))
                throw new TagException("DUPLICATE_TERM", term.Text("id"));
        foreach (var term in userTerms)
            Terms[term.Text("id")] = term;
        return this;
    }

    public bool TermAvailable(JsonObject term) =>
        term.Flag("enabled", true)
        && term.List("vocabularyIds")
            .Any(v =>
                Package["vocabularies"]?[v!.ToString()] is JsonObject vocabulary && vocabulary.Flag("enabled", true)
            );

    public bool InVocabulary(JsonObject term, string vocabulary) =>
        TermAvailable(term)
        && Package["vocabularies"]?[vocabulary] is JsonObject v
        && v.Flag("enabled", true)
        && term.List("vocabularyIds").Any(x => x?.ToString() == vocabulary);

    public JsonObject RequireTerm(string id) =>
        Terms.TryGetValue(id, out var term) && TermAvailable(term)
            ? term
            : throw new TagException("TERM_UNAVAILABLE", id);

    public JsonObject? ResolveTerm(JsonObject field, JsonNode? value)
    {
        if (!ValueContracts.Enumerable(field) || value is null)
            return null;
        var vocabulary = ValueContracts.Vocabulary(field);
        return
            value is JsonObject r
            && r.Count == 1
            && Terms.TryGetValue(r.Text("term"), out var term)
            && InVocabulary(term, vocabulary)
            ? term
            : null;
    }

    public JsonNode TermValue(JsonObject field, JsonObject term) => new JsonObject { ["term"] = term.Text("id") };

    public string? SubjectIssue(JsonObject field, JsonNode subject)
    {
        var kind = subject.Text("kind");
        if (kind == "film")
            return null;
        if (kind != "term")
            return "SUBJECT_KIND_INVALID";
        if (!Terms.TryGetValue(subject.Text("id"), out var term) || !TermAvailable(term))
            return "TERM_UNAVAILABLE";
        var allowed = field.List("subjectVocabularies");
        return allowed.Count > 0 && !allowed.Any(v => InVocabulary(term, v!.ToString()))
            ? "SUBJECT_VOCABULARY_MISMATCH"
            : null;
    }
}

public sealed partial class TagEngine
{
    private static readonly JsonSchema TermSchema = TagSchemas.Get("term.schema.json");

    internal static CompiledDefinitions BindTerms(SqliteConnection db, CompiledDefinitions c) =>
        new CompiledDefinitions(c.Package).LoadTerms(
            ReadRows(db, "SELECT payload FROM tag_terms", r => JsonNode.Parse(r.GetString(0))!.AsObject())
        );

    private CompiledDefinitions Compile(SqliteConnection db, JsonObject package) =>
        BindTerms(db, compiler.Compile(DefinitionDocument.From(package)));

    internal static void StoreTerm(SqliteConnection db, JsonObject term)
    {
        db.Execute("UPDATE tag_terms_stamp SET stamp=@s WHERE id=1", ("@s", Guid.NewGuid().ToString("N")));
        db.Execute(
            "INSERT INTO tag_terms(id,payload) VALUES(@id,@p) ON CONFLICT(id) DO UPDATE SET payload=@p",
            ("@id", term.Text("id")),
            ("@p", term.ToJsonString())
        );
        db.Execute(
            "INSERT OR IGNORE INTO tag_term_history(id,revision,payload) VALUES(@id,@r,@p)",
            ("@id", term.Text("id")),
            ("@r", term.Number("revision")),
            ("@p", term.ToJsonString())
        );
    }

    internal static void CheckTerm(CompiledDefinitions c, JsonObject term)
    {
        if (!TermSchema.Evaluate(term).IsValid)
            throw new TagException("TERM_SCHEMA_INVALID", term.Text("id"));
        foreach (var vocabulary in term.List("vocabularyIds"))
            if (c.Package["vocabularies"]?[vocabulary!.ToString()] is null)
                throw new TagException("VOCABULARY_UNAVAILABLE", vocabulary!.ToString());
    }

    public async Task<JsonObject> PutTermAsync(JsonObject args, CancellationToken ct = default)
    {
        await InitializeAsync(ct);
        return await repository.Database.RunAsync(
            db =>
            {
                using var tx = db.BeginTransaction();
                var c = Current(db);
                if (args.Number("expectedGeneration") != Generation(db))
                    throw new TagException("STALE_GENERATION");
                var term = args["term"]?.DeepClone().AsObject() ?? throw new TagException("TERM_REQUIRED");
                c.Terms.TryGetValue(term.Text("id"), out var old);
                if (
                    args["expectedRevision"] is null
                    || args.Number("expectedRevision") != (old?.Number("revision") ?? 0)
                )
                    throw new TagException("TERM_REVISION_CONFLICT", term.Text("id"));
                term["revision"] = (old?.Number("revision") ?? 0) + 1;
                CheckTerm(c, term);
                StoreTerm(db, term);
                var next = BindTerms(db, c);
                var projected = ReprojectChanged(db, c, next, ct);
                ValidateTermGraph(db);
                Emit(db, "term.changed", new() { ["id"] = term.Text("id"), ["revision"] = term.Number("revision") });
                Audit(db, "terms.put", term.DeepClone().AsObject());
                tx.Commit();
                return new JsonObject()
                {
                    ["term"] = term,
                    ["projectedCount"] = projected,
                    ["generation"] = Generation(db),
                };
            },
            ct
        );
    }

    public async Task<JsonObject> QueryTermsAsync(JsonObject args, CancellationToken ct = default)
    {
        await InitializeAsync(ct);
        return await repository.Database.ReadAsync(
            db =>
            {
                var c = Current(db);
                var vocabulary = args.Text("vocabulary");
                var search = args.Text("search");
                var all = c
                    .Terms.Values.Where(t =>
                        (args.Flag("includeDisabled") || c.TermAvailable(t))
                        && (vocabulary.Length == 0 || t.List("vocabularyIds").Any(v => v?.ToString() == vocabulary))
                        && (
                            search.Length == 0
                            || t["label"]!.ToJsonString().Contains(search, StringComparison.OrdinalIgnoreCase)
                            || t.List("aliases")
                                .Any(a => a!.ToString().Contains(search, StringComparison.OrdinalIgnoreCase))
                        )
                    )
                    .OrderBy(t => t.Text("id"), StringComparer.Ordinal)
                    .ToArray();
                var q = new TagQuery(c);
                if (args["where"] is not null)
                {
                    var ids = ReadRows(
                            db,
                            $"SELECT f.id FROM tag_term_catalog f WHERE {q.Compile(args["where"], subjectKind: "term")}",
                            r => r.GetString(0),
                            [.. q.Parameters]
                        )
                        .ToHashSet();
                    all = all.Where(t => ids.Contains(t.Text("id"))).ToArray();
                }
                return new JsonObject()
                {
                    ["items"] = new JsonArray(
                        all.Skip(Math.Max(0, (int)args.Number("offset")))
                            .Take(Math.Clamp((int)args.Number("limit", 200), 1, 10000))
                            .Select(t => t.DeepClone())
                            .ToArray()
                    ),
                    ["total"] = all.Length,
                    ["generation"] = Generation(db),
                };
            },
            ct
        );
    }

    public async Task<JsonObject> GetTermAsync(string id, CancellationToken ct = default)
    {
        await InitializeAsync(ct);
        return await repository.Database.ReadAsync(
            db =>
            {
                var c = Current(db);
                if (!c.Terms.TryGetValue(id, out var term))
                    throw new TagException("TERM_UNAVAILABLE", id);
                var links = ReadRows(
                    db,
                    "SELECT subject_kind,subject_id,tag_key,target_id FROM tag_reference_edges WHERE subject_id=@id AND subject_kind='term' OR target_id=@id ORDER BY subject_kind,subject_id,tag_key,target_id LIMIT 500",
                    r =>
                        (JsonNode?)
                            new JsonObject
                            {
                                ["subjectKind"] = r.GetString(0),
                                ["subjectId"] = r.GetString(1),
                                ["tagKey"] = r.GetString(2),
                                ["targetId"] = r.GetString(3),
                            },
                    ("@id", id)
                );
                return new JsonObject()
                {
                    ["term"] = term.DeepClone(),
                    ["candidates"] = new JsonArray(
                        ReadRows(
                                db,
                                "SELECT payload FROM tag_candidates WHERE subject_id=@id AND json_extract(payload,'$.subjectKind')='term' AND state='pending'",
                                r => (JsonNode?)JsonNode.Parse(r.GetString(0)),
                                ("@id", id)
                            )
                            .ToArray()
                    ),
                    ["values"] = Values(db, c, "term", id),
                    ["links"] = new JsonArray(links.ToArray()),
                    ["generation"] = Generation(db),
                };
            },
            ct
        );
    }

    internal static void IndexReferences(SqliteConnection db, CompiledDefinitions c, JsonObject record, JsonNode? value)
    {
        var s = record["subject"]!;
        var scope = ScopeId(record["scope"]!);
        var key = record.Text("tagKey");
        db.Execute(
            "DELETE FROM tag_reference_edges WHERE subject_kind=@k AND subject_id=@s AND scope_id=@scope AND tag_key=@t",
            ("@k", s.Text("kind")),
            ("@s", s.Text("id")),
            ("@scope", scope),
            ("@t", key)
        );
        if (value is null || !c.Definitions.TryGetValue(key, out var field) || !ValueContracts.Enumerable(field))
            return;
        foreach (var v in value as JsonArray ?? new JsonArray(value.Copy()))
            if (c.ResolveTerm(field, v) is { } term)
                db.Execute(
                    "INSERT OR IGNORE INTO tag_reference_edges VALUES(@k,@s,@scope,@t,@target)",
                    ("@k", s.Text("kind")),
                    ("@s", s.Text("id")),
                    ("@scope", scope),
                    ("@t", key),
                    ("@target", term.Text("id"))
                );
    }

    // Checking the complete effective graph catches cross-field and batch-created cycles.
    internal static void ValidateTermGraph(SqliteConnection db)
    {
        var edges = ReadRows(
            db,
            "SELECT subject_id,target_id FROM tag_reference_edges WHERE subject_kind='term'",
            r => (From: r.GetString(0), To: r.GetString(1))
        );
        var next = edges.GroupBy(e => e.From).ToDictionary(g => g.Key, g => g.Select(e => e.To).Distinct().ToArray());
        var degrees = edges.SelectMany(e => new[] { e.From, e.To }).Distinct().ToDictionary(id => id, _ => 0);
        foreach (var targets in next.Values)
        foreach (var id in targets)
            degrees[id]++;
        var queue = new Queue<string>(degrees.Where(p => p.Value == 0).Select(p => p.Key));
        var count = 0;
        while (queue.TryDequeue(out var id))
        {
            count++;
            if (next.TryGetValue(id, out var targets))
                foreach (var to in targets)
                    if (--degrees[to] == 0)
                        queue.Enqueue(to);
        }
        if (count != degrees.Count)
            throw new TagException("TERM_CYCLE", degrees.First(p => p.Value > 0).Key);
    }
}
