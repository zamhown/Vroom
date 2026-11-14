using System.Text.Json;
using System.Text.Json.Nodes;

namespace Vroom.Core.Tagging;

internal sealed class TagQuery(CompiledDefinitions definitions)
{
    public List<(string Name, object? Value)> Parameters { get; } = [];
    private int aliases;

    internal string Parameter(object? value)
    {
        var name = "@tq" + Parameters.Count;
        Parameters.Add((name, value));
        return name;
    }

    private JsonObject FilterField(string key)
    {
        var d = definitions.Require(key);
        if (!d["query"].Flag("filter", true))
            throw new TagException("QUERY_FIELD_DISABLED", key + "/query/filter");
        return d;
    }

    internal JsonObject Feature(string key, string capability)
    {
        var d = definitions.Require(key);
        if (!(capability == "sort" ? d["query"].Flag("sort") : d["query"].List("groupBy").Count > 0))
            throw new TagException("QUERY_FIELD_DISABLED", key + "/query/" + capability);
        return d;
    }

    public string Column(string key, string capability, string mode = "value", string locale = "")
    {
        if (locale.Length == 0)
            locale = definitions.Package["i18n"].Text("defaultLocale");
        var d = Feature(key, capability);
        var field = Parameter(key);
        var source = $"e.subject_kind='film' AND e.subject_id=f.id AND e.scope_id='whole' AND e.tag_key={field}";
        if (d["value"].Text("cardinality") == "many")
        {
            if (mode is not ("min" or "max"))
                throw new TagException("QUERY_COLLECTION_SORT_MODE_REQUIRED", key);
            return $"(SELECT {mode}({(!ValueContracts.Enumerable(d) ? "j.value" : TermLabel("json_extract(j.value,'$.term')", locale))}) FROM tag_effective e,json_each(e.value_json) j WHERE {source})";
        }
        if (mode is "min" or "max")
            throw new TagException("QUERY_SORT_MODE_INVALID", key);
        var value = ValueContracts.Enumerable(d)
            ? mode == "label"
                ? TermLabel("json_extract(e.value_json,'$.term')", locale)
                : "json_extract(e.value_json,'$.term')"
            : "json_extract(e.value_json,'$')";
        if (mode == "label" && !ValueContracts.Enumerable(d))
            throw new TagException("QUERY_SORT_MODE_INVALID", key);
        return $"(SELECT {value} FROM tag_effective e WHERE {source})";
    }

    public (string Column, string Join) Group(string key, string mode = "value", string facet = "")
    {
        var d = Feature(key, "groupBy");
        if (
            !d["query"].List("groupBy").Any(n => n!.ToString() == mode)
            || mode == "facet" && d["facets"]?[facet] is null
        )
            throw new TagException("QUERY_GROUP_MODE_INVALID", key + "/query/groupBy");
        var parameter = Parameter(key);
        var join =
            $"LEFT JOIN tag_effective g ON g.subject_kind='film' AND g.subject_id=f.id AND g.scope_id='whole' AND g.tag_key={parameter}";
        if (mode == "member")
            return (
                "CASE WHEN m.type IN('object','array') THEN json(m.value) ELSE json_quote(m.value) END",
                join + " LEFT JOIN json_each(g.value_json) m ON 1=1"
            );
        if (mode == "facet")
        {
            var spec = d["facets"]?[facet] ?? throw new TagException("FACET_UNAVAILABLE", key);
            var bands = spec.List("bands")
                .Select(b =>
                    $"WHEN json_extract(g.value_json,'$') BETWEEN {Parameter(b.Number("gte"))} AND {Parameter(b.Number("lte"))} THEN {Parameter(b.Text("id"))}"
                );
            return (
                "json_quote(CASE "
                    + string.Join(" ", bands)
                    + $" ELSE {Parameter(spec["missing"].Text("id", "missing"))} END)",
                join
            );
        }
        return ("g.value_json", join);
    }

    public string Order(JsonObject request)
    {
        var fields = request.List("orderBy");
        if (fields.Count == 0 && request.Text("scope") is "continue-watching" or "recently-played")
            return "(SELECT s.last_played FROM playback_state s WHERE s.film_id=f.id) DESC NULLS LAST,f.id";
        if (fields.Count == 0 && request.Text("scope") == "recently-added")
            return "f.added DESC,f.id";
        if (fields.Count == 0)
        {
            // The default sort uses the same structure as an orderBy item.
            var sort = definitions.Package["catalogPolicy"]?["defaultSort"];
            var key = sort.Text("tag");
            if (key.Length == 0)
                return "f.added DESC,f.id";
            var d = definitions.Require(key);
            var mode = sort.Text(
                "mode",
                d["value"].Text("cardinality") == "many" ? "min"
                    : !ValueContracts.Enumerable(d) ? "value"
                    : "label"
            );
            return Column(key, "sort", mode, request.Text("locale"))
                + (sort.Text("direction", "desc") == "asc" ? " ASC" : " DESC")
                + (sort.Text("nulls", "last") == "first" ? " NULLS FIRST" : " NULLS LAST")
                + ",f.id";
        }
        return string.Join(
                ",",
                fields.Select(f =>
                    Column(f.Text("tag"), "sort", f.Text("mode", "value"), request.Text("locale"))
                    + (f.Text("direction", "desc") == "asc" ? " ASC" : " DESC")
                    + (f.Text("nulls", "last") == "first" ? " NULLS FIRST" : " NULLS LAST")
                )
            ) + ",f.id";
    }

    public (string[] Columns, string Join) Groups(JsonObject request)
    {
        var columns = new List<string>();
        var joins = new List<string>();
        foreach (var field in request.List("groupBy"))
        {
            var (column, join) = Group(field.Text("tag"), field.Text("mode", "value"), field.Text("facet"));
            var suffix = aliases++;
            string Alias(string sql) =>
                System.Text.RegularExpressions.Regex.Replace(sql, @"\b(g|m)\b", m => m.Value + suffix);
            columns.Add(Alias(column));
            joins.Add(Alias(join));
        }
        return (columns.ToArray(), string.Join(" ", joins));
    }

    private string TermLabel(string id, string locale)
    {
        var path = Parameter("$.label.\"" + locale.Replace("\"", "") + "\"");
        var language = Parameter("$.label.\"" + locale.Split('-')[0] + "\"");
        var fallback = Parameter(
            "$.label.\"" + definitions.Package["i18n"].Text("defaultLocale", "und").Replace("\"", "") + "\""
        );
        return $"(SELECT COALESCE(json_extract(t.payload,{path}),json_extract(t.payload,{language}),json_extract(t.payload,{fallback}),(SELECT value FROM json_each(t.payload,'$.label') LIMIT 1),t.id) FROM tag_term_catalog t WHERE t.id={id})";
    }

    public string Compile(JsonNode? expression, int depth = 0, string subjectKind = "film", string subjectId = "f.id")
    {
        QueryContract.Validate(new JsonObject { ["where"] = expression.Copy() });
        return Compile(QueryContract.Parse(expression), subjectKind, subjectId, "'whole'");
    }

    private string Compile(QueryPredicate node, string kind, string subject, string scope)
    {
        switch (node)
        {
            case LogicalPredicate l:
                return l.Arguments.Count == 0
                    ? l.Operator == "and"
                        ? "1=1"
                        : "0=1"
                    : "("
                        + string.Join(
                            l.Operator == "and" ? " AND " : " OR ",
                            l.Arguments.Select(a => Compile(a, kind, subject, scope))
                        )
                        + ")";
            case NotPredicate n:
                return "NOT (" + Compile(n.Argument, kind, subject, scope) + ")";
            case ScopedPredicate s:
                if (kind != "film" || scope != "'whole'")
                    throw new TagException("QUERY_SCOPE_CONTEXT_INVALID");
                var a = "s" + aliases++;
                var conditions = new List<string> { $"{a}.subject_kind='{kind}'", $"{a}.subject_id={subject}" };
                if (s.Scope.Kind != "any")
                    conditions.Add($"{a}.kind={Parameter(s.Scope.Kind)}");
                if (s.Scope.PartId is { } partId)
                    conditions.Add(
                        $"EXISTS(SELECT 1 FROM media_scope_projection msp WHERE msp.subject_id={a}.subject_id AND msp.scope_id={a}.scope_id AND msp.part_id={Parameter(partId)})"
                    );
                if (s.Scope.StartUs is { } start)
                {
                    var p = Parameter(start);
                    if (s.Scope.EndUs is { } end)
                    {
                        var q = Parameter(end);
                        conditions.Add(
                            s.Scope.Match == "contains"
                                ? $"{a}.start_us>={p} AND {a}.end_us<={q}"
                                : $"{a}.start_us<{q} AND ({a}.kind='point' AND {a}.start_us>={p} OR {a}.kind='interval' AND {a}.end_us>{p})"
                        );
                    }
                    else
                        conditions.Add(
                            $"({a}.kind='point' AND {a}.start_us={p} OR {a}.kind='interval' AND {a}.start_us<={p} AND {a}.end_us>{p})"
                        );
                }
                var match = Compile(s.Where, kind, subject, a + ".scope_id");
                var from = $"FROM tag_scope_index {a} WHERE " + string.Join(" AND ", conditions);
                return s.Quantifier switch
                {
                    "any" => $"EXISTS(SELECT 1 {from} AND ({match}))",
                    "none" => $"NOT EXISTS(SELECT 1 {from} AND ({match}))",
                    "all" => $"(EXISTS(SELECT 1 {from}) AND NOT EXISTS(SELECT 1 {from} AND ({match}) IS NOT TRUE))",
                    _ => throw new TagException("QUERY_QUANTIFIER_INVALID"),
                };
            case RelatedPredicate r:
                var relation = FilterField(r.Tag);
                if (!ValueContracts.Enumerable(relation))
                    throw new TagException("QUERY_RELATION_REQUIRED", r.Tag);
                var edge = "r" + aliases++;
                var key = Parameter(r.Tag);
                var nested = Compile(r.Where, "term", edge + ".target_id", "'whole'");
                return $"EXISTS(SELECT 1 FROM tag_reference_edges {edge} WHERE {edge}.subject_kind='{kind}' AND {edge}.subject_id={subject} AND {edge}.scope_id={scope} AND {edge}.tag_key={key} AND ({nested}))";
            case FacetPredicate f:
                var definition = FilterField(f.Tag);
                var facet = definition["facets"]?[f.Facet] ?? throw new TagException("FACET_UNAVAILABLE", f.Tag);
                if (facet["missing"].Text("id") == f.Selection)
                    return Compile(new FieldPredicate("missing", f.Tag), kind, subject, scope);
                var band =
                    facet.List("bands").FirstOrDefault(b => b.Text("id") == f.Selection)
                    ?? throw new TagException("FACET_UNAVAILABLE", f.Selection);
                return Compile(
                    new LogicalPredicate(
                        "and",
                        [new FieldPredicate("gte", f.Tag, band["gte"]), new FieldPredicate("lte", f.Tag, band["lte"])]
                    ),
                    kind,
                    subject,
                    scope
                );
            case InPredicate i:
                FilterField(i.Tag);
                var membership =
                    i.Values.Count == 0
                        ? "0"
                        : "("
                            + string.Join(
                                " OR ",
                                i.Values.Select(v =>
                                    Compile(
                                        new FieldPredicate(
                                            definitions.Require(i.Tag)["value"].Text("cardinality") == "many"
                                                ? "has"
                                                : "eq",
                                            i.Tag,
                                            v
                                        ),
                                        kind,
                                        subject,
                                        scope
                                    )
                                )
                            )
                            + ")";
                return i.Negated ? "NOT (" + membership + ")" : membership;
            case FieldPredicate f:
                return Field(f, kind, subject, scope);
            default:
                throw new TagException("QUERY_OPERATOR_UNAVAILABLE");
        }
    }

    private string Field(FieldPredicate f, string kind, string subject, string scope)
    {
        var d = FilterField(f.Tag);
        var key = Parameter(f.Tag);
        var where = $"e.subject_kind='{kind}' AND e.subject_id={subject} AND e.scope_id={scope} AND e.tag_key={key}";
        string Exists(string? condition = null) =>
            $"EXISTS(SELECT 1 FROM tag_effective e WHERE {where}"
            + (condition is null ? "" : $" AND ({condition})")
            + ")";
        if (f.Operator is "exists" or "missing")
            return (f.Operator == "missing" ? "NOT " : "") + Exists();
        if (f.Operator.StartsWith("not-"))
            return "NOT (" + Field(f with { Operator = f.Operator[4..] }, kind, subject, scope) + ")";
        if (f.Operator == "is-not")
            return "NOT (" + Field(f with { Operator = "is" }, kind, subject, scope) + ")";
        if (f.Operator == "is")
            return f.Value is null
                ? "NOT " + Exists()
                : "COALESCE(" + Field(f with { Operator = "eq" }, kind, subject, scope) + ",0)";
        if (f.Value is null)
            return "NULL";
        if (f.Operator == "between")
        {
            var bounds = f.Value as JsonArray ?? throw new TagException("QUERY_TYPE_MISMATCH", f.Tag);
            return "("
                + Field(new("gte", f.Tag, bounds[0]), kind, subject, scope)
                + " AND "
                + Field(new("lte", f.Tag, bounds[1]), kind, subject, scope)
                + ")";
        }
        var value = f.Value ?? throw new TagException("QUERY_VALUE_REQUIRED");
        var many = d["value"].Text("cardinality") == "many";
        var reference = ValueContracts.Enumerable(d);
        var schema = ValueContracts.Member(d["value"]);
        var type = schema.Text("type");
        if (f.Operator == "has" && !many)
            throw new TagException("QUERY_TYPE_MISMATCH", f.Tag);
        if (
            f.Operator
            is "like"
                or "glob"
                or "starts-with"
                or "ends-with"
                or "contains"
                or "gt"
                or "gte"
                or "lt"
                or "lte"
        )
        {
            if (
                many
                || reference
                || type is not ("string" or "number" or "integer")
                || (f.Operator is "contains" or "like" or "glob" or "starts-with" or "ends-with") && type != "string"
            )
                throw new TagException("QUERY_TYPE_MISMATCH", f.Tag);
        }
        if (many && f.Operator is "eq" or "ne")
        {
            if (!definitions.Accepts(d, value))
                throw new TagException("QUERY_TYPE_MISMATCH", f.Tag);
            return $"(SELECT e.value_json {(f.Operator == "eq" ? "=" : "<>")} {Parameter(TagJson.Canonical(value))} FROM tag_effective e WHERE {where})";
        }
        object scalar;
        if (reference)
        {
            var term = definitions.ResolveTerm(d, value) ?? throw new TagException("QUERY_REFERENCE_INVALID", f.Tag);
            scalar = term.Text("id");
        }
        else
        {
            var valid = type switch
            {
                "number" => value.GetValueKind() == JsonValueKind.Number,
                "integer" => value.GetValueKind() == JsonValueKind.Number
                    && JsonSerializer.Deserialize<double>(value.ToJsonString()) % 1 == 0,
                "boolean" => value.GetValueKind() is JsonValueKind.True or JsonValueKind.False,
                "string" => value.GetValueKind() == JsonValueKind.String,
                _ => false,
            };
            if (!valid)
                throw new TagException("QUERY_TYPE_MISMATCH", f.Tag);
            scalar = type switch
            {
                "number" or "integer" => JsonSerializer.Deserialize<double>(value.ToJsonString()),
                "boolean" => value.GetValue<bool>() ? 1 : 0,
                _ => value.GetValue<string>(),
            };
        }
        var op = f.Operator switch
        {
            "eq" or "has" => "=",
            "ne" => "<>",
            "contains" or "like" or "starts-with" or "ends-with" => "LIKE",
            "glob" => "GLOB",
            "gt" => ">",
            "gte" => ">=",
            "lt" => "<",
            "lte" => "<=",
            _ => throw new TagException("QUERY_OPERATOR_UNAVAILABLE"),
        };
        if (f.Operator is "contains" or "starts-with" or "ends-with")
            scalar =
                (f.Operator != "starts-with" ? "%" : "")
                + Escape((string)scalar)
                + (f.Operator != "ends-with" ? "%" : "");
        var parameter = Parameter(scalar);
        var suffix = f.Operator is "contains" or "like" or "starts-with" or "ends-with" ? " ESCAPE '\\'" : "";
        var column = reference ? "json_extract(e.value_json,'$.term')" : "json_extract(e.value_json,'$')";
        var condition = many
            ? $"EXISTS(SELECT 1 FROM json_each(e.value_json) j WHERE {(reference ? "json_extract(j.value,'$.term')" : "j.value")} {op} {parameter}{suffix})"
            : $"{column} {op} {parameter}{suffix}";
        return $"(SELECT ({condition}) FROM tag_effective e WHERE {where})";
    }

    internal static string Escape(string value) => value.Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_");

    public string Search(
        IEnumerable<string> fields,
        string text,
        string subjectKind = "film",
        string subjectId = "f.id"
    )
    {
        var allowed = fields.Distinct().ToArray();
        foreach (var key in allowed)
            FilterField(key);
        if (allowed.Length == 0)
            return "0=1";
        var keys = Parameter(JsonSerializer.Serialize(allowed));
        var search = Parameter("%" + Escape(text) + "%");
        return $"(EXISTS(SELECT 1 FROM tag_effective e WHERE e.subject_kind='{subjectKind}' AND e.subject_id={subjectId} AND e.scope_id='whole' AND e.tag_key IN(SELECT value FROM json_each({keys})) AND json_type(e.value_json)='text' AND json_extract(e.value_json,'$') LIKE {search} ESCAPE '\\') OR EXISTS(SELECT 1 FROM tag_reference_edges r JOIN tag_term_catalog t ON t.id=r.target_id WHERE r.subject_kind='{subjectKind}' AND r.subject_id={subjectId} AND r.scope_id='whole' AND r.tag_key IN(SELECT value FROM json_each({keys})) AND (EXISTS(SELECT 1 FROM json_each(t.payload,'$.label') l WHERE l.value LIKE {search} ESCAPE '\\') OR EXISTS(SELECT 1 FROM json_each(t.payload,'$.aliases') l WHERE l.value LIKE {search} ESCAPE '\\'))))";
    }
}
