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

public sealed partial class ClientApi
{
    /// <summary>Catalog, film, library, view, settings, maintenance and workspace requests.</summary>
    private async Task<object?> CatalogAsync(string method, JsonElement args)
    {
        switch (method)
        {
            case "bootstrap":
                return new
                {
                    libraries = await repository.LibrariesAsync(),
                    tagging = await tagging.SnapshotAsync(),
                    views = await repository.ViewsAsync(),
                    settings = await repository.SettingsAsync(),
                    mediaBase = media.BaseUrl,
                    jobs = jobs.List("active"),
                    totalFilms = (await tagging.QueryAsync(new() { ["limit"] = 1 }))["total"],
                    tools = tools.Definitions,
                    version = ProductInfo.Version,
                    dataDirectory = repository.Database.DataDirectory,
                    platform = OperatingSystem.IsWindows() ? "windows"
                    : OperatingSystem.IsMacOS() || OperatingSystem.IsMacCatalyst() ? "macos"
                    : "linux",
                    apiVersion = (int)CapabilityContract.Registry.Number("clientApiVersion"),
                };
            case "film.query":
                return await tagging.QueryAsync(JsonNode.Parse(args.GetRawText())!.AsObject());
            case "film.get":
                return await tagging.FilmAsync(Str(args, "id"), partId: Optional(args, "partId"));
            case "film.availability":
                return new
                {
                    available = await media.IsAvailableAsync(Str(args, "id"), partId: Optional(args, "partId")),
                };
            case "film.event":
                var eventType = Str(args, "type");
                if (eventType is not ("playback.started" or "playback.paused" or "playback.seeked"))
                    throw new ArgumentException("host.ClientApi.unsupportedPlaybackEvent");
                await tagging.RecordMediaEventAsync(
                    eventType,
                    Str(args, "id"),
                    JsonNode.Parse(args.GetRawText())!.AsObject(),
                    Optional(args, "eventId")
                );
                return true;
            case "film.position":
                var position = args.GetProperty("position").GetDouble();
                if (!double.IsFinite(position) || position < 0)
                    throw new ArgumentException("host.ClientApi.invalidPlaybackPosition");
                await repository.SavePositionAsync(
                    Str(args, "id"),
                    Optional(args, "partId"),
                    position,
                    Optional(args, "mediaRevision"),
                    ended: Bool(args, "ended")
                );
                await tagging.RecordMediaEventAsync(
                    "playback.position-saved",
                    Str(args, "id"),
                    JsonNode.Parse(args.GetRawText())!.AsObject()
                );
                if (Bool(args, "ended"))
                    await tagging.RecordMediaEventAsync(
                        "playback.ended",
                        Str(args, "id"),
                        JsonNode.Parse(args.GetRawText())!.AsObject(),
                        eventId: Optional(args, "eventId")
                    );
                return true;
            case "library.list":
                return await repository.LibrariesAsync();
            case "library.import":
                return await scanner.ImportAsync(JsonNode.Parse(args.GetRawText())!.AsObject());
            case "library.save":
                await repository.SaveLibraryAsync(Parse<Library>(args));
                return true;
            case "view.list":
                return await repository.ViewsAsync();
            case "films.remove":
                return await tagging.RemoveFilmsAsync(
                    args.GetProperty("ids").EnumerateArray().Select(v => v.GetString()!).ToArray()
                );
            case "library.remove":
                return await tagging.RemoveLibraryAsync(Str(args, "id"));
            case "view.delete":
                await repository.DeleteViewAsync(Str(args, "id"));
                return true;
            case "view.save":
                await tagging.SaveViewAsync(JsonNode.Parse(args.GetRawText())!.AsObject());
                return true;
            case "settings.get":
                return await repository.SettingsAsync();
            case "settings.patch":
                return await repository.PatchSettingsAsync(JsonNode.Parse(args.GetRawText())!.AsObject());
            case "changes.wait":
                return await (
                    changes ?? throw new InvalidOperationException("host.ClientApi.unknownClientOperation")
                ).WaitAsync(
                    args.TryGetProperty("cursor", out var changeCursor) ? changeCursor.GetInt64() : 0,
                    args.TryGetProperty("jobsVersion", out var changeJobs) ? changeJobs.GetInt64() : -1,
                    TimeSpan.FromSeconds(Math.Clamp(Int(args, "timeoutSeconds", 25), 1, 30))
                );
            case "maintenance.run":
                return await (
                    maintenance ?? throw new InvalidOperationException("host.ClientApi.unknownClientOperation")
                ).RunAsync();
            case "maintenance.status":
                return new { databaseBytes = maintenance?.DatabaseBytes() ?? 0 };
            case "runtime.status":
                return MediaRuntime.Resolve(await repository.SettingsAsync());
            case "audit.list":
                return await repository.AuditLogAsync();
            case "tool.call":
                var result = await tools.ExecuteAsync(Str(args, "tool"), args.GetProperty("arguments"), true);
                return JsonSerializer.Deserialize<JsonElement>(result.Json);
            case "workspace.get":
                var saved = await repository.Database.RunAsync(db =>
                    db.Scalar("SELECT value FROM settings WHERE key='workspace'") as string
                );
                return saved is null ? null : JsonNode.Parse(saved)!.AsObject();
            case "workspace.save":
                var json = args.GetRawText();
                // Complete playback/selection snapshots may contain 100,000 IDs. Keep
                // the envelope below the transport limit without truncating a queue.
                if (System.Text.Encoding.UTF8.GetByteCount(json) > 18_000_000)
                    throw new ArgumentException("host.ClientApi.workspaceStateIsTooLarge");
                if (!args.TryGetProperty("version", out var workspaceVersion) || workspaceVersion.GetInt32() != 3)
                    throw new ArgumentException("WORKSPACE_FORMAT_UNSUPPORTED");
                await repository.Database.RunAsync(db =>
                    db.Execute(
                        "INSERT INTO settings VALUES('workspace',@value) ON CONFLICT(key) DO UPDATE SET value=@value",
                        ("@value", json)
                    )
                );
                return true;
            default:
                return Unhandled;
        }
    }
}
