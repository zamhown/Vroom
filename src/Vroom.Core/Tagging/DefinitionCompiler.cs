using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Json.Schema;

namespace Vroom.Core.Tagging;

public sealed partial class CompiledDefinitions(JsonObject package)
{
    public JsonObject Package { get; } = package;
    public string Hash { get; } = TagJson.Hash(package);
    public Dictionary<string, JsonObject> Definitions { get; } =
        package.List("definitions").OfType<JsonObject>().ToDictionary(d => d.Text("key"), StringComparer.Ordinal);
    public Dictionary<string, JsonSchema> ValueSchemas { get; } =
        package
            .List("definitions")
            .OfType<JsonObject>()
            .ToDictionary(
                d => d.Text("key"),
                d => JsonSchema.FromText(ValueContracts.Full(d["value"]).ToJsonString()),
                StringComparer.Ordinal
            );
    public Dictionary<string, JsonSchema> MemberSchemas { get; } =
        package
            .List("definitions")
            .OfType<JsonObject>()
            .Where(d => d["value"].Text("cardinality") == "many")
            .ToDictionary(
                d => d.Text("key"),
                d => JsonSchema.FromText(ValueContracts.Member(d["value"]).ToJsonString())
            );

    public JsonObject Require(string key) =>
        Definitions.TryGetValue(key, out var d) && d.Flag("enabled", true)
            ? d
            : throw new TagException("DEFINITION_UNAVAILABLE", key);

    public bool DescendsFrom(string key, string ancestor)
    {
        var seen = new HashSet<string>();
        var queue = new Stack<string>();
        queue.Push(key);
        while (queue.TryPop(out var at))
        {
            if (!seen.Add(at) || !Definitions.TryGetValue(at, out var d) || !d.Flag("enabled", true))
                continue;
            if (at == ancestor)
                return true;
            foreach (var parent in d.List("parents"))
                queue.Push(parent!.ToString());
        }
        return false;
    }

    public string ValueHash(JsonObject d) =>
        TagJson.Hash(
            new JsonObject
            {
                ["value"] = d["value"].Copy(),
                ["targets"] = new JsonArray(
                    AnnotationTargets.Read(d).Select(t => (JsonNode?)JsonValue.Create(t)).ToArray()
                ),
            }
        );

    public bool Accepts(JsonObject d, JsonNode? value)
    {
        if (!ValueSchemas[d.Text("key")].Evaluate(value).IsValid)
            return false;
        if (
            d["value"]?["schema"].Text("format") == "date"
            && !DateOnly.TryParseExact(
                value?.ToString(),
                "yyyy-MM-dd",
                System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.None,
                out _
            )
        )
            return false;
        if (ValueContracts.Enumerable(d))
            foreach (var item in value is JsonArray a ? a : new JsonArray(value.Copy()))
                if (ResolveTerm(d, item) is null)
                    return false;
        return true;
    }

    public (JsonNode? Value, string? Issue) Project(JsonObject record)
    {
        if (!Definitions.TryGetValue(record.Text("tagKey"), out var d) || !d.Flag("enabled", true))
            return (null, "DEFINITION_UNAVAILABLE");
        if (!AnnotationTargets.Supports(d, record["subject"].Text("kind"), record["scope"].Text("kind")))
            return (null, "SCOPE_UNSUPPORTED");
        if (SubjectIssue(d, record["subject"]!) is { } subjectIssue)
            return (null, subjectIssue);
        var contract = record["origin"]?["contract"];
        if (
            contract is not null
            && (
                !JsonNode.DeepEquals(contract["semanticVersion"], d["value"]?["semanticVersion"])
                || !JsonNode.DeepEquals(contract["unit"], d["value"]?["unit"])
                || !JsonNode.DeepEquals(contract["cardinality"], d["value"]?["cardinality"])
            )
        )
            return (null, "VALUE_CONTRACT_CHANGED");
        if (record.Text("operation") == "clear")
            return (null, null);
        var value = record["value"].Copy();
        if (d["value"].Text("cardinality") == "many" && value is JsonArray values)
        {
            var accepted = new JsonArray();
            foreach (var member in values)
            {
                // Membership/domain checks without enforcing collection min/max on each singleton.
                var memberSchema = MemberSchemas[d.Text("key")];
                if (
                    memberSchema.Evaluate(member).IsValid
                    && (!ValueContracts.Enumerable(d) || ResolveTerm(d, member) is not null)
                )
                    accepted.Add(member.Copy());
            }
            if (!Accepts(d, accepted))
                return (null, "VALUE_OUT_OF_DOMAIN");
            return (accepted, accepted.Count == values.Count ? null : "PARTIAL_INTERSECTION");
        }
        return Accepts(d, value) ? (value, null) : (null, "VALUE_OUT_OF_DOMAIN");
    }
}

public sealed class DefinitionCompiler
{
    private static readonly JsonSchema schema = TagSchemas.Get("tag-definitions.schema.json");
    private static readonly JsonObject Capabilities = TagResources.Json("host-capabilities.json");
    public static readonly string[] Surfaces = Capabilities.List("layoutSurfaces").Select(n => n!.ToString()).ToArray();
    public static readonly string[] FilmEvents = Capabilities["events"]
        .List("film")
        .Select(n => n!.ToString())
        .ToArray();
    public static readonly string[] Events = FilmEvents
        .Concat(Capabilities["events"].List("notification").Select(n => n!.ToString()))
        .ToArray();

    public CompiledDefinitions Compile(DefinitionDocument document)
    {
        var package = document.Root;
        if (package.ToJsonString().Length > 4_000_000)
            throw new TagException("CONFIG_TOO_LARGE");
        var result = schema.Evaluate(package, new EvaluationOptions { OutputFormat = OutputFormat.Hierarchical });
        if (!result.IsValid)
            throw new TagException("SCHEMA_INVALID", "", string.Join("; ", SchemaErrors(result).Take(25)));
        CapabilityContract.Validate(package);
        var defs = package.List("definitions").OfType<JsonObject>().ToArray();
        if (defs.Select(d => d.Text("key")).Distinct().Count() != defs.Length)
            throw new TagException("DUPLICATE_KEY");
        if (defs.Length > 50000)
            throw new TagException("CONFIG_TOO_LARGE");
        var map = defs.ToDictionary(d => d.Text("key"));
        var visiting = new HashSet<string>();
        var done = new HashSet<string>();
        void Visit(string key)
        {
            if (done.Contains(key))
                return;
            if (!map.TryGetValue(key, out var d))
                throw new TagException("MISSING_REFERENCE", key);
            if (!visiting.Add(key))
                throw new TagException("DEFINITION_CYCLE", key, string.Join(" → ", visiting.Append(key)));
            foreach (var p in d.List("parents"))
                Visit(p!.ToString());
            visiting.Remove(key);
            done.Add(key);
        }
        foreach (var d in defs)
        {
            Visit(d.Text("key"));
            CheckValueSchema(d["value"]!["schema"]!, 0);
            // value.schema describes one value; a "many" field is a set of such values, never nested arrays.
            if (ValueContracts.Many(d["value"]) && d["value"]!["schema"].Text("type") == "array")
                throw new TagException("CARDINALITY_MISMATCH", d.Text("key"));
            if (ValueContracts.Enumerable(d) && package["vocabularies"]?[ValueContracts.Vocabulary(d)] is null)
                throw new TagException("VOCABULARY_UNAVAILABLE", d.Text("key"));
            if (ValueContracts.Enumerable(d))
            {
                var member = ValueContracts.Member(d["value"]);
                if (
                    member.Text("type") != "object"
                    || member?["properties"]?["term"].Text("type") != "string"
                    || !member.List("required").Any(n => n?.ToString() == "term")
                )
                    throw new TagException("TERM_REFERENCE_SCHEMA_REQUIRED", d.Text("key"));
            }
            foreach (var v in d.List("subjectVocabularies"))
                if (package["vocabularies"]?[v!.ToString()] is null)
                    throw new TagException("VOCABULARY_UNAVAILABLE", v!.ToString());
            if (d["group"] is { } group && package["groups"]?[group.ToString()] is null)
                throw new TagException("GROUP_UNAVAILABLE", group.ToString());
            if (d.List("placements").Select(p => p.Text("id")).Distinct().Count() != d.List("placements").Count)
                throw new TagException("DUPLICATE_PLACEMENT", d.Text("key"));
            foreach (var r in d.List("initialization").Concat(d.List("automation")))
            {
                if (!FilmEvents.Contains(r.Text("event")))
                    throw new TagException("EVENT_UNAVAILABLE", d.Text("key"));
                if (r?["args"]?["rule"] is { } key && package["rules"]?[key.ToString()] is null)
                    throw new TagException("MISSING_RULE", key.ToString());
            }
            foreach (var r in d.List("enrichment"))
                if (package["sources"]?[r.Text("source")] is null)
                    throw new TagException("MISSING_SOURCE", r.Text("source"));
        }
        foreach (var binding in package.Map("eventBindings"))
            if (
                !map.ContainsKey(binding.Value.Text("tag"))
                || !FilmEvents.Contains(binding.Value?["rule"].Text("event") ?? "")
            )
                throw new TagException("EVENT_BINDING_INVALID", binding.Key);
        foreach (var action in package["ui"].Map("actions"))
            if (!Capabilities.List("uiCommands").Any(command => command?.ToString() == action.Value.Text("command")))
                throw new TagException("COMMAND_UNAVAILABLE", action.Key);
        foreach (var source in package.Map("sources"))
        {
            if (source.Value.Text("transport") is not ("sidecar" or "http"))
                throw new TagException("SOURCE_TRANSPORT_UNAVAILABLE", source.Key);
            if (source.Value?["parse"].Text("format") is not ("html" or "xml" or "json" or "text"))
                throw new TagException("SOURCE_FORMAT_UNAVAILABLE", source.Key);
        }
        var regions = new HashSet<string>(Capabilities.List("placementRegions").Select(n => n!.ToString()));
        foreach (var layout in package["ui"].Map("layouts"))
        {
            if (!Surfaces.Contains(layout.Value.Text("surface")))
                throw new TagException("SURFACE_UNAVAILABLE", layout.Key);
            var ids = new HashSet<string>();
            var localRegions = new HashSet<string>();
            int count = 0;
            void Walk(JsonNode? n, int depth, string parent = "")
            {
                if (n is null || depth > 20 || ++count > 1000)
                    throw new TagException("LAYOUT_LIMIT", layout.Key);
                if (!ids.Add(n.Text("id")))
                    throw new TagException("DUPLICATE_NODE", n.Text("id"));
                var nodeType = n.Text("type");
                if (nodeType == "activity-feed" && (layout.Value.Text("surface") != "workspace.sidebar" || depth != 0))
                    throw new TagException("SURFACE_UNAVAILABLE", n.Text("id"));
                if (nodeType is "ribbon" or "ribbon-tab" or "ribbon-group" or "control")
                {
                    if (!Capabilities.List("ribbonSurfaces").Any(s => s?.ToString() == layout.Value.Text("surface")))
                        throw new TagException("RIBBON_STRUCTURE_INVALID", n.Text("id"));
                    if (
                        nodeType == "ribbon-tab" && parent != "ribbon"
                        || nodeType == "ribbon-group" && parent != "ribbon-tab"
                        || nodeType == "control" && parent != "ribbon-group"
                    )
                        throw new TagException("RIBBON_STRUCTURE_INVALID", n.Text("id"));
                    if (nodeType == "control")
                    {
                        var control = Capabilities["$defs"]
                            ?["layoutControl"].List("oneOf")
                            .FirstOrDefault(c => c.Text("const") == n.Text("binding"));
                        if (
                            control is null
                            || !control.List("x-surfaces").Any(s => s?.ToString() == layout.Value.Text("surface"))
                        )
                            throw new TagException("CONTROL_UNAVAILABLE", n.Text("id"));
                    }
                    if (
                        nodeType == "ribbon"
                        && n["binding"] is not null
                        && (
                            layout.Value.Text("surface") != "film.details"
                            || package["ui"]?["identity"]?[n.Text("binding")] is null
                        )
                    )
                        throw new TagException("RIBBON_STRUCTURE_INVALID", n.Text("id"));
                }
                if (
                    CapabilityContract.Registry["surfaceCapabilities"]?[layout.Value.Text("surface")] is { } surfaceCaps
                )
                {
                    if (
                        surfaceCaps["conditions"]?.GetValue<bool>() == false
                        && (n["visibleWhen"] is not null || n["disabledWhen"] is not null)
                    )
                        throw new TagException("LAYOUT_CONDITION_UNAVAILABLE", n.Text("id"));
                    if (!surfaceCaps.List("nodes").Any(v => v?.ToString() == n.Text("type")))
                        throw new TagException("TERM_NODE_UNAVAILABLE", n.Text("id"));
                    if (
                        n.List("actions")
                            .Any(a =>
                                !surfaceCaps
                                    .List("commands")
                                    .Any(cmd =>
                                        cmd?.ToString() == package["ui"]?["actions"]?[a!.ToString()].Text("command")
                                    )
                            )
                    )
                        throw new TagException("ACTION_UNAVAILABLE", n.Text("id"));
                }
                if (
                    layout.Value.Text("surface") == "annotation.row"
                    && n.Text("type")
                        is not ("stack" or "grid" or "section" or "value" or "provenance" or "action-bar" or "menu")
                )
                    throw new TagException("ROW_NODE_UNAVAILABLE", n.Text("id"));
                if (
                    n["itemLayout"] is { } row
                    && package["ui"]?["layouts"]?[row.ToString()].Text("surface") != "annotation.row"
                )
                    throw new TagException("ROW_LAYOUT_UNAVAILABLE", n.Text("id"));
                foreach (
                    var region in n["region"] is JsonArray a ? a
                    : n["region"] is { } x ? new JsonArray(x.Copy())
                    : []
                )
                    if (!localRegions.Add(region!.ToString()))
                        throw new TagException("DUPLICATE_REGION", region.ToString());
                    else
                        regions.Add(region.ToString());
                foreach (var action in n.List("actions"))
                {
                    if (package["ui"]?["actions"]?[action!.ToString()] is null)
                        throw new TagException("ACTION_UNAVAILABLE", action!.ToString());
                    var command = package["ui"]!["actions"]![action!.ToString()].Text("command");
                    if (
                        Capabilities["uiCommandSurfaces"]?[command] is JsonArray allowed
                        && !allowed.Any(s => s?.ToString() == layout.Value.Text("surface"))
                    )
                        throw new TagException("ACTION_UNAVAILABLE", action.ToString());
                }
                foreach (var c in n.List("children"))
                    Walk(c, depth + 1, nodeType);
            }
            Walk(layout.Value?["root"], 0);
        }
        foreach (var binding in package["ui"].Map("surfaceBindings"))
            if (package["ui"]?["layouts"]?[binding.Value!.ToString()] is null)
                throw new TagException("LAYOUT_UNAVAILABLE", binding.Key);
        foreach (var d in defs.Where(d => d.Flag("enabled", true)))
        foreach (var p in d.List("placements"))
            if (!regions.Contains(p.Text("slot")))
                throw new TagException("REGION_UNAVAILABLE", d.Text("key") + "/" + p.Text("slot"));
        CheckText(package, package, "");
        var compiled = new CompiledDefinitions(package);
        compiled.LoadTerms([]);
        foreach (var term in compiled.Terms.Values)
            TagEngine.CheckTerm(compiled, term);
        return compiled;
    }

    private static IEnumerable<string> SchemaErrors(EvaluationResults result)
    {
        if (result.IsValid)
            yield break;
        if (result.Errors is { Count: > 0 })
            foreach (var error in result.Errors)
                yield return result.InstanceLocation + ": " + error.Value;
        if (result.Details is not null)
            foreach (var child in result.Details)
            foreach (var error in SchemaErrors(child))
                yield return error;
    }

    private static void CheckValueSchema(JsonNode node, int depth)
    {
        if (depth > 16)
            throw new TagException("SCHEMA_LIMIT");
        if (node is JsonObject o)
        {
            foreach (var p in o)
            {
                if (p.Key is "$ref" or "$dynamicRef" or "$id")
                    throw new TagException("VALUE_SCHEMA_REFERENCE_FORBIDDEN");
                if (p.Key == "pattern" && p.Value is { } pattern)
                    _ = new Regex(pattern.ToString(), RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(50));
                if (p.Value is not null)
                    CheckValueSchema(p.Value, depth + 1);
            }
        }
        else if (node is JsonArray a)
            foreach (var x in a)
                if (x is not null)
                    CheckValueSchema(x, depth + 1);
    }

    private static readonly HashSet<string> CopyFields =
    [
        "label",
        "title",
        "caption",
        "description",
        "placeholder",
        "helpText",
        "ariaLabel",
        "tooltip",
        "trueLabel",
        "falseLabel",
        "emptyText",
        "suffix",
    ];

    private static void CheckText(JsonNode? node, JsonObject package, string path)
    {
        if (
            path.EndsWith("/schema", StringComparison.Ordinal)
            || path.Contains("/parse/fields/", StringComparison.Ordinal)
        )
            return;
        if (node is JsonObject o)
        {
            if (o["message"] is { } key && package["i18n"]?["messages"]?[key.ToString()] is null)
                throw new TagException("MESSAGE_MISSING", path);
            foreach (var p in o)
            {
                if (CopyFields.Contains(p.Key) && p.Value is JsonValue)
                    throw new TagException("LOCALIZED_TEXT_REQUIRED", path + "/" + p.Key);
                CheckText(p.Value, package, path + "/" + p.Key);
            }
        }
        else if (node is JsonArray a)
            for (int i = 0; i < a.Count; i++)
                CheckText(a[i], package, path + "/" + i);
    }
}
