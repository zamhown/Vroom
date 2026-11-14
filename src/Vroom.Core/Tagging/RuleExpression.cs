using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Vroom.Core.Tagging;

/// <summary>Pure, bounded SQL-style expressions. Missing media facts are NULL, never zero.</summary>
public static class RuleExpression
{
    public static JsonNode? Evaluate(JsonNode? expression, JsonObject values, JsonObject facts, int depth = 0)
    {
        if (depth > 24)
            throw new TagException("EXPRESSION_LIMIT");
        if (expression is not JsonObject e)
            return expression?.DeepClone();
        if (e["tag"] is { } tag)
            return values[tag.ToString()]?["value"]?.DeepClone();
        if (e["fact"] is { } fact)
            return TagJson.Get(facts, fact.ToString())?.DeepClone();
        if (e.ContainsKey("literal"))
            return e["literal"]?.DeepClone();
        var op = e.Text("op");
        var expressions = e.List("args");
        var spec =
            CapabilityContract.Registry["operations"]?[op] ?? throw new TagException("EXPRESSION_OPERATOR_UNAVAILABLE");
        if (expressions.Count < spec.Number("minArgs") || expressions.Count > spec.Number("maxArgs"))
            throw new TagException("EXPRESSION_ARITY");
        JsonNode? Eval(JsonNode? n) => Evaluate(n, values, facts, depth + 1);
        if (op is "first-valid" or "coalesce")
            return expressions
                .Select(Eval)
                .FirstOrDefault(n => n is not null && (op == "coalesce" || n.ToString().Length > 0));
        if (op == "case")
        {
            if (expressions.Count < 3 || expressions.Count % 2 == 0)
                throw new TagException("EXPRESSION_ARITY");
            for (var i = 0; i < expressions.Count - 1; i += 2)
                if (Truth(Eval(expressions[i])) == true)
                    return Eval(expressions[i + 1]);
            return Eval(expressions[^1]);
        }
        var a = expressions.Select(Eval).ToArray();
        bool? result;
        if (op == "and")
            return Bool(
                a.Any(x => Truth(x) == false) ? false
                : a.Any(x => Truth(x) == null) ? null
                : true
            );
        if (op == "or")
            return Bool(
                a.Any(x => Truth(x) == true) ? true
                : a.Any(x => Truth(x) == null) ? null
                : false
            );
        if (op == "not")
            return Bool(Truth(a[0]) is { } b ? !b : null);
        if (op is "exists" or "missing")
            return Bool(op == "exists" ? a[0] is not null : a[0] is null);
        if (op is "is" or "is-not")
            return Bool((a[0] is null && a[1] is null || Equal(a[0], a[1]) == true) == (op == "is"));
        if (op == "nullif")
            return Equal(a[0], a[1]) == true ? null : a[0];
        if (op is "in" or "not-in")
        {
            if (a[1] is not JsonArray list)
                return null;
            result =
                list.Count == 0 ? false
                : list.Any(x => Equal(a[0], x) == true) ? true
                : a[0] is null || list.Any(x => x is null) ? null
                : false;
            return Bool(op == "not-in" ? Invert(result) : result);
        }
        if (op is "between" or "not-between")
        {
            var lower = Compare(a[0], a[1]);
            var upper = Compare(a[0], a[2]);
            result =
                lower < 0 || upper > 0 ? false
                : lower is null || upper is null ? null
                : true;
            return Bool(op == "not-between" ? Invert(result) : result);
        }
        if (a.Any(x => x is null))
            return null;
        if (op == "url-encode")
            return a[0]?.GetValueKind() == JsonValueKind.String
                ? JsonValue.Create(Uri.EscapeDataString(a[0]!.GetValue<string>()))
                : null;
        if (op == "date-only")
        {
            var raw = a[0]!.ToString();
            if (raw.StartsWith('+'))
                raw = raw[1..];
            return
                raw.Length >= 10
                && (raw.Length == 10 || raw[10] == 'T')
                && DateOnly.TryParseExact(
                    raw[..10],
                    "yyyy-MM-dd",
                    CultureInfo.InvariantCulture,
                    DateTimeStyles.None,
                    out var date
                )
                ? JsonValue.Create(date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture))
                : null;
        }
        if (op == "object-get")
            return a[0] is JsonObject obj && a[1]?.GetValueKind() == JsonValueKind.String
                ? obj[a[1]!.GetValue<string>()].Copy()
                : null;
        if (op == "parse-number")
            return
                double.TryParse(a[0]!.ToString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed)
                && double.IsFinite(parsed)
                ? JsonValue.Create(parsed)
                : null;
        if (op is "array-distinct" or "array-union" or "array-intersect")
        {
            if (a.Any(x => x is not JsonArray) || a.Sum(x => ((JsonArray)x!).Count) > 10000)
                return null;
            var all =
                op == "array-union"
                    ? a.OfType<JsonArray>().SelectMany(x => x)
                    : (IEnumerable<JsonNode?>)a[0]!.AsArray();
            if (op == "array-intersect")
                all = all.Where(v => a.Skip(1).All(x => x!.AsArray().Any(other => JsonNode.DeepEquals(v, other))));
            return new JsonArray(all.DistinctBy(TagJson.Canonical).Select(v => v.Copy()).ToArray());
        }
        if (op is "eq" or "ne")
            return Bool(op == "eq" ? Equal(a[0], a[1]) : Invert(Equal(a[0], a[1])));
        if (op is "gt" or "gte" or "lt" or "lte")
        {
            var c = Compare(a[0], a[1]);
            return Bool(
                c is null
                    ? null
                    : op switch
                    {
                        "gt" => c > 0,
                        "gte" => c >= 0,
                        "lt" => c < 0,
                        _ => c <= 0,
                    }
            );
        }
        if (op == "has")
            return a[0] is JsonArray items ? Bool(items.Any(x => Equal(x, a[1]) == true)) : null;
        if (op == "count")
            return a[0] is JsonArray array ? JsonValue.Create(array.Count) : null;
        if (op == "concat")
            return JsonValue.Create(string.Join(e.Text("separator"), a.Select(x => x!.ToString())));
        var strings = a.All(x => x?.GetValueKind() == JsonValueKind.String);
        if (strings)
        {
            var s = a[0]!.GetValue<string>();
            var other = a.Length > 1 ? a[1]!.GetValue<string>() : "";
            switch (op)
            {
                case "like":
                case "not-like":
                case "glob":
                case "not-glob":
                    var match = Matches(s, other, op.EndsWith("glob"));
                    return Bool(op.StartsWith("not-") ? Invert(match) : match);
                case "contains":
                    return Bool(AsciiLower(s).Contains(AsciiLower(other), StringComparison.Ordinal));
                case "starts-with":
                    return Bool(AsciiLower(s).StartsWith(AsciiLower(other), StringComparison.Ordinal));
                case "ends-with":
                    return Bool(AsciiLower(s).EndsWith(AsciiLower(other), StringComparison.Ordinal));
                case "length":
                    return JsonValue.Create(s.EnumerateRunes().Count());
                case "lower":
                    return JsonValue.Create(AsciiLower(s));
                case "upper":
                    return JsonValue.Create(string.Concat(s.Select(c => c is >= 'a' and <= 'z' ? (char)(c - 32) : c)));
                case "trim":
                    return JsonValue.Create(s.Trim(' '));
            }
        }
        var nums = a.Select(Number).ToArray();
        if (nums.Any(n => !n.HasValue))
            return null;
        var n = nums.Select(n => n!.Value).ToArray();
        double? numeric = op switch
        {
            "add" => n.Sum(),
            "subtract" => n[0] - n[1],
            "multiply" => n.Aggregate(1d, (v, x) => v * x),
            "divide" => n[1] == 0 ? null : n[0] / n[1],
            "modulo" => Math.Truncate(n[1]) == 0 ? null : Math.Truncate(n[0]) % Math.Truncate(n[1]),
            "negate" => -n[0],
            "abs" => Math.Abs(n[0]),
            "round" => Math.Round(n[0], Math.Clamp(n.Length > 1 ? (int)n[1] : 0, 0, 15), MidpointRounding.AwayFromZero),
            _ => null,
        };
        return numeric.HasValue && double.IsFinite(numeric.Value) ? JsonValue.Create(numeric.Value) : null;
    }

    private static JsonNode? Bool(bool? b) => b.HasValue ? JsonValue.Create(b.Value) : null;

    private static bool? Invert(bool? b) => b.HasValue ? !b.Value : null;

    private static bool? Truth(JsonNode? n) =>
        n?.GetValueKind() is JsonValueKind.True ? true
        : n?.GetValueKind() is JsonValueKind.False ? false
        : null;

    private static double? Number(JsonNode? n) =>
        n?.GetValueKind() == JsonValueKind.Number
        && double.TryParse(n.ToJsonString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var v)
        && double.IsFinite(v)
            ? v
            : null;

    private static bool? Equal(JsonNode? a, JsonNode? b) =>
        a is null || b is null ? null
        : Number(a) is { } x && Number(b) is { } y ? x == y
        : JsonNode.DeepEquals(a, b);

    private static int? Compare(JsonNode? a, JsonNode? b) =>
        Number(a) is { } x && Number(b) is { } y ? x.CompareTo(y)
        : a?.GetValueKind() == JsonValueKind.String && b?.GetValueKind() == JsonValueKind.String
            ? string.CompareOrdinal(a.GetValue<string>(), b.GetValue<string>())
        : null;

    private static string AsciiLower(string s) =>
        string.Concat(s.Select(c => c is >= 'A' and <= 'Z' ? (char)(c + 32) : c));

    private static bool? Matches(string value, string pattern, bool glob)
    {
        // Bounded dynamic programming, not a regex with exponential wildcard backtracking.
        if (pattern.Length > 4096 || (long)pattern.Length * value.Length > 8_000_000)
            return null;
        if (!glob)
        {
            value = AsciiLower(value);
            pattern = AsciiLower(pattern);
        }
        var text = value.EnumerateRunes().Select(r => r.Value).ToArray();
        var p = pattern.EnumerateRunes().Select(r => r.Value).ToArray();
        var previous = new bool[text.Length + 1];
        previous[0] = true;
        for (var i = 0; i < p.Length; i++)
        {
            var c = p[i];
            var any = c == (glob ? '*' : '%');
            var one = c == (glob ? '?' : '_');
            int[]? set = null;
            if (!glob && c == '\\')
            {
                if (++i == p.Length)
                    return false;
                c = p[i];
                any = one = false;
            }
            else if (glob && c == '[')
            {
                var start = i + 1;
                var search = start;
                if (search < p.Length && p[search] == '^')
                    search++;
                if (search < p.Length && p[search] == ']')
                    search++;
                var close = Array.IndexOf(p, (int)']', search);
                if (close < 0)
                    return false;
                set = p[start..close];
                i = close;
            }
            var next = new bool[text.Length + 1];
            next[0] = any && previous[0];
            for (var j = 1; j <= text.Length; j++)
                next[j] = any
                    ? previous[j] || next[j - 1]
                    : previous[j - 1] && (set is not null ? InSet(text[j - 1], set) : one || text[j - 1] == c);
            previous = next;
        }
        return previous[text.Length];
    }

    private static bool InSet(int c, int[] set)
    {
        var negated = set.Length > 0 && set[0] == '^';
        var found = false;
        for (var i = negated ? 1 : 0; i < set.Length; i++)
            if (i + 2 < set.Length && set[i + 1] == '-')
            {
                found |= c >= set[i] && c <= set[i + 2];
                i += 2;
            }
            else
                found |= c == set[i];
        return found != negated;
    }
}
