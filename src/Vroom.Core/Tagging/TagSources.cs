using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Xml;
using System.Xml.Linq;
using System.Xml.XPath;
using AngleSharp.Html.Parser;
using Vroom.Core.Catalog;
using Vroom.Core.Jobs;
using Vroom.Core.Storage;

namespace Vroom.Core.Tagging;

public sealed record SourceOutcome(
    string SourceId,
    string Status,
    int FieldCount = 0,
    string? Error = null,
    DateTimeOffset? RetryAt = null,
    string? Cause = null
);

public sealed record EnrichmentResult(IReadOnlyList<SourceOutcome> Sources)
{
    public bool Found => Sources.Any(source => source.FieldCount > 0);
    public bool HasFailures => Sources.Any(source => source.Error is not null);
}

public sealed partial class TagSources : IDisposable
{
    private readonly TagEngine engine;
    private readonly SourceAccess access;

    public TagSources(TagEngine engine)
        : this(engine, new SourceHttpClient()) { }

    internal TagSources(
        TagEngine engine,
        SourceHttpClient http,
        ISourceBrowser? browser = null,
        Vroom.Core.Network.NetworkService? network = null
    )
    {
        this.engine = engine;
        access = new(
            engine.Repository,
            http,
            browser ?? new SourceBrowser(engine.Repository.Database.DataDirectory, false),
            network
        );
    }

    internal Task ResetConnectionFailuresAsync(CancellationToken ct) => access.ResetConnectionFailuresAsync(ct);

    private sealed record CachedDocument(string Content, string Url);

    public async Task<EnrichmentResult> EnrichAsync(
        string filmId,
        CancellationToken ct = default,
        Func<Vroom.Core.Application.UiMessage, Task>? progress = null
    ) => await EnrichSubjectAsync("film", filmId, ct, progress);

    public async Task<EnrichmentResult> EnrichSubjectAsync(
        string subjectKind,
        string subjectId,
        CancellationToken ct = default,
        Func<Vroom.Core.Application.UiMessage, Task>? progress = null,
        bool automatic = false
    ) => await EnrichCoreAsync(subjectKind, subjectId, ct, progress, null, automatic);

    internal Task<EnrichmentResult> EnrichSubscriptionAsync(
        SubscriptionTarget target,
        CancellationToken ct,
        Func<Vroom.Core.Application.UiMessage, Task>? progress = null
    ) => EnrichCoreAsync(target.Kind, target.Id, ct, progress, target, false);

    private async Task<EnrichmentResult> EnrichCoreAsync(
        string subjectKind,
        string subjectId,
        CancellationToken ct,
        Func<Vroom.Core.Application.UiMessage, Task>? progress,
        SubscriptionTarget? subscription,
        bool automatic,
        JsonObject? batch = null
    )
    {
        if (subjectKind is not ("film" or "term"))
            throw new TagException("SUBJECT_UNRESOLVED");
        await engine.InitializeAsync(ct);
        // Read the definition document, value identities and subject in one snapshot.
        // The UI projection is not an authoring document and must not be recompiled.
        var snapshot = await engine.Repository.Database.ReadAsync(
            db =>
            {
                var current = engine.Current(db);
                var film = subjectKind == "film" ? CatalogRepository.RequireFilm(db, subjectId) : null;
                var term = subjectKind == "term" ? current.RequireTerm(subjectId) : null;
                var facts = film is not null ? TagEngine.Facts(film) : TagEngine.EntityFacts(current, term!);
                return new SourceSnapshot(
                    current,
                    film,
                    new() { ["kind"] = subjectKind, ["id"] = subjectId },
                    TagEngine.Values(db, current, subjectKind, subjectId),
                    TagEngine.Generation(db),
                    (long)(term?.Number("revision") ?? 0),
                    facts
                );
            },
            ct
        );
        if (subscription is not null)
            TagEngine.ValidateSubscription(snapshot, subscription);
        if (batch is not null)
            TagEngine.ValidateEnrichmentTarget(snapshot, batch);
        var package = snapshot.Package;
        var compiled = snapshot.Definitions;
        var film = snapshot.Film;
        var values = snapshot.Values;
        var settings = await engine.Repository.SettingsAsync(ct);
        var outcomes = new List<SourceOutcome>();
        var observations = new List<SourceObservation>();
        foreach (var sourceEntry in package.Map("sources"))
        {
            ct.ThrowIfCancellationRequested();
            var source = sourceEntry.Value!;
            if (!source.Flag("enabled", true))
            {
                outcomes.Add(new(sourceEntry.Key, "disabled"));
                continue;
            }
            if (
                source["when"] is { } condition
                && TagEngine.Evaluate(condition, values, snapshot.Facts)?.ToString() != "true"
            )
            {
                outcomes.Add(new(sourceEntry.Key, "not-applicable"));
                continue;
            }
            var rules = compiled
                .Definitions.Values.Where(d =>
                    d.Flag("enabled", true)
                    && AnnotationTargets.Supports(d, subjectKind, "whole")
                    && compiled.SubjectIssue(d, snapshot.Subject) is null
                )
                .SelectMany(d =>
                    d.List("enrichment")
                        .Where(r => r.Text("source") == sourceEntry.Key)
                        .Select(r => (Definition: d, Rule: r!))
                )
                .ToArray();
            if (rules.Length == 0)
            {
                outcomes.Add(new(sourceEntry.Key, "no-rules"));
                continue;
            }
            // Automatic enrichment honours the source refresh policy: by default a source is only
            // consulted while one of the fields it fills is still empty. Explicit requests always run.
            if (
                automatic
                && source.Text("refresh", "missing") == "missing"
                && rules.All(r =>
                    values[r.Definition.Text("key")] is { } current
                    && current["value"] is not null
                    && current["origin"].Text("kind") is not ("default" or "derived")
                )
            )
            {
                outcomes.Add(new(sourceEntry.Key, "up-to-date"));
                continue;
            }
            try
            {
                string content;
                Uri? baseUri = null;
                string location;
                var parameters = new Dictionary<string, string>();
                (string Key, string Payload, string Expires)? cacheWrite = null;
                if (source.Text("transport") == "sidecar")
                {
                    if (film is null)
                    {
                        outcomes.Add(new(sourceEntry.Key, "not-applicable"));
                        continue;
                    }
                    var ext = source.Text("extension", ".nfo");
                    if (ext.IndexOfAny(['/', '\\']) >= 0 || !ext.StartsWith('.'))
                        throw new TagException("SOURCE_PATH_INVALID");
                    location = Path.ChangeExtension(film.Path, ext);
                    content = await Task.Run(
                        async () =>
                        {
                            if (!File.Exists(location))
                                return "";
                            if (new FileInfo(location).Length > 4 * 1024 * 1024)
                                throw new TagException("SOURCE_TOO_LARGE");
                            return await File.ReadAllTextAsync(location, ct);
                        },
                        ct
                    );
                    if (content.Length == 0)
                    {
                        outcomes.Add(new(sourceEntry.Key, "sidecar-unavailable"));
                        continue;
                    }
                }
                else if (source.Text("transport") == "http")
                {
                    if (!settings.OnlineMetadata)
                    {
                        outcomes.Add(new(sourceEntry.Key, "online-disabled"));
                        continue;
                    }
                    var url = source["request"].Text("urlTemplate");
                    bool missing = false;
                    foreach (var parameter in source["request"].Map("parameters"))
                    {
                        var value = TagEngine.Evaluate(parameter.Value, values, snapshot.Facts);
                        if (value is null)
                        {
                            missing = true;
                            break;
                        }
                        parameters[parameter.Key] = value.ToString();
                        url = url.Replace(
                            "{" + parameter.Key + "}",
                            Uri.EscapeDataString(value.ToString()),
                            StringComparison.Ordinal
                        );
                    }
                    if (missing)
                    {
                        outcomes.Add(new(sourceEntry.Key, "missing-parameters"));
                        continue;
                    }
                    baseUri = new Uri(url);
                    location = url;
                    var cacheKey = TagJson.Hash(
                        new JsonObject
                        {
                            ["cacheContract"] = "source-document@1",
                            ["url"] = url,
                            ["source"] = source.Copy(),
                        }
                    );
                    var cached = await engine.Repository.Database.RunAsync(
                        db =>
                            db.Scalar(
                                "SELECT payload FROM tag_source_cache WHERE key=@k AND expires>@t",
                                ("@k", cacheKey),
                                ("@t", TagEngine.Now)
                            ) as string,
                        ct
                    );
                    if (cached is not null)
                    {
                        var document = JsonSerializer.Deserialize<CachedDocument>(cached, CatalogRepository.Json)!;
                        content = document.Content;
                        baseUri = new Uri(document.Url);
                        location = baseUri.AbsoluteUri;
                    }
                    else
                    {
                        var fetched = await access.FetchAsync(
                            sourceEntry.Key,
                            source,
                            baseUri,
                            Math.Clamp((int)source["limits"].Number("maxResponseBytes", 4194304), 1, 4194304),
                            settings.SourceBrowserPath,
                            progress,
                            ct
                        );
                        content = Encoding.UTF8.GetString(fetched.Bytes);
                        baseUri = fetched.Url;
                        location = baseUri.AbsoluteUri;
                        var expires = DateTimeOffset
                            .UtcNow.AddSeconds(Math.Clamp(source["limits"].Number("cacheTtlSeconds", 86400), 0, 604800))
                            .ToString("O");
                        cacheWrite = (
                            cacheKey,
                            JsonSerializer.Serialize(new CachedDocument(content, location), CatalogRepository.Json),
                            expires
                        );
                    }
                }
                else
                    throw new TagException("SOURCE_TRANSPORT_UNAVAILABLE");
                var fields = await Parse(source["parse"]!, content, baseUri, package, ct, parameters);
                bool matched = true;
                foreach (var match in source.List("match"))
                {
                    var expected = values[match.Text("tag")]?["value"]?.ToString();
                    var observed = fields[match.Text("field")]?.ToString();
                    if (match?["normalizeWith"] is { } rule && observed is not null)
                        observed = TagEngine.Extract(package["rules"]![rule.ToString()]!, observed).FirstOrDefault();
                    if (string.IsNullOrEmpty(observed) && match.Flag("optional"))
                        continue;
                    if (string.IsNullOrEmpty(observed))
                        throw new TagException(
                            "SOURCE_REQUIRED_FIELD_MISSING",
                            sourceEntry.Key,
                            "host.SourceHttp.requiredFieldMissing"
                        );
                    if (expected is not null && !string.Equals(expected, observed, StringComparison.Ordinal))
                    {
                        matched = false;
                        break;
                    }
                }
                if (!matched)
                    throw new TagException("SOURCE_IDENTITY_MISMATCH", sourceEntry.Key);
                // Verification/login/error pages must not be cached as valid source documents.
                if (cacheWrite is { } cache)
                    await engine.Repository.Database.RunAsync(
                        db =>
                            db.Execute(
                                "INSERT INTO tag_source_cache VALUES(@k,@p,@e) ON CONFLICT(key) DO UPDATE SET payload=@p,expires=@e",
                                ("@k", cache.Key),
                                ("@p", cache.Payload),
                                ("@e", cache.Expires)
                            ),
                        ct
                    );
                var candidateFields = new List<(JsonObject Definition, JsonNode Rule, JsonNode Value)>();
                var assetFailures = 0;
                foreach (var (d, rule) in rules)
                {
                    var value = fields[rule.Text("field")];
                    if (value is null || value.ToString().Length == 0)
                        continue;
                    if (rule["transform"] is { } expression)
                    {
                        var facts = snapshot.Facts.DeepClone().AsObject();
                        facts["source"] = new JsonObject { ["value"] = value.Copy(), ["fields"] = fields.Copy() };
                        value = TagEngine.Evaluate(expression, values, facts);
                        if (value is null)
                            continue;
                    }
                    if (rule["entities"] is JsonObject entities)
                    {
                        value = TagEngine.MapSourceEntities(entities, value, values, snapshot.Facts);
                        if (value is JsonArray { Count: 0 })
                            continue;
                    }
                    if (d["input"].Text("component") == "asset@1" && value is JsonValue)
                    {
                        var target = value.ToString();
                        byte[] bytes;
                        try
                        {
                            if (
                                Uri.TryCreate(target, UriKind.Absolute, out var remote)
                                && remote.Scheme is "http" or "https"
                            )
                            {
                                if (!settings.OnlineMetadata)
                                    continue;
                                var asset = await access.AssetAsync(
                                    sourceEntry.Key,
                                    source,
                                    remote,
                                    10 * 1024 * 1024,
                                    settings.SourceBrowserPath,
                                    baseUri,
                                    ct
                                );
                                if (asset.Status is < 200 or >= 300)
                                    throw new HttpRequestException("Source asset unavailable");
                                bytes = asset.Bytes;
                            }
                            else
                            {
                                if (film is null)
                                    throw new TagException("ASSET_PATH_FORBIDDEN");
                                var directory = Path.GetDirectoryName(film.Path)!;
                                var local = Path.GetFullPath(Path.Combine(directory, target));
                                if (
                                    !local.StartsWith(
                                        directory + Path.DirectorySeparatorChar,
                                        OperatingSystem.IsWindows()
                                            ? StringComparison.OrdinalIgnoreCase
                                            : StringComparison.Ordinal
                                    )
                                )
                                    throw new TagException("ASSET_PATH_FORBIDDEN");
                                bytes = await Task.Run(
                                    async () =>
                                        new FileInfo(local).Length <= 10 * 1024 * 1024
                                            ? await File.ReadAllBytesAsync(local, ct)
                                            : throw new TagException("SOURCE_TOO_LARGE"),
                                    ct
                                );
                            }
                            var assetId = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(bytes));
                            var folder = Path.Combine(engine.Repository.Database.DataDirectory, "tag-assets");
                            Directory.CreateDirectory(folder);
                            await File.WriteAllBytesAsync(Path.Combine(folder, assetId), bytes, ct);
                            value = JsonValue.Create("asset:" + assetId);
                        }
                        catch (Exception e)
                            when (!ct.IsCancellationRequested
                                && e
                                    is IOException
                                        or HttpRequestException
                                        or TagException
                                        or SourceAccessException
                                        or OperationCanceledException
                            )
                        {
                            assetFailures++;
                            access.LogAssetFailure(sourceEntry.Key, e);
                            await engine.Repository.AuditAsync("source.asset.failed", e.Message, ct);
                            continue;
                        }
                    }
                    candidateFields.Add((d, rule, value.Copy()!));
                }
                observations.AddRange(
                    candidateFields.Select(item => new SourceObservation(
                        item.Definition,
                        item.Rule,
                        item.Value,
                        sourceEntry.Key,
                        source.Text("evidenceGroup", sourceEntry.Key),
                        location,
                        DateTimeOffset.UtcNow
                    ))
                );
                outcomes.Add(
                    new(
                        sourceEntry.Key,
                        candidateFields.Count > 0 ? "found" : "no-values",
                        candidateFields.Count,
                        assetFailures > 0 ? "host.SourceAccess.assetsFailed" : null
                    )
                );
                await access.SuccessAsync(sourceEntry.Key, source, ct);
            }
            catch (Exception error)
                when (!ct.IsCancellationRequested
                    && (
                        error
                            is HttpRequestException
                                or IOException
                                or XmlException
                                or JsonException
                                or System.Net.Sockets.SocketException
                                or OperationCanceledException
                                or SourceAccessException
                                or SourceFetchFailure
                        || error is TagException tag && tag.Code.StartsWith("SOURCE_", StringComparison.Ordinal)
                    )
                )
            {
                outcomes.Add(await access.FailureAsync(sourceEntry.Key, source, error, ct));
            }
        }
        var result = new EnrichmentResult(outcomes);
        if (batch is not null && result.HasFailures)
            throw new JobResultFailure("host.SourceAccess.failed", result);
        await engine.ApplySourceObservationsAsync(snapshot, observations, ct, batch, result);
        return result;
    }

    private static async Task<JsonObject> Parse(
        JsonNode parse,
        string content,
        Uri? baseUri,
        JsonObject package,
        CancellationToken ct,
        IReadOnlyDictionary<string, string>? parameters = null
    )
    {
        var result = new JsonObject();
        var format = parse.Text("format");
        var html = format == "html" ? await new HtmlParser().ParseDocumentAsync(content, ct) : null;
        JsonNode? json = format == "json" ? JsonNode.Parse(content) : null;
        XDocument? xml = null;
        if (format == "xml")
        {
            using var input = new StringReader(content);
            using var reader = XmlReader.Create(
                input,
                new XmlReaderSettings
                {
                    DtdProcessing = DtdProcessing.Prohibit,
                    XmlResolver = null,
                    MaxCharactersInDocument = 4194304,
                }
            );
            xml = XDocument.Load(reader);
        }
        foreach (var pair in parse.Map("fields"))
        {
            var f = pair.Value!;
            var values = new List<string>();
            if (html is not null)
                foreach (var element in html.QuerySelectorAll(f.Text("selector")))
                {
                    var extract = f.Text("extract", "text");
                    values.Add(
                        extract.StartsWith("attribute:")
                            ? element.GetAttribute(extract[10..]) ?? ""
                            : element.TextContent
                    );
                }
            else if (xml?.Root is { } root)
                values.AddRange(root.XPathSelectElements(f.Text("selector")).Select(e => e.Value));
            else if (json is not null)
            {
                var selected = json;
                var pointer = f.Text("pointer");
                foreach (var parameter in parameters ?? new Dictionary<string, string>())
                    pointer = pointer.Replace(
                        "{" + parameter.Key + "}",
                        parameter.Value.Replace("~", "~0").Replace("/", "~1"),
                        StringComparison.Ordinal
                    );
                foreach (var part in pointer.Split('/').Skip(1))
                {
                    selected =
                        selected is JsonArray array && int.TryParse(part, out var index)
                            ? array.ElementAtOrDefault(index)
                        : selected is JsonObject obj ? obj[part.Replace("~1", "/").Replace("~0", "~")]
                        : null;
                }
                if (f.Flag("structured"))
                {
                    if (selected is JsonArray selectedArray && selectedArray.Count > 100)
                        selected = new JsonArray(selectedArray.Take(100).Select(x => x.Copy()).ToArray());
                    if (selected is not null)
                        result[pair.Key] = selected.DeepClone();
                    continue;
                }
                if (selected is JsonArray a)
                    values.AddRange(a.Select(x => x?.ToString() ?? ""));
                else if (selected is not null)
                    values.Add(selected.ToString());
            }
            else if (format == "text")
                values.AddRange(TagEngine.Extract(f, content, 100));
            values = values.Select(x => x.Trim()).Where(x => x.Length > 0).Distinct().Take(100).ToList();
            if (f["normalizeWith"] is { } normalize)
                values = values
                    .SelectMany(v => TagEngine.Extract(package["rules"]![normalize.ToString()]!, v))
                    .ToList();
            if (f.Flag("resolveUrl") && baseUri is not null)
                values = values.Select(v => new Uri(baseUri, v).AbsoluteUri).ToList();
            if (values.Count > 0)
                result[pair.Key] =
                    f.Text("cardinality") == "many"
                        ? new JsonArray(values.Select(v => (JsonNode?)JsonValue.Create(v)).ToArray())
                        : JsonValue.Create(values[0]);
        }
        return result;
    }

    public void Dispose()
    {
        access.Dispose();
    }
}
