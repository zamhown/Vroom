using System.Text.Json.Nodes;
using Vroom.Core.Storage;

namespace Vroom.Core.Tagging;

internal sealed record SourceObservation(
    JsonObject Definition,
    JsonNode Rule,
    JsonNode Value,
    string SourceId,
    string EvidenceGroup,
    string Location,
    DateTimeOffset ObservedAt
);

public sealed partial class TagEngine
{
    private static JsonNode NormalizeEvidence(JsonObject field, JsonNode value) =>
        field["value"].Text("cardinality") == "many" && value is JsonArray items
            ? new JsonArray(
                items
                    .Select(v => v.Copy())
                    .DistinctBy(TagJson.Canonical)
                    .OrderBy(TagJson.Canonical, StringComparer.Ordinal)
                    .ToArray()
            )
            : value.DeepClone();

    internal Task ApplySourceObservationsAsync(
        SourceSnapshot snapshot,
        IReadOnlyList<SourceObservation> observations,
        CancellationToken ct,
        JsonObject? batch = null,
        EnrichmentResult? result = null
    ) =>
        repository.Database.RunAsync(
            db =>
            {
                if (observations.Count == 0 && batch is null)
                    return;
                using var tx = db.BeginTransaction();
                var current = Current(db);
                var subject = snapshot.Subject;
                var id = subject.Text("id");
                var kind = subject.Text("kind");
                var revision = snapshot.Film is { } film ? MediaRevision(film) : "term:" + snapshot.SubjectRevision;
                if (
                    Generation(db) != snapshot.Generation
                    || kind == "term" && current.RequireTerm(id).Number("revision") != snapshot.SubjectRevision
                    || snapshot.Film is { } before
                        && MediaRevision(
                            before.PartId is { } part
                                ? CatalogRepository.RequirePart(db, id, part)
                                : CatalogRepository.RequireFilm(db, id)
                        ) != revision
                    || TagJson.Hash(Values(db, current, kind, id)) != TagJson.Hash(snapshot.Values)
                )
                    throw new TagException("STALE_SOURCE_RESULT");
                foreach (var group in observations.GroupBy(o => o.Definition.Text("key")))
                {
                    ct.ThrowIfCancellationRequested();
                    var d = current.Require(group.Key);
                    var evidence = new JsonArray(
                        group
                            .Select(o =>
                                (JsonNode?)
                                    new JsonObject
                                    {
                                        ["source"] = o.SourceId,
                                        ["group"] = o.EvidenceGroup,
                                        ["location"] = o.Location,
                                        ["observedAt"] = o.ObservedAt.ToString("O"),
                                        ["value"] = NormalizeEvidence(d, o.Value),
                                    }
                            )
                            .ToArray()
                    );
                    var minimum = (int)d["enrichmentPolicy"].Number("minIndependentSources", 1);
                    var values = group.GroupBy(o => TagJson.Canonical(NormalizeEvidence(d, o.Value))).ToArray();
                    var conflict = values.Length > 1;
                    foreach (var agreement in values)
                    {
                        var first = agreement.First();
                        var value = NormalizeEvidence(d, first.Value);
                        var count = agreement.Select(o => o.EvidenceGroup).Distinct(StringComparer.Ordinal).Count();
                        var create =
                            d["writes"]?["createTerms"] is not null
                            && (value is JsonArray a ? a.All(x => x is JsonValue) : value is JsonValue);
                        var rejected =
                            db.Scalar(
                                "SELECT 1 FROM tag_candidates WHERE subject_id=@id AND tag_key=@key AND state='rejected' AND json_extract(payload,'$.subjectKind')=@kind AND json_extract(payload,'$.value')=json_extract(@value,'$')",
                                ("@id", id),
                                ("@key", group.Key),
                                ("@kind", kind),
                                ("@value", value.ToJsonString())
                            )
                            is not null;
                        if (rejected)
                            continue;
                        if (
                            create
                            || conflict
                            || count < minimum
                            || first.Rule.Text("apply") == "suggest-only"
                            || !current.Accepts(d, value)
                        )
                            Candidate(
                                db,
                                id,
                                d.Text("key"),
                                value,
                                "metadata",
                                first.SourceId,
                                revision,
                                create,
                                kind,
                                snapshot.SubjectRevision,
                                evidence,
                                snapshot.Film?.PartId,
                                first.Rule["entities"] as JsonObject
                            );
                        else
                            AutomaticValue(
                                db,
                                current,
                                d,
                                subject,
                                value,
                                "metadata",
                                first.Rule.Text("apply", "if-unset"),
                                first.SourceId,
                                evidence: evidence
                            );
                    }
                    var observation = new JsonObject
                    {
                        ["subject"] = subject.Copy(),
                        ["tagKey"] = group.Key,
                        ["evidence"] = evidence.Copy(),
                        ["conflict"] = conflict,
                        ["mediaRevision"] = revision,
                    };
                    var hash = TagJson.Hash(observation);
                    db.Execute(
                        "INSERT OR IGNORE INTO tag_source_observations VALUES(@id,@kind,@subject,@key,@payload)",
                        ("@id", hash),
                        ("@kind", kind),
                        ("@subject", id),
                        ("@key", group.Key),
                        ("@payload", observation.ToJsonString())
                    );
                }
                ValidateTermGraph(db);
                if (batch is not null)
                    CompleteEnrichmentItem(db, batch, "completed", null, result);
                Emit(
                    db,
                    "source.result-ready",
                    new()
                    {
                        ["subject"] = subject.Copy(),
                        ["sources"] = new JsonArray(
                            observations
                                .Select(o => o.SourceId)
                                .Distinct()
                                .Select(x => (JsonNode?)JsonValue.Create(x))
                                .ToArray()
                        ),
                    }
                );
                tx.Commit();
            },
            ct
        );
}
