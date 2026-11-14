using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;
using Vroom.Core.Storage;

namespace Vroom.Core.Tagging;

public sealed partial class TagEngine
{
    internal static JsonObject Facts(Vroom.Core.Domain.Film film) =>
        new()
        {
            ["catalog"] = new JsonObject { ["libraryId"] = film.LibraryId },
            ["file"] = new JsonObject
            {
                ["path"] = film.Path,
                ["baseName"] = Path.GetFileNameWithoutExtension(film.Path),
                ["relativePath"] = film.RelativePath ?? Path.GetFileName(film.Path),
                ["size"] = film.Size,
                ["added"] = film.Added.ToString("O"),
                ["modified"] = film.Modified.ToString("O"),
            },
            ["probe"] = new JsonObject
            {
                ["state"] = film.ProbeState,
                ["duration"] = film.Duration > 0 ? JsonValue.Create(film.Duration) : null,
                ["video"] = new JsonObject
                {
                    ["width"] = film.Width > 0 ? JsonValue.Create(film.Width) : null,
                    ["height"] = film.Height > 0 ? JsonValue.Create(film.Height) : null,
                    ["frameRate"] = film.FrameRate > 0 ? JsonValue.Create(film.FrameRate) : null,
                    ["codec"] = film.VideoCodec,
                },
                ["audio"] = new JsonObject { ["codec"] = film.AudioCodec },
            },
            ["playback"] = new JsonObject { ["position"] = film.Position },
        };

    internal static JsonNode? Evaluate(JsonNode? expression, JsonObject values, JsonObject facts) =>
        RuleExpression.Evaluate(expression, values, facts);

    internal JsonObject FilmView(
        SqliteConnection db,
        CompiledDefinitions c,
        Vroom.Core.Domain.Film f,
        JsonObject? projected = null
    )
    {
        var values = projected ?? Values(db, c, "film", f.Id);
        var facts = Facts(f);
        var identity = c.Package["ui"].Map("identity").FirstOrDefault().Value;
        var naming = c.Package["ui"].Map("naming").FirstOrDefault().Value;
        var image = Evaluate(identity?["primaryImage"], values, facts);
        var presentation = new JsonObject
        {
            ["title"] =
                Evaluate(identity?["title"], values, facts)
                ?? JsonValue.Create(Path.GetFileNameWithoutExtension(f.Path)),
            ["tabTitle"] =
                Evaluate(identity?["tabTitle"], values, facts)
                ?? JsonValue.Create(Path.GetFileNameWithoutExtension(f.Path)),
            ["image"] = image,
            ["snapshotName"] = Evaluate(naming?["base"], values, facts) ?? JsonValue.Create("frame"),
        };
        // Probed films without a configured image get a representative frame as their cover.
        if (image is null && f.Duration > 0 && f.MissingSince is null)
            presentation["frameAt"] = Math.Round(f.Duration * 0.2, 1);
        if (image is not null)
        {
            var context = facts;
            if (AssetImageSize(image) is { } size)
            {
                presentation["imageSize"] = new JsonObject { ["width"] = size.Width, ["height"] = size.Height };
                context = facts.DeepClone().AsObject();
                context["image"] = new JsonObject
                {
                    ["width"] = size.Width,
                    ["height"] = size.Height,
                    ["aspectRatio"] = Math.Round(size.AspectRatio, 4),
                };
            }
            if (identity?["primaryImagePresentation"] is { } rule)
                presentation["imagePresentation"] = CapabilityContract.ImagePresentation(
                    Evaluate(rule, values, context)
                );
        }
        return new JsonObject
        {
            ["id"] = f.Id,
            ["libraryId"] = f.LibraryId,
            ["fileId"] = f.FileId,
            ["versionId"] = f.VersionId,
            ["partId"] = f.PartId,
            ["structureRevision"] = f.StructureRevision,
            ["path"] = f.Path,
            ["size"] = f.Size,
            ["duration"] = f.Duration,
            ["width"] = f.Width,
            ["height"] = f.Height,
            ["frameRate"] = f.FrameRate,
            ["videoCodec"] = f.VideoCodec,
            ["audioCodec"] = f.AudioCodec,
            ["position"] = f.Position,
            ["missingSince"] = f.MissingSince?.ToString("O"),
            ["mediaRevision"] = MediaRevision(f),
            ["presentation"] = presentation,
            ["values"] = values,
            ["facts"] = facts,
        };
    }

    internal static string GroupTuple(string[] columns) =>
        "json_array(" + string.Join(",", columns.Select(column => "json(COALESCE(" + column + ",'null'))")) + ")";

    /// <summary>
    /// Value and band groupings without an explicit sort list films group by group, so lists show one
    /// section per group. Lists and id queries (queues, bulk work) use the same order. An explicit sort
    /// or a multi-value member grouping keeps the requested order and only reports group counts.
    /// </summary>
    internal static bool Sectioned(JsonObject args, string[] columns) =>
        columns.Length > 0
        && args.List("orderBy").Count == 0
        && args.List("groupBy").All(g => g.Text("mode", "value") != "member");

    internal (string Where, TagQuery Compiler) CompileQuery(CompiledDefinitions c, JsonObject args)
    {
        QueryContract.Validate(args);
        var validation = new TagQuery(c);
        validation.Order(args);
        validation.Groups(args);
        var query = new TagQuery(c);
        var where = new List<string> { query.Compile(args["where"]) };
        if (!args.Flag("ignoreDefaultQuery"))
            where.Add(query.Compile(c.Package["catalogPolicy"]?["defaultQuery"]?["where"]));
        if (args.Text("scope") == "continue-watching")
            where.Add("EXISTS (SELECT 1 FROM playback_state s WHERE s.film_id=f.id AND s.resume=1)");
        else if (args.Text("scope") == "recently-played")
            where.Add("EXISTS (SELECT 1 FROM playback_state s WHERE s.film_id=f.id)");
        if (args.Text("libraryId").Length > 0)
        {
            query.Parameters.Add(("@lib", args.Text("libraryId")));
            where.Add("f.library_id=@lib");
        }
        if (args.Text("search").Length > 0)
            where.Add(
                query.Search(
                    c.Package["catalogPolicy"]?["search"].List("fields").Select(f => f.Text("tag")) ?? [],
                    args.Text("search")
                )
            );
        return (string.Join(" AND ", where.Select(w => "(" + w + ")")), query);
    }

    public async Task<JsonObject> QueryAsync(JsonObject args, CancellationToken ct = default)
    {
        await InitializeAsync(ct);
        return await repository.Database.ReadAsync(
            db =>
            {
                var c = Current(db);
                var (where, q) = CompileQuery(c, args);
                var total = Convert.ToInt64(
                    db.Scalar($"SELECT COUNT(*) FROM films f WHERE {where}", [.. q.Parameters])
                );
                var groups = new JsonObject();
                var (columns, join) = q.Groups(args);
                var tuple = GroupTuple(columns);
                if (columns.Length > 0)
                {
                    foreach (
                        var x in ReadRows(
                            db,
                            $"SELECT {tuple},COUNT(DISTINCT f.id) FROM films f {join} WHERE {where} GROUP BY {string.Join(",", columns)} ORDER BY {tuple}",
                            r => (r.GetString(0), r.GetInt64(1)),
                            [.. q.Parameters]
                        )
                    )
                        groups[x.Item1] = x.Item2;
                }
                var order = q.Order(args);
                var limit = Math.Clamp((int)args.Number("limit", 30), 1, 10000);
                var offset = Math.Max(0, (int)args.Number("offset"));
                var rows = ReadRows(
                    db,
                    Sectioned(args, columns)
                        ? $"SELECT f.payload,{tuple} FROM film_projection f {join} WHERE {where} ORDER BY {tuple},{order} LIMIT @limit OFFSET @offset"
                        : $"SELECT f.payload,NULL FROM film_projection f WHERE {where} ORDER BY {order} LIMIT @limit OFFSET @offset",
                    r =>
                        (
                            Film: CatalogRepository.Deserialize<Vroom.Core.Domain.Film>(r.GetString(0)),
                            Group: r.IsDBNull(1) ? null : r.GetString(1)
                        ),
                    [.. q.Parameters, ("@limit", limit), ("@offset", offset)]
                );
                var values = ValuesForMany(db, c, "film", rows.Select(row => row.Film.Id));
                return new JsonObject
                {
                    ["films"] = new JsonArray(
                        rows.Select(row =>
                            {
                                var view = FilmView(db, c, row.Film, values[row.Film.Id].DeepClone().AsObject());
                                if (row.Group is not null)
                                    view["groupKey"] = row.Group;
                                return (JsonNode?)view;
                            })
                            .ToArray()
                    ),
                    ["total"] = total,
                    ["groups"] = groups,
                    ["generation"] = Generation(db),
                };
            },
            ct
        );
    }

    public async Task<JsonObject> FilmAsync(string id, CancellationToken ct = default, string? partId = null)
    {
        await InitializeAsync(ct);
        return await repository.Database.ReadAsync(
            db =>
            {
                var c = Current(db);
                var film = partId is null
                    ? CatalogRepository.RequireFilm(db, id)
                    : CatalogRepository.RequirePart(db, id, partId);
                var scopes = ReadRows(
                        db,
                        "SELECT scope_id FROM media_scope_projection WHERE subject_id=@id AND part_id=@part",
                        r => r.GetString(0),
                        ("@id", id),
                        ("@part", film.PartId)
                    )
                    .ToHashSet();
                return new JsonObject
                {
                    ["film"] = FilmView(db, c, film),
                    ["generation"] = Generation(db),
                    ["annotations"] = new JsonArray(
                        Records(db, id)
                            .Where(r =>
                                r["scope"].Text("kind") != "whole"
                                && scopes.Contains(ScopeId(r["scope"]!))
                                && r["scope"].Text("mediaRevision") == MediaRevision(film)
                                && Project(db, c, r).Value is not null
                            )
                            .Select(r => (JsonNode?)EffectiveRecord(c, r, db))
                            .ToArray()
                    ),
                    ["candidates"] = new JsonArray(
                        ReadRows(
                                db,
                                "SELECT payload FROM tag_candidates WHERE subject_id=@id AND json_extract(payload,'$.subjectKind')='film' AND state='pending'",
                                r => (JsonNode?)JsonNode.Parse(r.GetString(0)),
                                ("@id", id)
                            )
                            .ToArray()
                    ),
                };
            },
            ct
        );
    }

    public async Task<object> OptionsAsync(JsonObject args, CancellationToken ct = default)
    {
        await InitializeAsync(ct);
        return await repository.Database.ReadAsync(
            db =>
            {
                var c = Current(db);
                var d = c.Require(args.Text("tagKey"));
                var vocabulary = ValueContracts.Vocabulary(d);
                var search = Normalize(args.Text("search"));
                var locale = args.Text("locale", c.Package["i18n"].Text("defaultLocale", "en"));
                var collator = System.Globalization.CultureInfo.GetCultureInfo(locale).CompareInfo;
                // Search every translation and alias; order by the name shown in the requested language.
                var filtered = c
                    .Terms.Values.Where(t => c.InVocabulary(t, vocabulary))
                    .Select(t => (Term: t, Name: TagJson.Label(t["label"], locale, c.Package)))
                    .Where(x =>
                        search.Length == 0
                        || Names(x.Term).Any(n => Normalize(n).Contains(search, StringComparison.Ordinal))
                    )
                    .OrderBy(
                        x => x.Name,
                        Comparer<string>.Create(
                            (l, r) => collator.Compare(l, r, System.Globalization.CompareOptions.IgnoreCase)
                        )
                    )
                    .ThenBy(x => x.Term.Text("id"), StringComparer.Ordinal)
                    .Select(x =>
                        (JsonNode)
                            new JsonObject
                            {
                                ["id"] = x.Term.Text("id"),
                                ["label"] = x.Term["label"].Copy(),
                                ["value"] = c.TermValue(d, x.Term),
                            }
                    )
                    .ToArray();
                var limit = Math.Clamp((int)args.Number("limit", 200), 1, 500);
                return new
                {
                    items = filtered.Skip(Math.Max(0, (int)args.Number("offset"))).Take(limit).ToArray(),
                    total = filtered.Length,
                };
            },
            ct
        );
    }

    private static string Normalize(string text) =>
        text.Normalize(System.Text.NormalizationForm.FormKC).ToLowerInvariant().Trim();

    private static IEnumerable<string> Names(JsonObject term) =>
        (term["label"] as JsonObject ?? [])
            .Select(p => p.Value?.ToString() ?? "")
            .Concat((term["aliases"] as JsonArray ?? []).Select(a => a is JsonValue ? a.ToString() : TagJson.Label(a)));
}
