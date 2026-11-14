using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using Json.Schema;

namespace Vroom.Core.Tagging;

/// <summary>The public capability registry drives editor choices and publication validation.</summary>
public static class CapabilityContract
{
    public static readonly JsonObject Registry = TagResources.Json("host-capabilities.json");

    // Every authored "icon" must name an entry of the single icon registry.
    private static IEnumerable<(string Pointer, string Name)> IconReferences(JsonNode? node, string pointer)
    {
        if (node is JsonObject obj)
            foreach (var (key, value) in obj)
            {
                var child = pointer + "/" + key.Replace("~", "~0").Replace("/", "~1");
                if (key == "icon" && value is JsonValue icon && icon.TryGetValue<string>(out var name))
                    yield return (child, name);
                else
                    foreach (var reference in IconReferences(value, child))
                        yield return reference;
            }
        else if (node is JsonArray array)
            for (var i = 0; i < array.Count; i++)
                foreach (var reference in IconReferences(array[i], pointer + "/" + i))
                    yield return reference;
    }

    public static void Validate(JsonObject package)
    {
        var requires = package["package"]?["requires"];
        if (
            requires.Number("definitionLanguage", Registry.Number("definitionLanguage"))
            != Registry.Number("definitionLanguage")
        )
            throw new TagException("CAPABILITY_UNSUPPORTED", "/package/requires/definitionLanguage");
        foreach (var feature in requires.List("features"))
            if (!Registry.List("features").Any(f => JsonNode.DeepEquals(f, feature)))
                throw new TagException("CAPABILITY_UNSUPPORTED", "/package/requires/features", feature!.ToString());
        foreach (var (pointer, name) in IconReferences(package, ""))
            if (Registry["icons"]?[name] is null)
                throw new TagException("ICON_UNAVAILABLE", pointer, name);
        var fields = package.List("definitions");
        for (var i = 0; i < fields.Count; i++)
        {
            var d = fields[i]!;
            var path = "/definitions/" + i;
            var component = d["input"].Text("component");
            var profile =
                Registry["components"]?[component]
                ?? throw new TagException("COMPONENT_UNAVAILABLE", path + "/input/component");
            if (
                profile.Text("cardinality") != d["value"].Text("cardinality")
                || !profile.List("types").Any(t => t!.ToString() == d["value"]?["schema"].Text("type"))
            )
                throw new TagException("COMPONENT_VALUE_MISMATCH", path + "/value");
            if (profile.Flag("enumerable") != (ValueContracts.Enumerable(d)))
                throw new TagException("COMPONENT_OPTIONS_MISMATCH", path + "/options");
            if (profile["valueContract"] is { } constraint)
            {
                var reference = constraint.Text("$ref").Split('/').Last();
                if (!JsonSchema.FromText(Registry["$defs"]![reference]!.ToJsonString()).Evaluate(d["value"]).IsValid)
                    throw new TagException("COMPONENT_VALUE_MISMATCH", path + "/value");
            }
            foreach (var display in d.Map("display"))
                if (
                    Registry["components"]?[display.Value.Text("component")] is { } renderer
                    && renderer.List("types").Count > 0
                    && !renderer.List("types").Any(t => t!.ToString() == d["value"]?["schema"].Text("type"))
                )
                    throw new TagException("DISPLAY_VALUE_MISMATCH", path + "/display/" + display.Key);
            if (d["subjectVocabularies"] is not null && !AnnotationTargets.Read(d.AsObject()).Contains("term-whole"))
                throw new TagException("SUBJECT_RESTRICTION_INACTIVE", path + "/subjectVocabularies");
            foreach (var mode in d["query"].List("groupBy"))
                if (
                    mode!.ToString() == "member" && d["value"].Text("cardinality") != "many"
                    || mode.ToString() == "facet" && (d["facets"] as JsonObject)?.Count is not > 0
                )
                    throw new TagException("GROUP_MODE_INVALID", path + "/query/groupBy");
            if (d["value"]?["default"] is { } fallback)
                CheckDefault(package, d, fallback, path + "/value/default");
            // A manual-clear policy is meaningless for fields users cannot edit.
            if (
                d["writes"] is JsonObject writes
                && writes["manual"]?.GetValue<bool>() == false
                && writes["manualClearBlocksAutomatic"] is not null
            )
                throw new TagException("WRITE_POLICY_INVALID", path + "/writes/manualClearBlocksAutomatic");
            // Rule IDs identify which rule produced a value; they must be meaningful and unique per field.
            var ruleIds = new HashSet<string>(StringComparer.Ordinal);
            foreach (var name in new[] { "initialization", "automation" })
                for (var j = 0; j < d.List(name).Count; j++)
                {
                    var id = d.List(name)[j].Text("id");
                    if (id.Length == 0 || id.All(char.IsAsciiDigit))
                        throw new TagException("RULE_ID_INVALID", path + "/" + name + "/" + j + "/id");
                    if (!ruleIds.Add(id))
                        throw new TagException("DUPLICATE_KEY", path + "/" + name + "/" + j + "/id");
                    CheckRule(package, d, d.List(name)[j]!, path + "/" + name + "/" + j);
                }
            var rules = d.List("initialization")
                .Concat(d.List("automation"))
                .Concat(
                    package
                        .Map("eventBindings")
                        .Where(p => p.Value.Text("tag") == d.Text("key"))
                        .Select(p => p.Value?["rule"])
                );
            foreach (var group in rules.GroupBy(r => r.Text("executor")))
                if (
                    Registry["executors"]?[group.Key] is { } capability
                    && capability.Number("maxPerField") is > 0 and var maximum
                    && group.Count() > maximum
                )
                    throw new TagException("RULE_LIMIT", path);
            if (
                d.List("enrichment").Count > 0
                && !(
                    AnnotationTargets.Supports(d.AsObject(), "film", "whole")
                    || AnnotationTargets.Supports(d.AsObject(), "term", "whole")
                )
            )
                throw new TagException("RULE_TARGET_UNSUPPORTED", path + "/enrichment");
            for (var j = 0; j < d.List("enrichment").Count; j++)
            {
                var rule = d.List("enrichment")[j]!;
                if (rule["transform"] is { } transform)
                    CheckExpression(package, transform, path + "/enrichment/" + j + "/transform");
                var source = package["sources"]?[rule.Text("source")];
                if (source?["parse"]?["fields"]?[rule.Text("field")] is null)
                    throw new TagException("SOURCE_FIELD_UNAVAILABLE", path + "/enrichment/" + j + "/field");
                if (rule.Text("apply") == "union" && d["value"].Text("cardinality") != "many")
                    throw new TagException("RULE_CARDINALITY_MISMATCH", path + "/enrichment/" + j + "/apply");
                if (rule["entities"] is JsonObject entities)
                {
                    if (d["writes"]?["createTerms"] is null || rule.Text("apply") != "suggest-only")
                        throw new TagException("RULE_CREATE_OPTIONS_INVALID", path + "/enrichment/" + j);
                    foreach (var name in new[] { "identity", "label" })
                        CheckExpression(package, entities[name]!, path + "/enrichment/" + j + "/entities/" + name);
                    foreach (var entry in entities.Map("annotations"))
                    {
                        var target =
                            fields.FirstOrDefault(f => f.Text("key") == entry.Key)
                            ?? throw new TagException("DEFINITION_UNAVAILABLE", entry.Key);
                        if (
                            !AnnotationTargets.Supports(target.AsObject(), "term", "whole")
                            || target.List("subjectVocabularies").Count > 0
                                && !target
                                    .List("subjectVocabularies")
                                    .Any(v => v!.ToString() == ValueContracts.Vocabulary(d))
                        )
                            throw new TagException("RULE_TARGET_UNSUPPORTED", entry.Key);
                        CheckExpression(
                            package,
                            entry.Value!,
                            path + "/enrichment/" + j + "/entities/annotations/" + entry.Key
                        );
                    }
                }
            }
        }
        foreach (var binding in package.Map("eventBindings"))
        {
            var field = fields.FirstOrDefault(d => d.Text("key") == binding.Value.Text("tag"));
            if (field is not null)
                CheckRule(package, field, binding.Value!["rule"]!, "/eventBindings/" + binding.Key + "/rule");
        }
        foreach (var identity in package["ui"].Map("identity"))
        foreach (var entry in identity.Value as JsonObject ?? [])
        {
            var path = "/ui/identity/" + identity.Key + "/" + entry.Key;
            var presentation = entry.Key == "primaryImagePresentation";
            CheckExpression(package, entry.Value!, path, imageFacts: presentation);
            if (
                presentation
                && Results(entry.Value).Any(result => result is not null && ImagePresentation(result) is null)
            )
                throw new TagException("IMAGE_PRESENTATION_UNAVAILABLE", path);
        }
        foreach (var source in package.Map("sources"))
        {
            if (source.Value?["subscription"] is { } subscription)
            {
                var toggle =
                    fields.FirstOrDefault(d => d.Text("key") == subscription.Text("enabledTag"))
                    ?? throw new TagException("DEFINITION_UNAVAILABLE", subscription.Text("enabledTag"));
                if (
                    toggle["value"].Text("cardinality") != "one"
                    || toggle["value"]?["schema"].Text("type") != "boolean"
                    || source.Value.Text("transport") != "http"
                )
                    throw new TagException("SUBSCRIPTION_INVALID", source.Key);
            }
            if (source.Value?["when"] is { } condition)
                CheckExpression(package, condition, "/sources/" + source.Key + "/when");
            SourceBrowserRules.Validate(source.Value!, "/sources/" + source.Key + "/request");
            var format = source.Value?["parse"].Text("format");
            var properties = Registry["sourceFormats"]?[format ?? ""];
            foreach (var field in source.Value?["parse"].Map("fields") ?? [])
            {
                var at = "/sources/" + source.Key + "/parse/fields/" + field.Key;
                foreach (var property in field.Value!.AsObject())
                    if (
                        properties?[property.Key] is null
                        && property.Key is not ("cardinality" or "resolveUrl" or "normalizeWith")
                    )
                        throw new TagException("SOURCE_PARAMETER_INVALID", at + "/" + property.Key);
                var required =
                    format is "html" or "xml" ? "selector"
                    : format == "json" ? "pointer"
                    : "patterns";
                if (field.Value[required] is null)
                    throw new TagException("SOURCE_PARAMETER_REQUIRED", at + "/" + required);
                if (field.Value["normalizeWith"] is { } normalize && package["rules"]?[normalize.ToString()] is null)
                    throw new TagException("MISSING_RULE", at + "/normalizeWith");
            }
            foreach (var parameter in source.Value?["request"].Map("parameters") ?? [])
                CheckExpression(
                    package,
                    parameter.Value!,
                    "/sources/" + source.Key + "/request/parameters/" + parameter.Key
                );
        }
    }

    // A default is a film-level expression over discovery facts whose result satisfies the value contract.
    private static void CheckDefault(JsonObject package, JsonNode d, JsonNode fallback, string path)
    {
        if (!AnnotationTargets.Supports(d, "film", "whole"))
            throw new TagException("TARGETS_INVALID", path);
        CheckExpression(package, fallback, path, 0, "film.discovered");
        if (fallback["tag"] is not null)
            throw new TagException("EXPRESSION_FIELD_UNAVAILABLE", path);
        if (
            fallback["literal"] is { } literal
            && !JsonSchema.FromText(ValueContracts.Full(d["value"]).ToJsonString()).Evaluate(literal).IsValid
        )
            throw new TagException("RULE_VALUE_MISMATCH", path + "/literal");
        if (fallback["fact"] is { } fact)
        {
            var type = Registry["facts"]?[fact.ToString()].Text("type");
            var target = d["value"]?["schema"].Text("type");
            if (
                ValueContracts.Enumerable(d)
                || d["value"].Text("cardinality") != "one"
                || type != target && !(type == "integer" && target == "number")
            )
                throw new TagException("RULE_FACT_TYPE_MISMATCH", path + "/fact");
        }
    }

    private static void CheckRule(JsonObject package, JsonNode d, JsonNode rule, string path)
    {
        var executor =
            Registry["executors"]?[rule.Text("executor")]
            ?? throw new TagException("EXECUTOR_UNAVAILABLE", path + "/executor");
        if (executor.List("events") is { Count: > 0 } events && !events.Any(e => e!.ToString() == rule.Text("event")))
            throw new TagException("RULE_EVENT_UNSUPPORTED", path + "/event");
        if (executor.List("applyModes") is { Count: > 0 } modes && !modes.Any(e => e!.ToString() == rule.Text("apply")))
            throw new TagException("RULE_APPLY_UNSUPPORTED", path + "/apply");
        if (!executor.List("targets").Any(t => AnnotationTargets.Read(d.AsObject()).Contains(t!.ToString())))
            throw new TagException("RULE_TARGET_UNSUPPORTED", path);
        if (
            !new[] { "film", "term" }.Any(kind =>
                AnnotationTargets.Supports(d, kind, "whole")
                && executor.List("targets").Any(t => t!.ToString() == kind + "-whole")
                && Registry["events"].List(kind).Any(e => e!.ToString() == rule.Text("event"))
            )
        )
            throw new TagException("RULE_EVENT_UNSUPPORTED", path + "/event");
        if (rule["when"] is { } condition)
            CheckExpression(package, condition, path + "/when", 0, rule.Text("event"));
        var args = rule["args"]!;
        if (rule.Text("executor") == "value.match@1")
        {
            var ids = new HashSet<string>();
            foreach (var row in args.List("cases"))
            {
                if (!ids.Add(row.Text("id")))
                    throw new TagException("DUPLICATE_KEY", path + "/args/cases");
                CheckExpression(package, row!["when"]!, path + "/args/cases/" + row.Text("id"), 0, rule.Text("event"));
                if (!JsonSchema.FromText(ValueContracts.Full(d["value"]).ToJsonString()).Evaluate(row["value"]).IsValid)
                    throw new TagException("RULE_VALUE_MISMATCH", path + "/args/cases");
            }
        }
        if (rule.Text("executor") == "fact.copy@1")
        {
            var type = Registry["facts"]?[args.Text("path")].Text("type");
            var target = d["value"]?["schema"].Text("type");
            if (
                ValueContracts.Enumerable(d)
                || d["value"].Text("cardinality") != "one"
                || type != target && !(type == "integer" && target == "number")
            )
                throw new TagException("RULE_FACT_TYPE_MISMATCH", path + "/args/path");
        }
        if (rule.Text("apply") == "union" && d["value"].Text("cardinality") != "many")
            throw new TagException("RULE_CARDINALITY_MISMATCH", path + "/apply");
        if (args.Flag("createOptions") && (d["writes"]?["createTerms"] is null || rule.Text("apply") != "suggest-only"))
            throw new TagException("RULE_CREATE_OPTIONS_INVALID", path + "/args/createOptions");
        if (rule.Text("executor") == "regex.extract@1" && (args["rule"] is null) == (args["patterns"] is null))
            throw new TagException("RULE_PATTERN_SOURCE_REQUIRED", path + "/args");
        if (args["rule"] is not null && args["normalize"] is not null)
            throw new TagException("RULE_PARAMETER_INACTIVE", path + "/args/normalize");
        if (
            args["vocabulary"] is { } vocabulary
            && (
                package["vocabularies"]?[vocabulary.ToString()] is null
                || ValueContracts.Vocabulary(d) != vocabulary.ToString()
            )
        )
            throw new TagException("RULE_VOCABULARY_MISMATCH", path + "/args/vocabulary");
        if (args["facet"] is { } facet && d["facets"]?[facet.ToString()] is null)
            throw new TagException("FACET_UNAVAILABLE", path + "/args/facet");
        if (rule.Text("executor") == "expression@1")
            CheckExpression(package, args["expression"]!, path + "/args/expression", 0, rule.Text("event"));
        if (
            rule.Text("executor") == "value.constant@1"
            && !JsonSchema.FromText(ValueContracts.Full(d["value"]).ToJsonString()).Evaluate(args["value"]).IsValid
        )
            throw new TagException("RULE_VALUE_MISMATCH", path + "/args/value");
    }

    private static void CheckExpression(
        JsonObject package,
        JsonNode expression,
        string path,
        int depth = 0,
        string? eventType = null,
        bool imageFacts = false
    )
    {
        if (depth > 24)
            throw new TagException("EXPRESSION_LIMIT", path);
        if (expression["tag"] is { } tag && !package.List("definitions").Any(d => d.Text("key") == tag.ToString()))
            throw new TagException("EXPRESSION_FIELD_UNAVAILABLE", path + "/tag");
        if (
            expression["fact"] is { } fact
            && Registry["facts"]?[fact.ToString()] is null
            && !((Registry["eventFacts"]?[fact.ToString()].List("events") ?? []).Any(e => e?.ToString() == eventType))
            && !(imageFacts && Registry["primaryImageFacts"]?[fact.ToString()] is not null)
        )
            throw new TagException("EXPRESSION_FACT_UNAVAILABLE", path + "/fact");
        var count = expression.List("args").Count;
        var op = expression.Text("op");
        if (op.Length > 0)
        {
            var capability =
                Registry["operations"]?[op] ?? throw new TagException("EXPRESSION_OPERATOR_UNAVAILABLE", path + "/op");
            if (
                count < capability.Number("minArgs")
                || count > capability.Number("maxArgs")
                || op == "case" && count % 2 == 0
            )
                throw new TagException("EXPRESSION_ARITY", path + "/args");
        }
        for (var i = 0; i < count; i++)
            CheckExpression(
                package,
                expression.List("args")[i]!,
                path + "/args/" + i,
                depth + 1,
                eventType,
                imageFacts
            );
    }

    // Literal values an expression can return; other results are only known when it is evaluated.
    private static IEnumerable<JsonNode?> Results(JsonNode? expression)
    {
        if (expression is not JsonObject e)
            yield break;
        if (e.ContainsKey("literal"))
        {
            yield return e["literal"];
            yield break;
        }
        var args = e.List("args");
        var branches = e.Text("op") switch
        {
            "case" => args.Where((_, i) => i % 2 == 1 || i == args.Count - 1),
            "first-valid" or "coalesce" => args,
            _ => [],
        };
        foreach (var branch in branches)
        foreach (var result in Results(branch))
            yield return result;
    }

    private static readonly ConcurrentDictionary<string, JsonSchema> PresentationParameters = new(
        StringComparer.Ordinal
    );

    /// <summary>A registered image presentation with its parameter defaults filled in, or null.</summary>
    public static JsonObject? ImagePresentation(JsonNode? value)
    {
        if (
            value is not JsonObject o
            || o.Any(p => p.Key is not ("component" or "props"))
            || o["component"] is not JsonValue component
            || !component.TryGetValue<string>(out var id)
            || Registry["imagePresentations"]?[id]?["parameters"] is not { } parameters
            || o["props"] is { } given && given is not JsonObject
        )
            return null;
        var reference = parameters.Text("$ref").Split('/').Last();
        var schema = Registry["$defs"]![reference]!;
        var props = o["props"].Copy() as JsonObject ?? [];
        if (
            !PresentationParameters
                .GetOrAdd(reference, _ => JsonSchema.FromText(schema.ToJsonString()))
                .Evaluate(props)
                .IsValid
        )
            return null;
        foreach (var (key, property) in schema.Map("properties"))
            if (props[key] is null && property?["default"] is { } fallback)
                props[key] = fallback.Copy();
        return new JsonObject { ["component"] = id, ["props"] = props };
    }

    // Monaco uses an offline, self-contained expansion of exactly the same resource graph.
    public static JsonNode? Expand(JsonNode? node, bool inRegistry = false)
    {
        if (node is JsonArray a)
            return new JsonArray(a.Select(n => Expand(n, inRegistry)).ToArray());
        if (node is not JsonObject o)
            return node.Copy();
        var result = new JsonObject();
        foreach (var property in o)
        {
            if (property.Key == "$ref" && property.Value is { } reference)
            {
                var text = reference.ToString();
                var uri = Registry.Text("$id");
                if (text.StartsWith(uri + "#/") || inRegistry && text.StartsWith("#/"))
                    text = "#/$defs/cap." + text[(text.IndexOf("$defs/", StringComparison.Ordinal) + 6)..];
                else if (text.StartsWith("urn:vroom:schema:tag-definitions:3#"))
                    text = text[text.IndexOf('#')..];
                result[property.Key] = text;
            }
            else
                result[property.Key] = Expand(property.Value, inRegistry);
        }
        // JSON Schema 2020-12 evaluates siblings of $ref too. Retain constraints,
        // annotations and the fragment's local definitions while rebasing references.
        return result;
    }
}
