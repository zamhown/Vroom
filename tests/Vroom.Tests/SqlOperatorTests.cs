using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;
using Vroom.Core.Tagging;

namespace Vroom.Tests;

public sealed class SqlOperatorTests
{
    private static JsonNode? Eval(string op, params object?[] args) =>
        RuleExpression.Evaluate(
            new JsonObject
            {
                ["op"] = op,
                ["args"] = new JsonArray(
                    args.Select(a =>
                            (JsonNode?)
                                new JsonObject { ["literal"] = System.Text.Json.JsonSerializer.SerializeToNode(a) }
                        )
                        .ToArray()
                ),
            },
            new(),
            new()
        );

    public static IEnumerable<object?[]> Comparisons()
    {
        yield return ["eq", new object?[] { 1, 1.0 }, "1=1.0"];
        yield return ["ne", new object?[] { null, 1 }, "NULL<>1"];
        yield return ["is", new object?[] { null, null }, "NULL IS NULL"];
        yield return ["is-not", new object?[] { null, 1 }, "NULL IS NOT 1"];
        yield return ["lt", new object?[] { "2026-01-01", "2026-12-01" }, @"'2026-01-01'<'2026-12-01'"];
        yield return ["lte", new object?[] { 2, 2 }, "2<=2"];
        yield return ["gt", new object?[] { 2, 1 }, "2>1"];
        yield return ["gte", new object?[] { null, 0 }, "NULL>=0"];
        yield return ["between", new object?[] { 10, 10, 30 }, "10 BETWEEN 10 AND 30"];
        yield return ["not-between", new object?[] { 30, 10, 30 }, "30 NOT BETWEEN 10 AND 30"];
        yield return ["between", new object?[] { 5, 10, null }, "5 BETWEEN 10 AND NULL"];
        yield return ["in", new object?[] { 2, new object?[] { 1, null } }, "2 IN (1,NULL)"];
        yield return ["in", new object?[] { 1, new object?[] { 1, null } }, "1 IN (1,NULL)"];
        yield return ["not-in", new object?[] { null, Array.Empty<object>() }, "NULL NOT IN ()"];
        yield return ["exists", new object?[] { 0 }, "0 IS NOT NULL"];
        yield return ["missing", new object?[] { null }, "NULL IS NULL"];
        yield return ["like", new object?[] { "a_50%", "A\\_50\\%" }, @"'a_50%' LIKE 'A\_50\%' ESCAPE '\'"];
        yield return ["not-like", new object?[] { "æ", "Æ" }, @"'æ' NOT LIKE 'Æ'"];
        yield return ["glob", new object?[] { "A9", "[A-Z][0-9]" }, @"'A9' GLOB '[A-Z][0-9]'"];
        yield return ["not-glob", new object?[] { "a9", "[A-Z]*" }, @"'a9' NOT GLOB '[A-Z]*'"];
        yield return ["glob", new object?[] { "]", "[]]" }, @"']' GLOB '[]]'"];
        yield return ["glob", new object?[] { "x", "[^]]" }, @"'x' GLOB '[^]]'"];
        yield return ["like", new object?[] { "😀", "_" }, @"'😀' LIKE '_'"];
        yield return ["contains", new object?[] { "A_50%", "50%" }, @"'A_50%' LIKE '%50\%%' ESCAPE '\'"];
        yield return ["starts-with", new object?[] { "A_50%", "a_" }, @"'A_50%' LIKE 'a\_%' ESCAPE '\'"];
        yield return ["ends-with", new object?[] { "A_50%", "%" }, @"'A_50%' LIKE '%\%' ESCAPE '\'"];
    }

    [Theory, MemberData(nameof(Comparisons))]
    public void PredicateResultsMatchSqlite(string op, object?[] args, string sql)
    {
        using var db = new SqliteConnection("Data Source=:memory:");
        db.Open();
        using var command = db.CreateCommand();
        command.CommandText = "SELECT " + sql;
        var expected = command.ExecuteScalar();
        var actual = Eval(op, args);
        if (expected is DBNull)
            Assert.Null(actual);
        else
            Assert.Equal(Convert.ToInt64(expected) != 0, actual!.GetValue<bool>());
    }

    [Fact]
    public void LogicRetainsUnknownUnderNestedNegation()
    {
        foreach (var a in new bool?[] { true, false, null })
        foreach (var b in new bool?[] { true, false, null })
        {
            PredicateResultsMatchSqlite("and", [a, b], $"{Sql(a)} AND {Sql(b)}");
            PredicateResultsMatchSqlite("or", [a, b], $"{Sql(a)} OR {Sql(b)}");
        }
        PredicateResultsMatchSqlite("not", [null], "NOT NULL");
        static string Sql(bool? b) =>
            b is null ? "NULL"
            : b.Value ? "1"
            : "0";
    }

    [Fact]
    public void ComputationsHaveNullSafeArithmeticAndLazyBranches()
    {
        Assert.Equal(8, Eval("add", 3, 5)!.GetValue<double>());
        Assert.Equal(-2, Eval("subtract", 3, 5)!.GetValue<double>());
        Assert.Equal(15, Eval("multiply", 3, 5)!.GetValue<double>());
        Assert.Equal(1.5, Eval("divide", 3, 2)!.GetValue<double>());
        Assert.Null(Eval("divide", 1, 0));
        Assert.Null(Eval("modulo", 1, 0));
        Assert.Null(Eval("add", null, 2));
        Assert.Equal(1, Eval("modulo", 5, 2)!.GetValue<double>());
        Assert.Equal(-2, Eval("negate", 2)!.GetValue<double>());
        Assert.Equal(2, Eval("abs", -2)!.GetValue<double>());
        Assert.Equal(1.3, Eval("round", 1.25, 1)!.GetValue<double>());
        Assert.Equal("abc", Eval("lower", "ABC")!.GetValue<string>());
        Assert.Equal("ABC", Eval("upper", "abc")!.GetValue<string>());
        Assert.Equal("x", Eval("trim", " x ")!.GetValue<string>());
        Assert.Equal(2, Eval("length", "😀a")!.GetValue<int>());
        Assert.Equal("ab", Eval("concat", "a", "b")!.GetValue<string>());
        Assert.Null(Eval("concat", "a", null));
        Assert.Equal("", Eval("coalesce", null, "", "next")!.GetValue<string>());
        Assert.Equal("next", Eval("first-valid", null, "", "next")!.GetValue<string>());
        Assert.Null(Eval("nullif", 2, 2));
        Assert.Equal(3, Eval("nullif", 3, 2)!.GetValue<int>());
        Assert.True(Eval("has", new[] { 1, 2 }, 2)!.GetValue<bool>());
        Assert.Equal(2, Eval("count", new[] { 1, 2 })!.GetValue<int>());
        Assert.Equal("chosen", Eval("case", null, "ignored", true, "chosen", "fallback")!.GetValue<string>());
        Assert.Null(Eval("not-like", new string('x', 4000), new string('%', 4000)));
        Assert.Throws<TagException>(() => Eval("eq", 1));
    }
}

public sealed partial class TaggingTests
{
    [Fact]
    public async Task QueryAndRulesAgreeOnMissingNegationMembershipAndPatterns()
    {
        var key = "user.operator.text";
        var d = await AddDefinition(key);
        d["value"]!["schema"] = new JsonObject { ["type"] = "string" };
        d["input"] = new JsonObject { ["component"] = "text@1" };
        await Publish(d);
        await Batch(Write(key, JsonValue.Create("A_50%")));
        await repo.ImportMediaAsync(
            new()
            {
                LibraryId = "lib",
                Path = Path.Combine(directory, "no-value.mp4"),
                Size = 1,
            }
        );
        foreach (
            var (op, v, count) in new[]
            {
                ("starts-with", "a_", 1),
                ("ends-with", "%", 1),
                ("not-like", "Z%", 1),
                ("glob", "A[0-9]*", 0),
                ("is-not", "Z", 2),
            }
        )
        {
            var q = new JsonObject
            {
                ["ignoreDefaultQuery"] = true,
                ["where"] = new JsonObject
                {
                    ["op"] = op,
                    ["tag"] = key,
                    ["value"] = v,
                },
            };
            Assert.Equal(count, (await engine.QueryAsync(q)).Number("total"));
        }
        foreach (var op in new[] { "in", "not-in" })
        {
            var q = new JsonObject
            {
                ["ignoreDefaultQuery"] = true,
                ["where"] = new JsonObject
                {
                    ["op"] = op,
                    ["tag"] = key,
                    ["values"] = new JsonArray("absent", null),
                },
            };
            Assert.Equal(0, (await engine.QueryAsync(q)).Number("total"));
        }
        Assert.Equal(
            1,
            (
                await engine.QueryAsync(
                    new()
                    {
                        ["ignoreDefaultQuery"] = true,
                        ["where"] = new JsonObject
                        {
                            ["op"] = "not",
                            ["arg"] = new JsonObject
                            {
                                ["op"] = "eq",
                                ["tag"] = key,
                                ["value"] = "absent",
                            },
                        },
                    }
                )
            ).Number("total")
        );
    }
}
