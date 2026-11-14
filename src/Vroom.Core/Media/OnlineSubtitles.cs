using System.Collections.Concurrent;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Vroom.Core.Application;
using Vroom.Core.Network;
using Vroom.Core.Storage;
using Vroom.Core.Tagging;

namespace Vroom.Core.Media;

public sealed record SubtitleAccount(bool Available, bool Configured, bool SignedIn);

public sealed record SubtitleMatch(long FileId, string Name, string Language, bool HearingImpaired, int Downloads);

public sealed record SubtitleSearch(
    string Ticket,
    string PartId,
    IReadOnlyList<SubtitleMatch> Matches,
    int Page,
    int Pages
);

public sealed record SubtitleDownload(string FilmId, string PartId, string FileId, string Name, string Text);

// Provider-specific wire protocol is host code; film identity and search policy are
// never inferred from business tags. User queries are explicit and results are reviewed.
public sealed class OnlineSubtitles
{
    private const string Key = "vroom.opensubtitles.key",
        Token = "vroom.opensubtitles.token",
        Endpoint = "vroom.opensubtitles.endpoint";
    private const int MaximumBytes = 5_000_000;
    private readonly CatalogRepository repository;
    private readonly ISecretStore secrets;
    private readonly Func<SourceHttpClient> client;
    private readonly ConcurrentDictionary<string, SearchSession> searches = new();
    private readonly SemaphoreSlim accountGate = new(1, 1),
        downloadGate = new(1, 1);

    private sealed record SearchSession(
        string FilmId,
        string PartId,
        string Revision,
        DateTimeOffset Created,
        IReadOnlyList<SubtitleMatch> Matches
    )
    {
        public Dictionary<long, SubtitleDownload> Completed { get; } = new();
    }

    public OnlineSubtitles(CatalogRepository repository, ISecretStore secrets, NetworkService network)
        : this(repository, secrets, () => new(network.CaptureProxy())) { }

    internal OnlineSubtitles(CatalogRepository repository, ISecretStore secrets, Func<SourceHttpClient> client)
    {
        this.repository = repository;
        this.secrets = secrets;
        this.client = client;
    }

    public async Task<SubtitleAccount> AccountAsync() =>
        new(
            secrets.Available,
            !string.IsNullOrEmpty(await secrets.GetAsync(Key)),
            !string.IsNullOrEmpty(await secrets.GetAsync(Token))
        );

    public async Task<SubtitleAccount> ConfigureAsync(string apiKey)
    {
        if (apiKey.Length > 1024 || apiKey.Any(char.IsControl))
            throw new ArgumentException("host.Subtitles.invalidKey");
        await accountGate.WaitAsync();
        try
        {
            await secrets.SetAsync(Key, apiKey.Trim());
            await secrets.SetAsync(Token, null);
            searches.Clear();
            return await AccountAsync();
        }
        finally
        {
            accountGate.Release();
        }
    }

    public async Task<SubtitleAccount> SignInAsync(string username, string password, CancellationToken ct = default)
    {
        if (username.Length is < 1 or > 200 || password.Length is < 1 or > 1024)
            throw new ArgumentException("host.Subtitles.credentialsRequired");
        await accountGate.WaitAsync(ct);
        try
        {
            using var http = client();
            var result = await ApiAsync(
                http,
                "login",
                new JsonObject { ["username"] = username, ["password"] = password },
                ct
            );
            var token = result["token"]?.GetValue<string>();
            if (string.IsNullOrWhiteSpace(token) || token.Length > 8192 || token.Any(char.IsControl))
                throw new InvalidOperationException("host.Subtitles.invalidResponse");
            var host = result["base_url"]?.GetValue<string>() ?? "api.opensubtitles.com";
            if (Uri.TryCreate(host, UriKind.Absolute, out var baseUri))
                host = baseUri.Scheme == "https" ? baseUri.Host : "";
            if (host is not ("api.opensubtitles.com" or "vip-api.opensubtitles.com"))
                throw new InvalidOperationException("host.Subtitles.invalidResponse");
            await secrets.SetAsync(Endpoint, host);
            await secrets.SetAsync(Token, token);
            return await AccountAsync();
        }
        finally
        {
            accountGate.Release();
        }
    }

    public async Task<SubtitleAccount> SignOutAsync()
    {
        await accountGate.WaitAsync();
        try
        {
            await secrets.SetAsync(Token, null);
            searches.Clear();
            return await AccountAsync();
        }
        finally
        {
            accountGate.Release();
        }
    }

    public async Task<SubtitleSearch> SearchAsync(
        string filmId,
        string? partId,
        string query,
        string language,
        int page = 1,
        CancellationToken ct = default
    )
    {
        if (
            string.IsNullOrWhiteSpace(query)
            || query.Length > 300
            || !Regex.IsMatch(language, "^([a-z]{2,3}(-[a-z]{2,4})?(,[a-z]{2,3}(-[a-z]{2,4})?)*)?$")
            || page is < 1 or > 100
        )
            throw new ArgumentException("host.Subtitles.invalidSearch");
        var film = await repository.GetMediaPartAsync(filmId, partId, ct);
        if (film.PartId is null)
            throw new ArgumentException("host.MediaStructure.invalidTarget");
        using var http = client();
        var result = await ApiAsync(
            http,
            "subtitles?query="
                + Uri.EscapeDataString(query.Trim())
                + "&languages="
                + Uri.EscapeDataString(language)
                + "&page="
                + page,
            null,
            ct
        );
        var matches = new List<SubtitleMatch>();
        foreach (var item in (result["data"] as JsonArray ?? []).Take(100))
        {
            var a = item?["attributes"];
            if (a is not JsonObject)
                continue;
            foreach (var file in (a["files"] as JsonArray ?? []).Take(100))
            {
                var id = file?["file_id"]?.GetValue<long>() ?? 0;
                if (id <= 0)
                    continue;
                matches.Add(
                    new(
                        id,
                        Clip(
                            file?["file_name"]?.GetValue<string>() ?? a["release"]?.GetValue<string>() ?? id.ToString(),
                            300
                        ),
                        Clip(a["language"]?.GetValue<string>() ?? "und", 20),
                        a["hearing_impaired"]?.GetValue<bool>() == true,
                        a["download_count"]?.GetValue<int>() ?? 0
                    )
                );
            }
        }
        matches = matches.DistinctBy(m => m.FileId).Take(100).ToList();
        foreach (var expired in searches.Where(p => DateTimeOffset.UtcNow - p.Value.Created > TimeSpan.FromMinutes(20)))
            searches.TryRemove(expired.Key, out _);
        if (searches.Count >= 100)
            throw new InvalidOperationException("host.Subtitles.tooManySearches");
        var ticket = Guid.NewGuid().ToString("N");
        searches[ticket] = new(filmId, film.PartId, TagEngine.MediaRevision(film), DateTimeOffset.UtcNow, matches);
        return new(ticket, film.PartId, matches, page, Math.Clamp(result["total_pages"]?.GetValue<int>() ?? 1, 1, 100));
    }

    public async Task<SubtitleDownload> DownloadAsync(string ticket, long fileId, CancellationToken ct = default)
    {
        await downloadGate.WaitAsync(ct);
        try
        {
            if (
                !searches.TryGetValue(ticket, out var session)
                || DateTimeOffset.UtcNow - session.Created > TimeSpan.FromMinutes(20)
                || !session.Matches.Any(m => m.FileId == fileId)
            )
                throw new InvalidOperationException("host.Subtitles.searchExpired");
            if (session.Completed.TryGetValue(fileId, out var completed))
                return completed;
            await CheckPartAsync(session, ct);
            using var http = client();
            var result = await ApiAsync(
                http,
                "download",
                new JsonObject { ["file_id"] = fileId, ["sub_format"] = "srt" },
                ct
            );
            if (
                !Uri.TryCreate(result["link"]?.GetValue<string>(), UriKind.Absolute, out var uri)
                || uri.Scheme != "https"
                || uri.UserInfo.Length > 0
            )
                throw new InvalidOperationException("host.Subtitles.invalidResponse");
            // Temporary file URLs never receive credentials; redirects still pass public-address checks.
            using var response = await http.GetAsync(uri, ct);
            CheckStatus(response);
            var bytes = await ReadAsync(response, MaximumBytes, ct);
            var text = new UTF8Encoding(false, true).GetString(bytes).TrimStart('\uFEFF');
            ValidateText(text);
            await CheckPartAsync(session, ct);
            var structure = await repository.ResourcesAsync(session.FilmId, ct);
            var directory = Path.Combine(repository.Database.DataDirectory, "resources", "subtitles");
            Directory.CreateDirectory(directory);
            var path = Path.Combine(directory, Guid.NewGuid().ToString("N") + ".srt");
            var name = Clip(
                Path.GetFileName(
                    result["file_name"]?.GetValue<string>() ?? session.Matches.First(m => m.FileId == fileId).Name
                ),
                190
            );
            if (string.IsNullOrWhiteSpace(name))
                name = fileId + ".srt";
            try
            {
                await File.WriteAllTextAsync(path, text, new UTF8Encoding(false), ct);
                var updated = await repository.AddResourceSetAsync(
                    session.FilmId,
                    structure.Revision,
                    name,
                    [path],
                    partId: session.PartId,
                    ct: ct
                );
                var resource = updated.ResourceSets.SelectMany(s => s.Files).Single(f => f.Path == path);
                completed = new(session.FilmId, session.PartId, resource.Id, name, text);
                session.Completed[fileId] = completed;
                return completed;
            }
            catch
            {
                File.Delete(path);
                throw;
            }
        }
        finally
        {
            downloadGate.Release();
        }
    }

    public async Task<SubtitleDownload> ReadAsync(
        string filmId,
        string partId,
        string fileId,
        CancellationToken ct = default
    )
    {
        var structure = await repository.ResourcesAsync(filmId, ct);
        var file =
            structure
                .ResourceSets.Where(s => s.PartId == partId)
                .SelectMany(s => s.Files)
                .FirstOrDefault(f => f.Id == fileId)
            ?? throw new ArgumentException("host.MediaStructure.invalidTarget");
        if (!string.Equals(Path.GetExtension(file.Path), ".srt", StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("host.Subtitles.invalidResponse");
        await using var stream = new FileStream(file.Path, FileMode.Open, FileAccess.Read, FileShare.Read, 4096, true);
        if (stream.Length > MaximumBytes)
            throw new InvalidOperationException("host.Subtitles.tooLarge");
        using var buffer = new MemoryStream();
        var bytes = new byte[8192];
        int count;
        while ((count = await stream.ReadAsync(bytes, ct)) > 0)
        {
            if (buffer.Length + count > MaximumBytes)
                throw new InvalidOperationException("host.Subtitles.tooLarge");
            buffer.Write(bytes, 0, count);
        }
        var text = new UTF8Encoding(false, true).GetString(buffer.ToArray()).TrimStart('\uFEFF');
        ValidateText(text);
        return new(filmId, partId, fileId, Path.GetFileName(file.Path), text);
    }

    private async Task CheckPartAsync(SearchSession session, CancellationToken ct)
    {
        var current = await repository.GetMediaPartAsync(session.FilmId, session.PartId, ct);
        if (TagEngine.MediaRevision(current) != session.Revision)
            throw new InvalidOperationException("host.MediaStructure.fileChanged");
    }

    private async Task<JsonObject> ApiAsync(
        SourceHttpClient http,
        string endpoint,
        JsonObject? body,
        CancellationToken ct
    )
    {
        if (!secrets.Available)
            throw new InvalidOperationException("host.Subtitles.secureStoreUnavailable");
        var key = await secrets.GetAsync(Key);
        if (string.IsNullOrEmpty(key))
            throw new InvalidOperationException("host.Subtitles.keyRequired");
        var headers = new Dictionary<string, string>
        {
            { "Api-Key", key },
            { "User-Agent", "Vroom v3.0.0" },
            { "Accept", "application/json" },
        };
        var token = await secrets.GetAsync(Token);
        if (!string.IsNullOrEmpty(token) && endpoint != "login")
            headers["Authorization"] = "Bearer " + token;
        var host =
            endpoint == "login" || string.IsNullOrEmpty(token)
                ? "api.opensubtitles.com"
                : await secrets.GetAsync(Endpoint) ?? "api.opensubtitles.com";
        if (host is not ("api.opensubtitles.com" or "vip-api.opensubtitles.com"))
            throw new InvalidOperationException("host.Subtitles.invalidResponse");
        using var response = await http.SendOnceAsync(
            new("https://" + host + "/api/v1/" + endpoint),
            body is null ? HttpMethod.Get : HttpMethod.Post,
            body?.ToJsonString(),
            headers,
            ct
        );
        CheckStatus(response);
        var bytes = await ReadAsync(response, 2_000_000, ct);
        return JsonNode.Parse(bytes) as JsonObject
            ?? throw new InvalidOperationException("host.Subtitles.invalidResponse");
    }

    private static void CheckStatus(HttpResponseMessage response)
    {
        if (response.IsSuccessStatusCode)
            return;
        throw new InvalidOperationException(
            (int)response.StatusCode switch
            {
                401 or 403 => "host.Subtitles.authentication",
                406 or 429 => "host.Subtitles.quota",
                _ => "host.Subtitles.requestFailed",
            }
        );
    }

    private static async Task<byte[]> ReadAsync(HttpResponseMessage response, int maximum, CancellationToken ct)
    {
        if (response.Content.Headers.ContentLength > maximum)
            throw new InvalidOperationException("host.Subtitles.tooLarge");
        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        using var output = new MemoryStream();
        var buffer = new byte[8192];
        int count;
        while ((count = await stream.ReadAsync(buffer, ct)) > 0)
        {
            if (output.Length + count > maximum)
                throw new InvalidOperationException("host.Subtitles.tooLarge");
            output.Write(buffer, 0, count);
        }
        return output.ToArray();
    }

    private static void ValidateText(string text)
    {
        if (
            text.Contains('\0')
            || !Regex.IsMatch(
                text,
                @"\d{2,}:\d{2}:\d{2}[,.]\d{3}\s+-->\s+\d{2,}:\d{2}:\d{2}[,.]\d{3}",
                RegexOptions.CultureInvariant,
                TimeSpan.FromSeconds(1)
            )
        )
            throw new InvalidOperationException("host.Subtitles.invalidResponse");
    }

    private static string Clip(string text, int maximum) =>
        new(text.Where(c => !char.IsControl(c)).Take(maximum).ToArray());
}
