using System.Text.Json.Nodes;
using Json.Schema;

namespace Vroom.Core.Tagging;

public abstract record QueryPredicate;

public sealed record LogicalPredicate(string Operator, IReadOnlyList<QueryPredicate> Arguments) : QueryPredicate;

public sealed record NotPredicate(QueryPredicate Argument) : QueryPredicate;

public sealed record FieldPredicate(string Operator, string Tag, JsonNode? Value = null) : QueryPredicate;

public sealed record InPredicate(string Tag, IReadOnlyList<JsonNode?> Values, bool Negated = false) : QueryPredicate;

public sealed record RelatedPredicate(string Tag, QueryPredicate Where) : QueryPredicate;

public sealed record FacetPredicate(string Tag, string Facet, string Selection) : QueryPredicate;

public sealed record ScopeSelector(string Kind, long? StartUs, long? EndUs, string Match, string? PartId = null);

public sealed record ScopedPredicate(ScopeSelector Scope, string Quantifier, QueryPredicate Where) : QueryPredicate;

/// <summary>Parsing is performed once, before SQL compilation. Every entry point uses this contract.</summary>
public static class QueryContract
{
    public static void Validate(JsonObject request)
    {
        var result = TagSchemas
            .Get("query.schema.json")
            .Evaluate(request, new EvaluationOptions { OutputFormat = OutputFormat.Hierarchical });
        if (!result.IsValid)
            throw new TagException("QUERY_SCHEMA_INVALID", "/query");
        Parse(request["where"]);
    }

    public static QueryPredicate Parse(JsonNode? expression)
    {
        var count = 0;
        return Read(expression, 0, ref count);
    }

    private static QueryPredicate Read(JsonNode? expression, int depth, ref int count)
    {
        if (depth > 24 || ++count > 1000)
            throw new TagException("QUERY_LIMIT", "/where");
        if (expression is null)
            return new LogicalPredicate("and", []);
        var op = expression.Text("op");
        switch (op)
        {
            case "and":
            case "or":
                var children = new List<QueryPredicate>();
                foreach (var item in expression.List("args"))
                    children.Add(Read(item, depth + 1, ref count));
                return new LogicalPredicate(op, children);
            case "not":
                return new NotPredicate(Read(expression["arg"], depth + 1, ref count));
            case "related":
                return new RelatedPredicate(expression.Text("tag"), Read(expression["where"], depth + 1, ref count));
            case "facet":
                return new FacetPredicate(
                    expression.Text("tag"),
                    expression.Text("facet"),
                    expression.Text("selection")
                );
            case "in":
            case "not-in":
                return new InPredicate(expression.Text("tag"), expression.List("values").ToArray(), op == "not-in");
            case "scoped":
                var s = expression["scope"]!;
                long? Microseconds(string key) =>
                    s[key] is null ? null
                    : long.TryParse(s.Text(key), out var value) && value >= 0 ? value
                    : throw new TagException("QUERY_SCOPE_INVALID", "/scope/" + key);
                var start = Microseconds("startUs");
                var end = Microseconds("endUs");
                if (
                    end.HasValue && (!start.HasValue || end <= start)
                    || s.Text("kind") == "whole" && (start.HasValue || end.HasValue)
                )
                    throw new TagException("QUERY_SCOPE_INVALID", "/scope");
                if (s["partId"] is not null && s.Text("kind") == "whole")
                    throw new TagException("QUERY_SCOPE_INVALID", "/scope/partId");
                return new ScopedPredicate(
                    new(s.Text("kind"), start, end, s.Text("match", "overlaps"), s["partId"]?.ToString()),
                    expression.Text("quantifier"),
                    Read(expression["where"], depth + 1, ref count)
                );
            case "not-between":
            case "not-like":
            case "glob":
            case "not-glob":
            case "starts-with":
            case "ends-with":
            case "is":
            case "is-not":
            case "between":
            case "like":
            case "eq":
            case "ne":
            case "gt":
            case "gte":
            case "lt":
            case "lte":
            case "contains":
            case "has":
            case "exists":
            case "missing":
                return new FieldPredicate(op, expression.Text("tag"), expression["value"]);
            default:
                throw new TagException("QUERY_OPERATOR_UNAVAILABLE", "/where/op", op);
        }
    }
}
