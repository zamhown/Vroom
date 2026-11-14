using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;
using Vroom.Core.Storage;

namespace Vroom.Core.Tagging;

public sealed record MediaEvent(string Type, string FilmId, JsonObject? Payload = null, string? EventId = null);

public sealed partial class TagEngine
{
    public Task RecordMediaEventAsync(
        string type,
        string filmId,
        JsonObject? payload = null,
        string? eventId = null,
        CancellationToken ct = default
    ) => RecordMediaEventsAsync([new(type, filmId, payload, eventId)], ct);

    /// <summary>Records media events under one write-lock acquisition; each event commits on its own.</summary>
    public async Task RecordMediaEventsAsync(IReadOnlyList<MediaEvent> events, CancellationToken ct = default)
    {
        if (events.Count == 0)
            return;
        foreach (var e in events)
            if (!DefinitionCompiler.Events.Contains(e.Type))
                throw new TagException("EVENT_UNAVAILABLE");
        await InitializeAsync(ct);
        await repository.Database.RunAsync(
            db =>
            {
                foreach (var e in events)
                {
                    ct.ThrowIfCancellationRequested();
                    RecordMediaEvent(db, e);
                }
            },
            ct
        );
    }

    // Playback events are frequent; they are only persisted when an enabled rule consumes them.
    private static bool Listens(CompiledDefinitions c, string type) =>
        c.Definitions.Values.Any(d =>
            d.Flag("enabled", true)
            && d.List("initialization").Concat(d.List("automation")).Any(r => r.Text("event") == type)
        ) || c.Package.Map("eventBindings").Any(p => p.Value?["rule"].Text("event") == type);

    private void RecordMediaEvent(SqliteConnection db, MediaEvent e)
    {
        if (e.Type.StartsWith("playback.", StringComparison.Ordinal) && !Listens(Current(db), e.Type))
            return;
        using var tx = db.BeginTransaction();
        var payload = e.Payload;
        var film = payload?["partId"] is { } part
            ? CatalogRepository.RequirePart(db, e.FilmId, part.ToString())
            : CatalogRepository.RequireFilm(db, e.FilmId);
        var facts = Facts(film);
        if (payload?["mediaRevision"] is { } mr && mr.ToString() != MediaRevision(film))
            throw new TagException("STALE_MEDIA");
        var body = new JsonObject
        {
            ["subject"] = new JsonObject { ["kind"] = "film", ["id"] = e.FilmId },
            ["partId"] = film.PartId,
            ["mediaRevision"] = MediaRevision(film),
            ["facts"] = facts,
            ["eventData"] = payload.Copy(),
        };
        // A discovery follows an index write that may change the media revision; time-scoped
        // annotations bound to the previous revision must leave the effective projection.
        if (e.Type == "film.discovered")
            foreach (var record in Records(db, e.FilmId).Where(r => r["scope"].Text("kind") != "whole"))
                ProjectRecord(db, Current(db), record);
        // Defaults and derived fields follow the media facts that this event reports.
        if (e.Type is "film.discovered" or "media.probed")
            ProjectDefaults(db, Current(db), [e.FilmId]);
        var id = Emit(db, e.Type, body, e.EventId);
        EventFlow.Value = (id, 1);
        try
        {
            // Film events only write film subjects; the term reference graph cannot change here.
            DispatchRules(db, Current(db), id, e.Type, body);
        }
        finally
        {
            EventFlow.Value = null;
        }
        db.Execute("UPDATE tag_events SET processed=1 WHERE event_id=@id", ("@id", id));
        tx.Commit();
    }

    public async Task ResumeEventsAsync(CancellationToken ct = default)
    {
        await InitializeAsync(ct);
        await repository.Database.RunAsync(
            db =>
            {
                foreach (
                    var e in ReadRows(
                        db,
                        "SELECT event_id,payload FROM tag_events WHERE processed=0 ORDER BY sequence LIMIT 1000",
                        r => (r.GetString(0), JsonNode.Parse(r.GetString(1))!.AsObject())
                    )
                )
                {
                    ct.ThrowIfCancellationRequested();
                    using var tx = db.BeginTransaction();
                    var body = e.Item2["payload"]!.AsObject();
                    if (body["subject"].Text("kind") is "film" or "term")
                    {
                        db.Execute("SAVEPOINT event_rules");
                        try
                        {
                            var current = Current(db);
                            if (body["subject"].Text("kind") == "film")
                            {
                                var film = body["partId"] is { } part
                                    ? CatalogRepository.RequirePart(db, body["subject"].Text("id"), part.ToString())
                                    : CatalogRepository.RequireFilm(db, body["subject"].Text("id"));
                                body["facts"] ??= Facts(film);
                                body["mediaRevision"] ??= MediaRevision(film);
                            }
                            else
                            {
                                var term = current.RequireTerm(body["subject"].Text("id"));
                                body["facts"] ??= EntityFacts(current, term);
                                body["subjectRevision"] ??= term["revision"].Copy();
                            }
                            if (e.Item2.Number("depth") < 8)
                            {
                                EventFlow.Value = (
                                    e.Item2.Text("rootEventId", e.Item1),
                                    (int)e.Item2.Number("depth") + 1
                                );
                                DispatchRules(db, current, e.Item1, e.Item2.Text("type"), body);
                                ValidateTermGraph(db);
                            }
                            else
                                Audit(db, "events.depth-limit", new() { ["eventId"] = e.Item1 });
                            db.Execute("RELEASE event_rules");
                        }
                        catch (Exception ex)
                            when (ex
                                    is TagException
                                        or KeyNotFoundException
                                        or System.Text.RegularExpressions.RegexMatchTimeoutException
                            )
                        {
                            db.Execute("ROLLBACK TO event_rules; RELEASE event_rules");
                            Audit(db, "events.rule-failed", new() { ["eventId"] = e.Item1, ["error"] = ex.Message });
                        }
                        finally
                        {
                            EventFlow.Value = null;
                        }
                    }
                    db.Execute("UPDATE tag_events SET processed=1 WHERE event_id=@id", ("@id", e.Item1));
                    tx.Commit();
                }
            },
            ct
        );
    }

    internal static JsonObject EntityFacts(CompiledDefinitions c, JsonObject term) =>
        new()
        {
            ["entity"] = new JsonObject
            {
                ["id"] = term.Text("id"),
                ["label"] = TagJson.Label(term["label"], package: c.Package),
                ["aliases"] = term["aliases"].Copy(),
                ["vocabularies"] = term["vocabularyIds"].Copy(),
            },
        };

    private void DispatchRules(SqliteConnection db, CompiledDefinitions c, string eventId, string type, JsonObject body)
    {
        var subject = body["subject"]!;
        var facts = body["facts"]!.AsObject();
        var subjectId = subject.Text("id");
        var kind = subject.Text("kind");
        if (
            kind == "film"
            && body.Text("mediaRevision")
                != MediaRevision(
                    body["partId"] is { } part
                        ? CatalogRepository.RequirePart(db, subjectId, part.ToString())
                        : CatalogRepository.RequireFilm(db, subjectId)
                )
        )
            return;
        if (kind == "term" && body.Number("subjectRevision") != c.RequireTerm(subjectId).Number("revision"))
            return;
        foreach (
            var d in c.Definitions.Values.Where(d =>
                d.Flag("enabled", true)
                && AnnotationTargets.Supports(d, kind, "whole")
                && c.SubjectIssue(d, subject) is null
            )
        )
        foreach (
            var rule in d.List("initialization")
                .Concat(d.List("automation"))
                .Concat(
                    c.Package.Map("eventBindings")
                        .Where(p => p.Value.Text("tag") == d.Text("key"))
                        .Select(p => p.Value?["rule"])
                )
                .Where(r =>
                    r.Text("event") == type
                    || type == "media.probed"
                        && r.Text("event") == "film.discovered"
                        && FactDependencies(r).Any(p => p.StartsWith("probe."))
                )
                .OfType<JsonObject>()
        )
        {
            if (
                type.StartsWith("annotation.", StringComparison.Ordinal)
                && !body.List("changedFields").Any(x => x?.ToString() is "value" or "operation")
            )
                continue;
            var eventFacts = facts.DeepClone().AsObject();
            eventFacts["event"] = body.DeepClone();
            if (
                rule["when"] is not null
                && Evaluate(rule["when"], Values(db, c, kind, subjectId), eventFacts)?.ToString() != "true"
            )
                continue;
            var deliveryKey = EventFlow.Value?.Root ?? eventId;
            var ruleKey = d.Text("key") + ":" + rule.Text("id") + ":" + TagJson.Hash(rule);
            if (
                db.Scalar(
                    "SELECT result FROM tag_rule_runs WHERE event_id=@e AND rule_key=@r",
                    ("@e", deliveryKey),
                    ("@r", ruleKey)
                )
                is not null
            )
                continue;
            var args = rule.Map("args");
            var origin =
                type == "media.probed" ? "probe"
                : type.StartsWith("playback.") ? "event"
                : "path";
            JsonNode? value = null;
            var inputs = args.List("inputs").Select(p => TagJson.Get(facts, p!.ToString())?.ToString() ?? "").ToArray();
            switch (rule.Text("executor"))
            {
                case "value.match@1":
                    value = MatchDecision(rule, Values(db, c, kind, subjectId), eventFacts).Value;
                    break;
                case "value.constant@1":
                    value = args["value"].Copy();
                    break;
                case "fact.copy@1":
                    value = TagJson.Get(facts, args.Text("path")).Copy();
                    break;
                case "expression@1":
                    value = Evaluate(args["expression"], Values(db, c, kind, subjectId), eventFacts);
                    break;
                case "regex.extract@1":
                    var config = args["rule"] is { } rk ? c.Package["rules"]?[rk.ToString()] : args;
                    var found = inputs
                        .SelectMany(input => Extract(config!, input, args.Flag("createOptions") ? 20 : 1))
                        .Distinct()
                        .ToArray();
                    if (found.Length > 0)
                        value = args.Flag("createOptions")
                            ? new JsonArray(found.Select(x => (JsonNode?)JsonValue.Create(x)).ToArray())
                            : JsonValue.Create(found[0]);
                    break;
                case "dictionary.match@1":
                    var vocabulary = args.Text("vocabulary");
                    var references = c
                        .Terms.Values.Where(o => c.InVocabulary(o, vocabulary))
                        .Where(o =>
                            o["label"]
                                .Map("values")
                                .Select(x => x.Value!.ToString())
                                .Concat(o.List("aliases").Select(x => x!.ToString()))
                                .Any(alias =>
                                    alias.Length > 1
                                    && inputs.Any(input =>
                                        Regex.IsMatch(
                                            input,
                                            @"(?<![\p{L}\p{N}])" + Regex.Escape(alias) + @"(?![\p{L}\p{N}])",
                                            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant,
                                            TimeSpan.FromMilliseconds(50)
                                        )
                                    )
                                )
                        )
                        .Select(o => (JsonNode?)c.TermValue(d, o))
                        .ToArray();
                    if (references.Length > 0)
                        value = d["value"].Text("cardinality") == "many" ? new JsonArray(references) : references[0];
                    break;
                case "path.facet-alias-match@1":
                    var bands = d["facets"]?[args.Text("facet")].List("bands") ?? [];
                    foreach (var segment in inputs.SelectMany(p => p.Split(['/', '\\'])))
                    foreach (var band in bands)
                        if (
                            band.List("matchAliases")
                                .Any(a =>
                                    Regex.IsMatch(
                                        segment,
                                        @"(?:^|[\s_\-\[\]（）()])"
                                            + Regex.Escape(a!.ToString())
                                            + @"(?:$|[\s_\-\[\]（）()])",
                                        RegexOptions.CultureInvariant,
                                        TimeSpan.FromMilliseconds(50)
                                    )
                                )
                        )
                            value = band?["representative"].Copy();
                    break;
            }
            if (value is not null)
            {
                if (rule.Text("apply") == "suggest-only")
                    Candidate(
                        db,
                        subjectId,
                        d.Text("key"),
                        value,
                        origin,
                        ruleKey,
                        kind == "film" ? body.Text("mediaRevision") : "term:" + body.Number("subjectRevision"),
                        args.Flag("createOptions"),
                        kind,
                        (long)body.Number("subjectRevision"),
                        partId: body["partId"]?.ToString()
                    );
                else if (c.Accepts(d, value))
                    AutomaticValue(
                        db,
                        c,
                        d,
                        subject,
                        value,
                        origin,
                        rule.Text("apply"),
                        d.Text("key") + ":" + rule.Text("id"),
                        TagJson.Hash(rule)
                    );
            }
            db.Execute(
                "INSERT INTO tag_rule_runs VALUES(@e,@r,@v)",
                ("@e", deliveryKey),
                ("@r", ruleKey),
                ("@v", value is null ? "no-match" : "processed")
            );
        }
    }

    internal static IEnumerable<string> Extract(JsonNode configuration, string input, int limit = 1)
    {
        if (input.Length > 8192)
            input = input[..8192];
        if (configuration.Text("normalize") == "nfkc-upper")
            input = input.Normalize(NormalizationForm.FormKC).ToUpperInvariant();
        var results = new List<string>();
        foreach (var p in configuration.List("patterns"))
        {
            foreach (
                Match match in Regex.Matches(
                    input,
                    p.Text("pattern"),
                    RegexOptions.CultureInvariant,
                    TimeSpan.FromMilliseconds(50)
                )
            )
            {
                var value = p.Text("template", "{0}");
                bool valid = true;
                for (int i = 0; i < match.Groups.Count; i++)
                {
                    var part = match.Groups[i].Value;
                    var transform = p?["groups"]?[i.ToString()];
                    if (transform?.List("exclude").Any(n => n?.ToString() == part) == true)
                    {
                        valid = false;
                        break;
                    }
                    if (transform.Flag("trimLeadingZeros"))
                        part = part.TrimStart('0');
                    var width = (int)transform.Number("padLeft");
                    if (width > 0)
                        part = part.PadLeft(Math.Clamp(width, 0, 32), '0');
                    value = value.Replace("{" + i + "}", part, StringComparison.Ordinal);
                }
                if (valid && value.Length > 0)
                    results.Add(value.Trim());
                if (results.Count >= limit)
                    return results;
            }
        }
        return results;
    }

    internal void AutomaticValue(
        SqliteConnection db,
        CompiledDefinitions c,
        JsonObject d,
        JsonNode subject,
        JsonNode value,
        string origin,
        string apply,
        string source,
        string? ruleHash = null,
        JsonArray? evidence = null
    )
    {
        var scope = new JsonObject { ["kind"] = "whole" };
        var old = Head(db, subject, scope, d.Text("key"));
        if (old is not null)
        {
            if (
                old["editPolicy"].Flag("locked")
                || old.Text("operation") == "clear" && d["writes"].Flag("manualClearBlocksAutomatic", true)
            )
                return;
            if (apply == "if-unset" || apply == "replace-same-source" && old["provenance"].Text("source") != source)
                return;
            if (apply == "prefer-source" && d["writes"].List("sourcePriority") is { Count: > 0 } priorities)
            {
                var order = priorities.Select(x => x!.ToString()).ToList();
                var incoming = order.IndexOf(origin);
                var previous = order.IndexOf(old["origin"].Text("kind"));
                if (previous >= 0 && (incoming < 0 || incoming > previous))
                    return;
            }
        }
        if (
            apply == "union"
            && old?["editPolicy"]?["suppressedMembers"] is JsonArray suppressed
            && value is JsonArray incomingMembers
        )
            value = new JsonArray(
                incomingMembers
                    .Where(v => !suppressed.Any(s => JsonNode.DeepEquals(s, v)))
                    .Select(v => v.Copy())
                    .ToArray()
            );
        Write(
            db,
            c,
            new JsonObject
            {
                ["subject"] = subject.Copy(),
                ["scope"] = scope,
                ["tagKey"] = d.Text("key"),
                ["value"] = value.Copy(),
                ["operation"] = apply == "union" ? "add" : "set",
                ["locked"] = false,
                ["provenance"] = new JsonObject
                {
                    ["source"] = source,
                    ["ruleHash"] = ruleHash,
                    ["observedAt"] = Now,
                    ["evidence"] = evidence.Copy(),
                },
            },
            origin,
            false
        );
    }

    internal static void Candidate(
        SqliteConnection db,
        string subject,
        string key,
        JsonNode value,
        string origin,
        string source,
        string mediaRevision,
        bool createOptions = false,
        string subjectKind = "film",
        long subjectRevision = 0,
        JsonArray? evidence = null,
        string? partId = null,
        JsonObject? entities = null
    )
    {
        var identity = new JsonObject
        {
            ["subject"] = subject,
            ["key"] = key,
            ["value"] = value.Copy(),
            ["source"] = source,
            ["mediaRevision"] = mediaRevision,
        };
        if (subjectKind != "film")
            identity["subjectKind"] = subjectKind;
        if (partId is not null)
            identity["partId"] = partId;
        var id = TagJson.Hash(identity);
        var payload = new JsonObject
        {
            ["id"] = id,
            ["subjectId"] = subject,
            ["subjectKind"] = subjectKind,
            ["subjectRevision"] = subjectRevision,
            ["partId"] = partId,
            ["evidence"] = evidence.Copy(),
            ["tagKey"] = key,
            ["value"] = value.Copy(),
            ["origin"] = origin,
            ["source"] = source,
            ["mediaRevision"] = mediaRevision,
            ["createOptions"] = createOptions,
            ["entities"] = entities.Copy(),
            ["updated"] = Now,
        };
        db.Execute(
            "INSERT INTO tag_candidates(id,subject_id,tag_key,payload) VALUES(@id,@s,@k,@p) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload WHERE tag_candidates.state='pending'",
            ("@id", id),
            ("@s", subject),
            ("@k", key),
            ("@p", payload.ToJsonString())
        );
    }

    private CompiledDefinitions CreateOption(
        SqliteConnection db,
        CompiledDefinitions c,
        JsonObject field,
        string name,
        out string optionKey
    )
    {
        var config = field["writes"]?["createTerms"] ?? throw new TagException("OPTION_CREATE_DISABLED");
        name = name.Trim();
        if (name.Length is 0 or > 150)
            throw new TagException("OPTION_NAME_INVALID");
        var vocabulary = ValueContracts.Vocabulary(field);
        if (c.Package["vocabularies"]?[vocabulary] is not JsonObject v || !v.Flag("enabled", true))
            throw new TagException("VOCABULARY_UNAVAILABLE", vocabulary);
        optionKey = config.Text("namespace", "user.term") + "." + Guid.NewGuid().ToString("N");
        var term = new JsonObject
        {
            ["id"] = optionKey,
            ["revision"] = 1,
            ["enabled"] = true,
            ["label"] = TagJson.Localized(name),
            ["aliases"] = new JsonArray(),
            ["vocabularyIds"] = new JsonArray(vocabulary),
        };
        CheckTerm(c, term);
        var option = OptionValue(field, optionKey);
        var schema =
            field["value"].Text("cardinality") == "many"
                ? c.MemberSchemas[field.Text("key")]
                : c.ValueSchemas[field.Text("key")];
        if (!schema.Evaluate(option).IsValid)
            throw new TagException("OPTION_OUT_OF_DOMAIN", field.Text("key"));
        StoreTerm(db, term);
        c = BindTerms(db, c);
        db.Execute("INSERT INTO tag_term_catalog VALUES(@id,@p)", ("@id", optionKey), ("@p", term.ToJsonString()));
        Emit(db, "term.changed", new() { ["id"] = optionKey, ["revision"] = 1 });
        return c;
    }

    private static JsonNode OptionValue(JsonObject field, string key) => new JsonObject { ["term"] = key };

    public async Task<object> CreateOptionAsync(JsonObject args, CancellationToken ct = default)
    {
        await InitializeAsync(ct);
        return await repository.Database.RunAsync(
            db =>
            {
                using var tx = db.BeginTransaction();
                if (args.Number("expectedGeneration") != Generation(db))
                    throw new TagException("STALE_GENERATION");
                var c = Current(db);
                var field = c.Require(args.Text("tagKey"));
                c = CreateOption(db, c, field, args.Text("name"), out var key);
                var optionValue = OptionValue(field, key);
                JsonNode? result = null;
                if (args["write"] is JsonObject write)
                {
                    write = write.DeepClone().AsObject();
                    write["tagKey"] = field.Text("key");
                    write["value"] =
                        field["value"].Text("cardinality") == "many"
                            ? new JsonArray(optionValue.Copy())
                            : optionValue.Copy();
                    write["operation"] = field["value"].Text("cardinality") == "many" ? "add" : "set";
                    result = Write(db, c, write);
                }
                ValidateTermGraph(db);
                Audit(db, "tag.options.create", new JsonObject { ["key"] = key });
                tx.Commit();
                return new
                {
                    key,
                    value = optionValue,
                    generation = Generation(db),
                    record = result,
                };
            },
            ct
        );
    }

    public async Task<object> ResolveCandidateAsync(JsonObject args, CancellationToken ct = default)
    {
        await InitializeAsync(ct);
        return await repository.Database.RunAsync(
            db =>
            {
                using var tx = db.BeginTransaction();
                if (args.Number("expectedGeneration") != Generation(db))
                    throw new TagException("STALE_GENERATION");
                var json =
                    db.Scalar(
                        "SELECT payload FROM tag_candidates WHERE id=@id AND state='pending'",
                        ("@id", args.Text("id"))
                    ) as string
                    ?? throw new TagException("CANDIDATE_UNAVAILABLE");
                var candidate = JsonNode.Parse(json)!.AsObject();
                var c = Current(db);
                if (args.Flag("accept"))
                {
                    if (
                        candidate.Text("subjectKind") == "film"
                        && candidate.Text("mediaRevision")
                            != MediaRevision(
                                candidate["partId"] is { } part
                                    ? CatalogRepository.RequirePart(db, candidate.Text("subjectId"), part.ToString())
                                    : CatalogRepository.RequireFilm(db, candidate.Text("subjectId"))
                            )
                    )
                        throw new TagException("STALE_MEDIA");
                    if (
                        candidate.Text("subjectKind") == "term"
                        && candidate.Number("subjectRevision")
                            != c.RequireTerm(candidate.Text("subjectId")).Number("revision")
                    )
                        throw new TagException("TERM_REVISION_CONFLICT");
                    var field = c.Require(candidate.Text("tagKey"));
                    var value = candidate["value"].Copy();
                    if (candidate["entities"] is JsonObject mapping)
                        (c, value) = AcceptEntities(db, c, field, candidate, mapping);
                    else if (candidate.Flag("createOptions"))
                    {
                        var refs = new JsonArray();
                        foreach (var name in value as JsonArray ?? new JsonArray(value.Copy()))
                        {
                            c = CreateOption(db, c, c.Require(field.Text("key")), name!.ToString(), out var key);
                            refs.Add(OptionValue(field, key));
                        }
                        value = field["value"].Text("cardinality") == "many" ? refs : refs.FirstOrDefault().Copy();
                    }
                    Write(
                        db,
                        c,
                        new JsonObject
                        {
                            ["subject"] = new JsonObject
                            {
                                ["kind"] = candidate.Text("subjectKind"),
                                ["id"] = candidate.Text("subjectId"),
                            },
                            ["scope"] = new JsonObject { ["kind"] = "whole" },
                            ["tagKey"] = field.Text("key"),
                            ["value"] = value,
                            ["expectedRevision"] = args["expectedRevision"].Copy(),
                            ["provenance"] = new JsonObject
                            {
                                ["source"] = candidate["source"].Copy(),
                                ["evidence"] = candidate["evidence"].Copy(),
                            },
                            ["operation"] = field["value"].Text("cardinality") == "many" ? "add" : "set",
                        }
                    );
                }
                ValidateTermGraph(db);
                db.Execute(
                    "UPDATE tag_candidates SET state=@s WHERE id=@id",
                    ("@s", args.Flag("accept") ? "accepted" : "rejected"),
                    ("@id", args.Text("id"))
                );
                Emit(
                    db,
                    args.Flag("accept") ? "candidate.accepted" : "candidate.rejected",
                    new JsonObject
                    {
                        ["id"] = args.Text("id"),
                        ["subject"] = new JsonObject
                        {
                            ["kind"] = candidate.Text("subjectKind"),
                            ["id"] = candidate.Text("subjectId"),
                        },
                    }
                );
                tx.Commit();
                return new { generation = Generation(db) };
            },
            ct
        );
    }
}
