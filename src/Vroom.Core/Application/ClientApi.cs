using System.Text.Json;
using System.Text.Json.Nodes;
using Vroom.Core.Catalog;
using Vroom.Core.Domain;
using Vroom.Core.Intelligence;
using Vroom.Core.Jobs;
using Vroom.Core.Media;
using Vroom.Core.Storage;
using Vroom.Core.Tagging;

namespace Vroom.Core.Application;

/// <summary>The React client uses the same API over native raw messages and localhost HTTP.</summary>
public sealed partial class ClientApi(
    CatalogRepository repository,
    JobCoordinator jobs,
    BackgroundOperations operations,
    AgentTools tools,
    LocalMediaServer media,
    IPlatformActions platform,
    TagEngine tagging,
    TagRpc tags,
    VideoExportService exports,
    LanguagePacks languages,
    LibraryScanner scanner,
    LocalDiagnostics? diagnostics = null,
    NativeMpvService? nativePlayback = null,
    Vroom.Core.Network.NetworkService? network = null,
    ExternalPlayers? externalPlayers = null,
    OnlineSubtitles? subtitles = null,
    MediaIdentity? mediaIdentity = null,
    CatalogMaintenance? maintenance = null,
    ChangeFeed? changes = null
)
{
    public async Task<string> RequestAsync(string request)
    {
        string? operation = null;
        try
        {
            if (System.Text.Encoding.UTF8.GetByteCount(request) > 20_000_000)
                throw new ArgumentException("host.ClientApi.requestIsTooLarge");
            using var document = JsonDocument.Parse(request);
            var root = document.RootElement;
            var method = root.GetProperty("method").GetString() ?? "";
            operation = method;
            var args = root.TryGetProperty("args", out var a) ? a : JsonSerializer.SerializeToElement(new { });
            if (
                root.TryGetProperty("context", out var context)
                && context.ValueKind == JsonValueKind.Object
                && Optional(context, "tabId") is { Length: > 0 and <= 200 } tabId
                && Optional(context, "title") is { Length: <= 200 } title
            )
                TaskOrigin.Current.Value = new(tabId, title);
            var result = await DispatchAsync(method, args);
            return CatalogRepository.Serialize(new { ok = true, data = result });
        }
        catch (Exception ex)
        {
            var diagnosticId = Guid.NewGuid().ToString("N")[..8];
            diagnostics?.Error((operation ?? "rpc") + "#" + diagnosticId, ex, TaskOrigin.Current.Value?.TabId);
            return CatalogRepository.Serialize(ErrorEnvelope(ex, diagnosticId));
        }
        finally
        {
            TaskOrigin.Current.Value = null;
        }
    }

    private static readonly object Unhandled = new();

    private async Task<object?> DispatchAsync(string method, JsonElement args)
    {
        if (method.StartsWith("native.", StringComparison.Ordinal))
            return await (nativePlayback ?? throw new InvalidOperationException("host.Mpv.notInstalled")).DispatchAsync(
                method,
                JsonNode.Parse(args.GetRawText())!.AsObject()
            );
        if (method == "export.reveal")
        {
            var job = jobs.Get(Str(args, "jobId"));
            if (job.Kind != "media.export" || job.State != JobState.Completed || job.ResultJson is null)
                throw new ArgumentException("host.ClientApi.exportIsNotComplete");
            var receipt = JsonSerializer.Deserialize<ExportReceipt>(job.ResultJson, CatalogRepository.Json)!;
            await platform.RevealFileAsync(receipt.Path);
            return true;
        }
        if (method.StartsWith("export.", StringComparison.Ordinal))
            return await exports.DispatchAsync(method, args);
        if (TagRpc.Handles(method))
            return await tags.DispatchAsync(method, JsonNode.Parse(args.GetRawText())!.AsObject());
        if (method.StartsWith("media.identity.", StringComparison.Ordinal))
        {
            if (
                mediaIdentity is null
                || !TagSchemas
                    .Get("media-identity.schema.json")
                    .Evaluate(new JsonObject { ["method"] = method, ["args"] = JsonNode.Parse(args.GetRawText()) })
                    .IsValid
            )
                throw new ArgumentException("host.MediaStructure.invalidOperation");
            var jobId = method switch
            {
                "media.identity.prepare" => await mediaIdentity.IdentifyAsync(Str(args, "filmId"), Str(args, "fileId")),
                "media.identity.preview" => await mediaIdentity.PreviewAsync(
                    Str(args, "filmId"),
                    Str(args, "fileId"),
                    args.GetProperty("revision").GetInt64(),
                    Str(args, "path")
                ),
                "media.identity.commit" => await mediaIdentity.CommitAsync(Str(args, "previewToken")),
                _ => throw new ArgumentException("host.MediaStructure.invalidOperation"),
            };
            return new { jobId };
        }
        if (method.StartsWith("subtitles.", StringComparison.Ordinal))
        {
            if (subtitles is null)
                throw new InvalidOperationException("host.Subtitles.secureStoreUnavailable");
            if (
                !TagSchemas
                    .Get("online-subtitles.schema.json")
                    .Evaluate(new JsonObject { ["method"] = method, ["args"] = JsonNode.Parse(args.GetRawText()) })
                    .IsValid
            )
                throw new ArgumentException("host.Subtitles.invalidSearch");
            return method switch
            {
                "subtitles.account" => await subtitles.AccountAsync(),
                "subtitles.configure" => await subtitles.ConfigureAsync(Optional(args, "apiKey") ?? ""),
                "subtitles.signIn" => await subtitles.SignInAsync(Str(args, "username"), Str(args, "password")),
                "subtitles.signOut" => await subtitles.SignOutAsync(),
                "subtitles.search" => await subtitles.SearchAsync(
                    Str(args, "filmId"),
                    Optional(args, "partId"),
                    Str(args, "query"),
                    Optional(args, "language") ?? "",
                    Int(args, "page", 1)
                ),
                "subtitles.download" => await subtitles.DownloadAsync(
                    Str(args, "ticket"),
                    args.GetProperty("fileId").GetInt64()
                ),
                "subtitles.read" => await subtitles.ReadAsync(
                    Str(args, "filmId"),
                    Str(args, "partId"),
                    Str(args, "fileId")
                ),
                _ => throw new ArgumentException("host.Subtitles.invalidSearch"),
            };
        }
        if (
            method.StartsWith("media.resources.", StringComparison.Ordinal)
            && !TagSchemas
                .Get("media-resources.schema.json")
                .Evaluate(new JsonObject { ["method"] = method, ["args"] = JsonNode.Parse(args.GetRawText()) })
                .IsValid
        )
            throw new ArgumentException("host.MediaStructure.invalidOperation");
        // Each domain answers its own methods and returns Unhandled for the rest.
        foreach (
            var domain in new Func<string, JsonElement, Task<object?>>[]
            {
                CatalogAsync,
                MediaAsync,
                JobsAsync,
                PlatformAsync,
            }
        )
        {
            var result = await domain(method, args);
            if (!ReferenceEquals(result, Unhandled))
                return result;
        }
        throw new ArgumentException("host.ClientApi.unknownClientOperation");
    }

    /// <summary>
    /// One error contract for every RPC: a stable message ID ("error.CODE" for domain codes,
    /// "host.*" for host messages) with arguments. Unexpected exceptions never expose their raw
    /// text; they carry a diagnostic ID that matches the local log entry.
    /// </summary>
    internal static object ErrorEnvelope(Exception ex, string diagnosticId) =>
        ex switch
        {
            TagException tag => new
            {
                ok = false,
                error = "error." + tag.Code,
                code = tag.Code,
                path = tag.Pointer,
            },
            _ when ex.Message.StartsWith("host.", StringComparison.Ordinal) => new
            {
                ok = false,
                error = ex.Message,
                errorArgs = HostMessages.Arguments(ex),
            },
            _ when ErrorIds.Code(ex) is { } code => new
            {
                ok = false,
                error = "error." + code,
                code,
            },
            _ => (object)
                new
                {
                    ok = false,
                    error = "error.unexpected",
                    errorArgs = new { diagnosticId },
                },
        };

    private static T Parse<T>(JsonElement args) =>
        args.Deserialize<T>(CatalogRepository.Json) ?? throw new ArgumentException("host.ClientApi.invalidArguments");

    private static string? Optional(JsonElement args, string key) =>
        args.TryGetProperty(key, out var value) && value.ValueKind != JsonValueKind.Null ? value.GetString() : null;

    private async Task<MediaStructure> PreparePartsAsync(MediaStructure structure)
    {
        // Resource mutations have already committed. Follow-up work failing must not
        // report the mutation as failed and cause the user to add the same files twice.
        try
        {
            if (mediaIdentity is not null)
                await mediaIdentity.CaptureMissingAsync(structure);
            var film = await repository.GetMediaAsync(structure.FilmId);
            var library = (await repository.LibrariesAsync()).FirstOrDefault(l => l.Id == film.LibraryId);
            if (library is not null)
                await scanner.Pipeline.EnqueueAsync(
                    library,
                    structure
                        .Versions.SelectMany(v => v.Parts)
                        .Where(p => p.File.ProbeState == "unknown")
                        .Select(p => new MediaWork(structure.FilmId, p.Id, MediaPipeline.Probe))
                        .ToArray()
                );
        }
        catch (Exception e)
        {
            diagnostics?.Error("media.resources.prepare", e);
        }
        return await repository.ResourcesAsync(structure.FilmId);
    }

    private static string Str(JsonElement args, string key) =>
        Optional(args, key) is { Length: > 0 } value
            ? value
            : throw new ArgumentException("host.ClientApi.missingArgument").Localize(
                "host.ClientApi.missingArgument",
                key
            );

    private static int Int(JsonElement args, string key, int fallback) =>
        args.TryGetProperty(key, out var value) ? value.GetInt32() : fallback;

    private static bool Bool(JsonElement args, string key) =>
        args.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.True;
}
