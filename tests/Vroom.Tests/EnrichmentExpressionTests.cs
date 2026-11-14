using System.Text.Json.Nodes;
using Vroom.Core.Tagging;

namespace Vroom.Tests;

public sealed class EnrichmentExpressionTests
{
    [Fact]
    public void PublicExpressionFixturesMatchTheHost()
    {
        foreach (
            var fixture in JsonNode
                .Parse(
                    File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "enrichment-expressions.json"))
                )!
                .AsArray()
        )
        {
            var expression = new JsonObject
            {
                ["op"] = fixture!["op"].Copy(),
                ["args"] = new JsonArray(
                    fixture.List("args").Select(a => (JsonNode)new JsonObject { ["literal"] = a.Copy() }).ToArray()
                ),
            };
            Assert.Equal(
                TagJson.Canonical(fixture["expected"]),
                TagJson.Canonical(RuleExpression.Evaluate(expression, new(), new()))
            );
        }
    }
}
