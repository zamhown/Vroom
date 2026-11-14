using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;
using Vroom.Core.Storage;

namespace Vroom.Core.Tagging;

public sealed partial class TagEngine
{
    internal static JsonArray MapSourceEntities(JsonObject mapping, JsonNode raw, JsonObject values, JsonObject facts)
    {
        var entries = new JsonArray();
        foreach (var item in raw as JsonArray ?? new JsonArray(raw.Copy()))
        {
            var context = facts.DeepClone().AsObject();
            context["source"] = new JsonObject { ["value"] = item.Copy() };
            var identity = Evaluate(mapping["identity"], values, context)?.ToString();
            var label = Evaluate(mapping["label"], values, context)?.ToString();
            if (
                string.IsNullOrWhiteSpace(identity)
                || identity.Length > 2000
                || string.IsNullOrWhiteSpace(label)
                || label.Length > 150
            )
                throw new TagException("SOURCE_ENTITY_INVALID");
            var annotations = new JsonObject();
            foreach (var field in mapping.Map("annotations"))
                if (Evaluate(field.Value, values, context) is { } value)
                    annotations[field.Key] = value;
            entries.Add(
                new JsonObject
                {
                    ["identity"] = identity,
                    ["label"] = label,
                    ["annotations"] = annotations,
                }
            );
        }
        if (
            entries.Count > 100
            || entries.GroupBy(e => e.Text("identity")).Any(g => g.Select(TagJson.Canonical).Distinct().Count() > 1)
        )
            throw new TagException("SOURCE_ENTITY_INVALID");
        return new(entries.DistinctBy(e => e.Text("identity")).Select(e => e.Copy()).ToArray());
    }

    private (CompiledDefinitions Definitions, JsonNode Value) AcceptEntities(
        SqliteConnection db,
        CompiledDefinitions c,
        JsonObject field,
        JsonObject candidate,
        JsonObject mapping
    )
    {
        // A changed mapping must be reviewed again; it cannot silently change the
        // identity namespace or fields being created by an older preview.
        if (
            !field
                .List("enrichment")
                .Any(r => r.Text("source") == candidate.Text("source") && JsonNode.DeepEquals(r?["entities"], mapping))
        )
            throw new TagException("STALE_SOURCE_RESULT");
        var refs = new JsonArray();
        var vocabulary = ValueContracts.Vocabulary(field);
        foreach (var item in candidate.List("value"))
        {
            var external = item.Text("identity");
            var key =
                db.Scalar(
                    "SELECT term_id FROM tag_entity_identities WHERE namespace=@ns AND external_id=@id",
                    ("@ns", mapping.Text("namespace")),
                    ("@id", external)
                ) as string;
            if (key is null)
            {
                c = CreateOption(db, c, field, item.Text("label"), out key);
                db.Execute(
                    "INSERT INTO tag_entity_identities VALUES(@ns,@id,@term)",
                    ("@ns", mapping.Text("namespace")),
                    ("@id", external),
                    ("@term", key)
                );
            }
            else if (!c.InVocabulary(c.RequireTerm(key), vocabulary))
                throw new TagException("TERM_VOCABULARY_MISMATCH");
            var subject = new JsonObject { ["kind"] = "term", ["id"] = key };
            foreach (var annotation in item.Map("annotations"))
            {
                var target = c.Require(annotation.Key);
                if (c.SubjectIssue(target, subject) is { } issue)
                    throw new TagException(issue);
                if (!AnnotationTargets.Supports(target, "term", "whole") || !c.Accepts(target, annotation.Value))
                    throw new TagException("VALUE_OUT_OF_DOMAIN");
                AutomaticValue(
                    db,
                    c,
                    target,
                    subject,
                    annotation.Value!,
                    "metadata",
                    "if-unset",
                    candidate.Text("source"),
                    TagJson.Hash(mapping),
                    candidate["evidence"] as JsonArray
                );
            }
            refs.Add(new JsonObject { ["term"] = key });
        }
        return (c, field["value"].Text("cardinality") == "many" ? refs : refs.First()!.DeepClone());
    }
}
