using System.Text.Json;
using System.Text.Json.Nodes;
using Json.Schema;
using Vroom.Core.Storage;

namespace Vroom.Core.Tagging;

public sealed partial class TagEngine
{
    private static readonly JsonSchema AnnotationSchema = TagSchemas.Get("annotations.schema.json");

    public async Task<JsonObject> ExportAsync(
        string kind,
        bool archive = false,
        CancellationToken ct = default,
        IReadOnlySet<string>? films = null
    )
    {
        bool Included(JsonNode? record) =>
            films is null || record?["subject"].Text("kind") == "film" && films.Contains(record["subject"].Text("id"));
        await InitializeAsync(ct);
        // Exports read one consistent WAL snapshot and never take the write gate.
        return await repository.Database.ReadAsync(
            db =>
            {
                var c = Current(db);
                var definitions = c.Package.DeepClone().AsObject();
                definitions["package"]!["id"] = "vroom.export";
                if (kind == "definitions")
                    return definitions;
                var media = new JsonArray(
                    ReadRows(
                            db,
                            "SELECT payload FROM film_projection",
                            r =>
                            {
                                var f = CatalogRepository.Deserialize<Vroom.Core.Domain.Film>(r.GetString(0));
                                if (films is not null && !films.Contains(f.Id))
                                    return null;
                                return (JsonNode?)
                                    new JsonObject
                                    {
                                        ["id"] = f.Id,
                                        ["path"] = f.Path,
                                        ["size"] = f.Size,
                                        ["modified"] = f.Modified.ToString("O"),
                                        ["mediaRevision"] = MediaRevision(f),
                                        ["structure"] = JsonSerializer.SerializeToNode(
                                            CatalogRepository.ReadResources(db, f.Id),
                                            CatalogRepository.Json
                                        ),
                                    };
                            }
                        )
                        .OfType<JsonNode>()
                        .ToArray()
                );
                var records = archive
                    ? ReadRows(
                            db,
                            "SELECT payload FROM tag_history ORDER BY id,revision",
                            r => JsonNode.Parse(r.GetString(0))!.AsObject()
                        )
                        .Where(Included)
                        .ToList()
                    : Records(db)
                        .Where(Included)
                        .Select(r =>
                        {
                            var (value, issue) = Project(db, c, r);
                            if (value is null && (r.Text("operation") != "clear" || issue is not null))
                                return null;
                            var projected = r.DeepClone().AsObject();
                            projected["value"] = value.Copy();
                            return projected;
                        })
                        .OfType<JsonObject>()
                        .ToList();
                var annotations = new JsonObject
                {
                    ["kind"] = "annotations",
                    ["formatVersion"] = 3,
                    ["generation"] = Generation(db),
                    ["mode"] = archive ? "archive" : "current",
                    ["media"] = media,
                    ["terms"] = new JsonArray(c.Terms.Values.Select(t => t.DeepClone()).ToArray()),
                    ["records"] = new JsonArray(records.Select(r => r.DeepClone()).ToArray()),
                };
                annotations["entityIdentities"] = new JsonArray(
                    ReadRows(
                            db,
                            "SELECT namespace,external_id,term_id FROM tag_entity_identities ORDER BY namespace,external_id",
                            r =>
                                (JsonNode)
                                    new JsonObject
                                    {
                                        ["namespace"] = r.GetString(0),
                                        ["externalId"] = r.GetString(1),
                                        ["termId"] = r.GetString(2),
                                    }
                        )
                        .Where(i => c.Terms.ContainsKey(i.Text("termId")))
                        .ToArray()
                );
                if (archive)
                    annotations["archives"] = new JsonArray(
                        ReadRows(
                                db,
                                "SELECT payload FROM tag_import_archives ORDER BY hash",
                                r => JsonNode.Parse(r.GetString(0))
                            )
                            .ToArray()
                    );
                if (kind == "annotations")
                    return annotations;
                if (kind != "bundle")
                    throw new TagException("EXPORT_KIND_INVALID");
                return new JsonObject
                {
                    ["kind"] = "tag-bundle",
                    ["formatVersion"] = 3,
                    ["definitions"] = definitions,
                    ["annotations"] = annotations,
                };
            },
            ct
        );
    }

    private static JsonArray PackageChanges(JsonObject package)
    {
        var changes = new JsonArray();
        void Add(string kind, string key, JsonNode? value) =>
            changes.Add(
                new JsonObject
                {
                    ["kind"] = kind,
                    ["key"] = key,
                    ["value"] = value.Copy(),
                }
            );
        foreach (var d in package.List("definitions"))
            Add("definition", d.Text("key"), d);
        foreach (var name in new[] { "rules", "sources", "eventBindings", "groups", "vocabularies" })
        foreach (var p in package.Map(name))
            Add(name, p.Key, p.Value);
        if (package["catalogPolicy"] is not null)
            Add("catalogPolicy", "default", package["catalogPolicy"]);
        foreach (var group in package.Map("ui"))
        foreach (var p in group.Value!.AsObject())
            Add("ui." + group.Key, p.Key, p.Value);
        foreach (var p in package["i18n"].Map("messages"))
            Add("message", p.Key, p.Value);
        if (package["i18n"]?["defaultLocale"] is { } defaultLocale)
            Add("i18n", "defaultLocale", defaultLocale);
        return changes;
    }

    public async Task<JsonObject> PreviewImportAsync(JsonObject args, CancellationToken ct = default)
    {
        await InitializeAsync(ct);
        return await repository.Database.RunAsync(
            db =>
            {
                using var tx = db.BeginTransaction();
                var original = args["document"] as JsonObject ?? throw new TagException("IMPORT_DOCUMENT_REQUIRED");
                var document = original.DeepClone().AsObject();
                if (document.Number("formatVersion") != 3)
                    throw new TagException("FORMAT_UNSUPPORTED");
                var contract = document.Text("kind") switch
                {
                    "tag-definitions" => "tag-definitions.schema.json",
                    "annotations" => "annotations.schema.json",
                    "tag-bundle" => "tag-bundle.schema.json",
                    _ => throw new TagException("IMPORT_KIND_INVALID"),
                };
                if (!TagSchemas.Get(contract).Evaluate(document).IsValid)
                    throw new TagException("IMPORT_SCHEMA_INVALID");
                var kind = document.Text("kind");
                if (kind is not ("tag-definitions" or "annotations" or "tag-bundle"))
                    throw new TagException("IMPORT_KIND_INVALID");
                var definitions = kind == "tag-definitions" ? document : document["definitions"] as JsonObject;
                var annotations = kind == "annotations" ? document : document["annotations"] as JsonObject;
                var changes = definitions is null ? new JsonArray() : PackageChanges(definitions);
                var compiled = definitions is null
                    ? Compile(db, Current(db).Package)
                    : Compile(db, Merge(db, TagResources.Json("core.tagdefs.json"), changes.OfType<JsonObject>()));
                if (annotations is not null && !AnnotationSchema.Evaluate(annotations).IsValid)
                    throw new TagException("ANNOTATIONS_SCHEMA_INVALID");
                var termRevisions = new JsonObject();
                var importedTerms = annotations?.List("terms").OfType<JsonObject>().ToArray() ?? [];
                foreach (var term in importedTerms)
                {
                    if (!TermSchema.Evaluate(term).IsValid)
                        throw new TagException("TERM_SCHEMA_INVALID", term.Text("id"));
                    termRevisions[term.Text("id")] =
                        compiled.Terms.GetValueOrDefault(term.Text("id"))?.Number("revision") ?? 0;
                }
                var termLayer = ReadRows(
                    db,
                    "SELECT payload FROM tag_terms",
                    r => JsonNode.Parse(r.GetString(0))!.AsObject()
                );
                var policy = args.Text("conflictPolicy", "keep-local");
                var acceptedTerms = importedTerms
                    .Where(t => policy == "replace" || !compiled.Terms.ContainsKey(t.Text("id")))
                    .ToArray();
                compiled.LoadTerms(termLayer.Concat(acceptedTerms));
                var identities = annotations?.List("entityIdentities") ?? new JsonArray();
                var identityKeys = new HashSet<string>();
                foreach (var identity in identities)
                {
                    if (!compiled.Terms.ContainsKey(identity.Text("termId")))
                        throw new TagException("SUBJECT_UNRESOLVED", identity.Text("termId"));
                    if (
                        !identityKeys.Add(
                            TagJson.Canonical(
                                new JsonArray(identity?["namespace"].Copy(), identity?["externalId"].Copy())
                            )
                        )
                    )
                        throw new TagException("ENTITY_IDENTITY_CONFLICT");
                    var existingIdentity =
                        db.Scalar(
                            "SELECT term_id FROM tag_entity_identities WHERE namespace=@namespace AND external_id=@external",
                            ("@namespace", identity.Text("namespace")),
                            ("@external", identity.Text("externalId"))
                        ) as string;
                    if (existingIdentity is not null && existingIdentity != identity.Text("termId"))
                        throw new TagException("ENTITY_IDENTITY_CONFLICT", identity.Text("termId"));
                }
                var unresolved = new JsonArray();
                var mappings = args.Map("mediaMappings");
                foreach (var media in annotations?.List("media") ?? [])
                {
                    var oldId = media.Text("id");
                    if (mappings[oldId] is not null)
                    {
                        CatalogRepository.RequireFilm(db, mappings[oldId]!.ToString());
                        continue;
                    }
                    var match = db.Scalar("SELECT payload FROM film_projection WHERE id=@id", ("@id", oldId)) as string;
                    if (match is not null)
                    {
                        var f = CatalogRepository.Deserialize<Vroom.Core.Domain.Film>(match);
                        if (
                            CatalogRepository.PathComparer.Equals(f.Path, media.Text("path"))
                            && f.Size == media.Number("size")
                            && f.Modified.ToString("O") == media.Text("modified")
                        )
                        {
                            mappings[oldId] = oldId;
                            continue;
                        }
                    }
                    unresolved.Add(media.Copy());
                }
                foreach (var record in annotations?.List("records").OfType<JsonObject>() ?? [])
                    if (
                        record["subject"].Text("kind") == "film"
                        && mappings[record["subject"].Text("id")] is null
                        && !unresolved.Any(m => m.Text("id") == record["subject"].Text("id"))
                    )
                        unresolved.Add(new JsonObject { ["id"] = record["subject"].Text("id") });
                var revisions = new JsonObject();
                var partBindings = new JsonObject();
                foreach (var record in annotations?.List("records").OfType<JsonObject>() ?? [])
                {
                    if (
                        record["subject"].Text("kind") != "film"
                        || record["scope"].Text("kind") == "whole"
                        || record["scope"]?["partId"] is null
                    )
                        continue;
                    var originalPart = record["scope"].Text("partId");
                    if (partBindings.ContainsKey(originalPart))
                        continue;
                    var oldWork = record["subject"].Text("id");
                    if (mappings[oldWork] is not { } mappedWork)
                        continue;
                    var targetWork = mappedWork.ToString();
                    var explicitPart = args["partMappings"]?[originalPart]?.ToString();
                    var targetPart = explicitPart ?? originalPart;
                    Vroom.Core.Domain.Film? mediaPart = null;
                    try
                    {
                        mediaPart = CatalogRepository.RequirePart(db, targetWork, targetPart);
                    }
                    catch (KeyNotFoundException) { }
                    if (mediaPart is null && explicitPart is null)
                    {
                        var originalFile = annotations
                            ?.List("media")
                            .FirstOrDefault(m => m.Text("id") == oldWork)
                            ?["structure"].List("versions")
                            .SelectMany(v => v.List("parts"))
                            .FirstOrDefault(p => p.Text("id") == originalPart)
                            ?["file"];
                        if (originalFile is not null)
                        {
                            var matches = ReadRows(
                                    db,
                                    "SELECT payload FROM media_part_projection WHERE id=@id AND path_key=@path",
                                    r => CatalogRepository.Deserialize<Vroom.Core.Domain.Film>(r.GetString(0)),
                                    ("@id", targetWork),
                                    (
                                        "@path",
                                        OperatingSystem.IsWindows()
                                            ? originalFile.Text("path").ToUpperInvariant()
                                            : originalFile.Text("path")
                                    )
                                )
                                .Where(f =>
                                    f.Size == originalFile.Number("size")
                                    && f.Modified.ToString("O") == originalFile.Text("modified")
                                )
                                .ToArray();
                            if (matches.Length == 1)
                                mediaPart = matches[0];
                        }
                    }
                    if (mediaPart is null)
                    {
                        unresolved.Add(
                            new JsonObject
                            {
                                ["kind"] = "part",
                                ["id"] = originalPart,
                                ["filmId"] = oldWork,
                            }
                        );
                        continue;
                    }
                    partBindings[originalPart] = new JsonObject
                    {
                        ["filmId"] = targetWork,
                        ["partId"] = mediaPart.PartId,
                        ["mediaRevision"] = MediaRevision(mediaPart),
                    };
                }
                long invalid = 0,
                    conflicts = 0;
                foreach (var record in annotations?.List("records").OfType<JsonObject>() ?? [])
                {
                    if (compiled.Project(record).Issue is not null)
                        invalid++;
                    var subject = record["subject"]!.DeepClone();
                    if (subject.Text("kind") == "film" && mappings[subject.Text("id")] is { } mapped)
                        subject["id"] = mapped.Copy();
                    var head = Head(db, subject, record["scope"]!, record.Text("tagKey"));
                    revisions[TagJson.Canonical(subject) + ScopeId(record["scope"]!) + record.Text("tagKey")] =
                        head?.Number("revision") ?? 0;
                    if (head is not null && !JsonNode.DeepEquals(head["value"], record["value"]))
                        conflicts++;
                }
                var token = Guid.NewGuid().ToString("N");
                var payload = new JsonObject
                {
                    ["changes"] = changes,
                    ["terms"] = new JsonArray(acceptedTerms.Select(t => t.DeepClone()).ToArray()),
                    ["termRevisions"] = termRevisions,
                    ["original"] = original.DeepClone(),
                    ["annotations"] = annotations.Copy(),
                    ["mappings"] = mappings.Copy(),
                    ["partBindings"] = partBindings,
                    ["conflictPolicy"] = args.Text("conflictPolicy", "keep-local"),
                    ["unresolved"] = unresolved.Copy(),
                    ["revisions"] = revisions,
                };
                if (payload.Text("conflictPolicy") is not ("keep-local" or "replace"))
                    throw new TagException("CONFLICT_POLICY_INVALID");
                db.Execute(
                    "INSERT INTO tag_previews VALUES(@id,'exchange',@g,@p,NULL,@t)",
                    ("@id", token),
                    ("@g", Generation(db)),
                    ("@p", payload.ToJsonString()),
                    ("@t", Now)
                );
                if (unresolved.Count == 0)
                    ValidateImportGraph(db, compiled, payload);
                tx.Commit();
                return new JsonObject
                {
                    ["previewToken"] = token,
                    ["generation"] = Generation(db),
                    ["terms"] = acceptedTerms.Length,
                    ["definitionChanges"] = changes.Count,
                    ["records"] = annotations?.List("records").Count ?? 0,
                    ["invalidCount"] = invalid,
                    ["conflicts"] = conflicts,
                    ["unresolved"] = unresolved,
                    ["canCommit"] = unresolved.Count == 0,
                };
            },
            ct
        );
    }

    public async Task<JsonObject> CommitImportAsync(JsonObject args, CancellationToken ct = default)
    {
        await InitializeAsync(ct);
        var result = await repository.Database.RunAsync(
            db =>
            {
                using var tx = db.BeginTransaction();
                var (p, gen, existing) = Preview(db, args.Text("previewToken"), "exchange");
                if (existing is not null)
                    return JsonNode.Parse(existing)!.AsObject();
                if (gen != Generation(db))
                    throw new TagException("STALE_GENERATION");
                if (p.List("unresolved").Count > 0)
                    throw new TagException("SUBJECT_UNRESOLVED");
                var changes = p.List("changes").OfType<JsonObject>().ToArray();
                var c = Compile(db, Merge(db, TagResources.Json("core.tagdefs.json"), changes));
                foreach (var term in p.List("terms").OfType<JsonObject>())
                {
                    var id = term.Text("id");
                    if ((c.Terms.GetValueOrDefault(id)?.Number("revision") ?? 0) != p["termRevisions"].Number(id))
                        throw new TagException("TERM_REVISION_CONFLICT", id);
                    var nextTerm = term.DeepClone().AsObject();
                    nextTerm["revision"] = p["termRevisions"].Number(id) + 1;
                    StoreTerm(db, nextTerm);
                }
                c = BindTerms(db, c);
                foreach (var change in changes)
                    StoreObject(db, change);
                foreach (var identity in p["annotations"].List("entityIdentities"))
                {
                    var existingIdentity =
                        db.Scalar(
                            "SELECT term_id FROM tag_entity_identities WHERE namespace=@namespace AND external_id=@external",
                            ("@namespace", identity.Text("namespace")),
                            ("@external", identity.Text("externalId"))
                        ) as string;
                    if (existingIdentity is not null && existingIdentity != identity.Text("termId"))
                        throw new TagException("ENTITY_IDENTITY_CONFLICT", identity.Text("termId"));
                    db.Execute(
                        "INSERT OR IGNORE INTO tag_entity_identities VALUES(@namespace,@external,@term)",
                        ("@namespace", identity.Text("namespace")),
                        ("@external", identity.Text("externalId")),
                        ("@term", identity.Text("termId"))
                    );
                }
                var next = changes.Length > 0 ? gen + 1 : gen;
                if (changes.Length > 0)
                {
                    db.Execute(
                        "UPDATE tag_state SET generation=@g,package=@p WHERE id=1",
                        ("@g", next),
                        ("@p", c.Package.ToJsonString())
                    );
                    db.Execute(
                        "INSERT INTO tag_generations VALUES(@g,@p,@t)",
                        ("@g", next),
                        ("@p", c.Package.ToJsonString()),
                        ("@t", Now)
                    );
                }
                long imported = 0,
                    skipped = 0;
                db.Execute(
                    "INSERT OR IGNORE INTO tag_import_archives VALUES(@h,@p)",
                    ("@h", TagJson.Hash(p["original"])),
                    ("@p", p["original"]!.ToJsonString())
                );
                if (p["annotations"] is JsonObject archived)
                {
                    var archive = archived.DeepClone().AsObject();
                    archive.Remove("archives");
                    foreach (
                        var sourceArchive in new[] { (JsonNode)archive }.Concat(
                            archived.List("archives").OfType<JsonNode>()
                        )
                    )
                        db.Execute(
                            "INSERT OR IGNORE INTO tag_import_archives VALUES(@h,@p)",
                            ("@h", TagJson.Hash(sourceArchive)),
                            ("@p", sourceArchive.ToJsonString())
                        );
                }
                var incoming = p["annotations"]
                    .List("records")
                    .OfType<JsonObject>()
                    .GroupBy(r => TagJson.Canonical(r["subject"]) + ScopeId(r["scope"]!) + r.Text("tagKey"))
                    .Select(g => g.MaxBy(r => r.Number("revision"))!);
                foreach (var source in incoming)
                {
                    ct.ThrowIfCancellationRequested();
                    var r = source.DeepClone().AsObject();
                    var subject = r["subject"]!;
                    if (subject.Text("kind") == "film")
                        subject["id"] =
                            p["mappings"]![subject.Text("id")].Copy() ?? throw new TagException("SUBJECT_UNRESOLVED");
                    var head = Head(db, subject, r["scope"]!, r.Text("tagKey"));
                    var binding = TagJson.Canonical(subject) + ScopeId(r["scope"]!) + r.Text("tagKey");
                    if ((head?.Number("revision") ?? 0) != p["revisions"].Number(binding))
                        throw new TagException("VALUE_REVISION_CONFLICT", r.Text("tagKey"));
                    if (subject.Text("kind") == "film" && r["scope"].Text("kind") != "whole")
                    {
                        var scope = r["scope"]!.AsObject();
                        if (scope["partId"] is not null)
                        {
                            var part =
                                p["partBindings"]?[scope.Text("partId")]
                                ?? throw new TagException("SUBJECT_UNRESOLVED");
                            if (part.Text("filmId") != subject.Text("id"))
                                throw new TagException("SUBJECT_UNRESOLVED");
                            scope["partId"] = part["partId"].Copy();
                            scope["mediaRevision"] = part["mediaRevision"].Copy();
                        }
                        else
                            scope.Remove("mediaRevision");
                        ValidateScope(db, c, subject, scope);
                    }
                    if (
                        head is not null
                        && (
                            p.Text("conflictPolicy") == "keep-local"
                            || JsonNode.DeepEquals(head["value"], r["value"])
                                && head.Text("operation") == r.Text("operation")
                        )
                    )
                    {
                        skipped++;
                        continue;
                    }
                    var identityHash = TagJson.Hash(source);
                    var key = "import:" + identityHash + ":" + subject.Text("id");
                    if (db.Scalar("SELECT result FROM tag_idempotency WHERE key=@k", ("@k", key)) is not null)
                    {
                        skipped++;
                        continue;
                    }
                    r["id"] = head?.Text("id") ?? Guid.NewGuid().ToString("N");
                    r["revision"] = (head?.Number("revision") ?? 0) + 1;
                    r["origin"]!["importIdentity"] = identityHash;
                    SaveRecord(db, c, r);
                    db.Execute("INSERT INTO tag_idempotency VALUES(@k,@h,'{}')", ("@k", key), ("@h", identityHash));
                    imported++;
                }
                Reproject(db, c, ct);
                ValidateTermGraph(db);
                var output = new JsonObject
                {
                    ["generation"] = next,
                    ["imported"] = imported,
                    ["skipped"] = skipped,
                    ["issueCount"] = Convert.ToInt64(db.Scalar("SELECT COUNT(*) FROM tag_issues")),
                };
                db.Execute(
                    "UPDATE tag_previews SET result=@r WHERE id=@id",
                    ("@r", output.ToJsonString()),
                    ("@id", args.Text("previewToken"))
                );
                Emit(db, "exchange.committed", output.DeepClone().AsObject());
                Audit(db, "exchange.commit", output.DeepClone().AsObject());
                tx.Commit();
                return output;
            },
            ct
        );
        try
        {
            await PersistUserFilesAsync(ct);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            await repository.AuditAsync("config.mirror-pending", e.Message, CancellationToken.None);
            result["mirrorPending"] = true;
        }
        return result;
    }

    private static void ValidateImportGraph(
        Microsoft.Data.Sqlite.SqliteConnection db,
        CompiledDefinitions c,
        JsonObject p
    )
    {
        db.Execute("SAVEPOINT import_graph");
        try
        {
            foreach (
                var source in p["annotations"]
                    .List("records")
                    .OfType<JsonObject>()
                    .GroupBy(r => TagJson.Canonical(r["subject"]) + ScopeId(r["scope"]!) + r.Text("tagKey"))
                    .Select(g => g.MaxBy(r => r.Number("revision"))!)
            )
            {
                var r = source.DeepClone().AsObject();
                var subject = r["subject"]!;
                if (subject.Text("kind") == "film")
                    subject["id"] = p["mappings"]![subject.Text("id")].Copy();
                var head = Head(db, subject, r["scope"]!, r.Text("tagKey"));
                if (head is not null && p.Text("conflictPolicy") == "keep-local")
                    continue;
                r["id"] = head?.Text("id") ?? Guid.NewGuid().ToString("N");
                r["revision"] = (head?.Number("revision") ?? 0) + 1;
                SaveRecord(db, c, r);
            }
            Reproject(db, c);
            ValidateTermGraph(db);
        }
        finally
        {
            db.Execute("ROLLBACK TO import_graph; RELEASE import_graph;");
        }
    }

    public async Task<object> FindDuplicatesAsync(JsonObject args, CancellationToken ct = default)
    {
        await InitializeAsync(ct);
        return await repository.Database.RunAsync(
            db =>
            {
                var c = Current(db);
                var policy = c.Package["catalogPolicy"]?["dedup"];
                var keys =
                    args.List("keys").Count > 0
                        ? args.List("keys").Select(x => x!.ToString()).ToArray()
                        : policy.List("keys").Select(x => x.Text("tag")).ToArray();
                if (keys.Length == 0)
                    throw new TagException("DEDUP_KEYS_REQUIRED");
                foreach (var k in keys)
                    if (!c.Require(k)["query"].Flag("deduplicate", true))
                        throw new TagException("DEDUP_FIELD_DISABLED", k);
                var (where, q) = CompileQuery(c, args);
                var films = ReadRows(
                    db,
                    $"SELECT f.payload FROM film_projection f WHERE {where}",
                    r => CatalogRepository.Deserialize<Vroom.Core.Domain.Film>(r.GetString(0)),
                    [.. q.Parameters]
                );
                var groups = new Dictionary<string, List<JsonObject>>();
                foreach (var film in films)
                {
                    ct.ThrowIfCancellationRequested();
                    var view = FilmView(db, c, film);
                    var values = view["values"]!;
                    if (keys.Any(k => values[k]?["value"] is null))
                        continue;
                    var parts = new JsonArray(
                        keys.Order()
                            .Select(k =>
                                values[k]!["value"] is JsonArray a
                                    ? (JsonNode?)
                                        new JsonArray(a.Select(x => x.Copy()).OrderBy(TagJson.Canonical).ToArray())
                                    : values[k]!["value"].Copy()
                            )
                            .ToArray()
                    );
                    var key = TagJson.Hash(parts);
                    if (!groups.TryGetValue(key, out var list))
                        groups[key] = list = [];
                    list.Add(view);
                }
                var order = c.Package["catalogPolicy"]?["dedup"].List("preferredOrder") ?? [];
                int Compare(JsonObject a, JsonObject b)
                {
                    foreach (var criterion in order)
                    {
                        var av = a["values"]?[criterion.Text("tag")]?["value"];
                        var bv = b["values"]?[criterion.Text("tag")]?["value"];
                        if (av is null || bv is null)
                        {
                            if (av is null && bv is not null)
                                return 1;
                            if (bv is null && av is not null)
                                return -1;
                            continue;
                        }
                        var comparison =
                            av is JsonValue an
                            && bv is JsonValue bn
                            && an.GetValueKind() == JsonValueKind.Number
                            && bn.GetValueKind() == JsonValueKind.Number
                                ? JsonSerializer
                                    .Deserialize<double>(av.ToJsonString())
                                    .CompareTo(JsonSerializer.Deserialize<double>(bv.ToJsonString()))
                                : StringComparer.OrdinalIgnoreCase.Compare(av.ToString(), bv.ToString());
                        if (comparison != 0)
                            return criterion.Text("direction", "desc") == "desc" ? -comparison : comparison;
                    }
                    return StringComparer.Ordinal.Compare(a.Text("id"), b.Text("id"));
                }
                foreach (var group in groups.Values)
                    group.Sort(Compare);
                return groups.Where(p => p.Value.Count > 1).Select(p => new { key = p.Key, films = p.Value }).ToArray();
            },
            ct
        );
    }

    /// <summary>
    /// Resolves a duplicate set. Films not kept receive the configured exclusion value. Keeping several
    /// films merges them into the first kept film as additional versions (the media structure is the one
    /// model for "the same work in several files"); merged records are then archived and removed.
    /// </summary>
    public async Task<object> ResolveDuplicatesAsync(JsonObject args, CancellationToken ct = default)
    {
        await InitializeAsync(ct);
        var (primary, merged) = await repository.Database.RunAsync(
            db =>
            {
                using var tx = db.BeginTransaction();
                var c = Current(db);
                if (args.Number("expectedGeneration") != Generation(db))
                    throw new TagException("STALE_GENERATION");
                var ids = args.List("candidateIds").Select(n => n!.ToString()).Distinct().ToArray();
                var keep = args.List("keepIds").Select(n => n!.ToString()).Distinct().ToArray();
                if (ids.Length < 2 || keep.Length == 0 || keep.Except(ids).Any())
                    throw new TagException("DEDUP_SELECTION_INVALID");
                var primary = keep[0];
                var merged = keep.Skip(1).ToArray();
                foreach (var id in ids.Where(id => !merged.Contains(id)))
                {
                    CatalogRepository.RequireFilm(db, id);
                    var kept = keep.Contains(id);
                    var change =
                        c.Package["catalogPolicy"]?["dedup"]?[kept ? "keptValue" : "excludedValue"]
                        ?? throw new TagException("DEDUP_ACTION_UNAVAILABLE");
                    Write(
                        db,
                        c,
                        new JsonObject
                        {
                            ["subject"] = new JsonObject { ["kind"] = "film", ["id"] = id },
                            ["scope"] = new JsonObject { ["kind"] = "whole" },
                            ["tagKey"] = change.Text("tag"),
                            ["value"] = change["value"].Copy(),
                            ["expectedRevision"] = args["expectedRevisions"]?[id].Copy(),
                        },
                        "manual"
                    );
                }
                foreach (var id in merged)
                {
                    CatalogRepository.RequireFilm(db, id);
                    var next = Convert.ToInt64(
                        db.Scalar(
                            "SELECT COALESCE(MAX(ordinal),-1)+1 FROM media_versions WHERE film_id=@film",
                            ("@film", primary)
                        )
                    );
                    foreach (
                        var version in ReadRows(
                            db,
                            "SELECT id FROM media_versions WHERE film_id=@id ORDER BY ordinal",
                            r => r.GetString(0),
                            ("@id", id)
                        )
                    )
                        db.Execute(
                            "UPDATE media_versions SET film_id=@film,ordinal=@ordinal WHERE id=@id",
                            ("@film", primary),
                            ("@ordinal", next++),
                            ("@id", version)
                        );
                    db.Execute(
                        "UPDATE resource_sets SET film_id=@film WHERE film_id=@id",
                        ("@film", primary),
                        ("@id", id)
                    );
                }
                if (merged.Length > 0)
                    db.Execute("UPDATE films SET revision=revision+1 WHERE id=@id", ("@id", primary));
                Audit(
                    db,
                    "duplicates.resolve",
                    new JsonObject
                    {
                        ["candidateIds"] = args["candidateIds"].Copy(),
                        ["keepIds"] = args["keepIds"].Copy(),
                    }
                );
                tx.Commit();
                return (primary, merged);
            },
            ct
        );
        // Merged records now have no media of their own; archive their annotations and remove them.
        var removal = merged.Length > 0 ? await RemoveFilmsAsync(merged, ct) : null;
        return new
        {
            primaryId = primary,
            merged,
            archive = removal?["archive"]?.GetValue<string>(),
        };
    }
}
