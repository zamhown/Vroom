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
    /// <summary>Media structure, playback and external player requests.</summary>
    private async Task<object?> MediaAsync(string method, JsonElement args)
    {
        switch (method)
        {
            case "media.resources.get":
                return await repository.ResourcesAsync(Str(args, "filmId"));
            case "media.resources.addVersion":
                return await PreparePartsAsync(
                    await repository.AddVersionAsync(
                        Str(args, "filmId"),
                        args.GetProperty("revision").GetInt64(),
                        Str(args, "name"),
                        args.GetProperty("paths").EnumerateArray().Select(p => p.GetString()!).ToArray()
                    )
                );
            case "media.resources.addSet":
                return await repository.AddResourceSetAsync(
                    Str(args, "filmId"),
                    args.GetProperty("revision").GetInt64(),
                    Str(args, "name"),
                    args.GetProperty("paths").EnumerateArray().Select(p => p.GetString()!).ToArray(),
                    Optional(args, "versionId"),
                    Optional(args, "partId")
                );
            case "media.resources.addFiles":
                return await PreparePartsAsync(
                    await repository.AddResourceFilesAsync(
                        Str(args, "filmId"),
                        args.GetProperty("revision").GetInt64(),
                        Str(args, "targetId"),
                        Bool(args, "parts"),
                        args.GetProperty("paths").EnumerateArray().Select(p => p.GetString()!).ToArray()
                    )
                );
            case "media.resources.change":
                return await tagging.ChangeMediaStructureAsync(
                    Str(args, "filmId"),
                    args.GetProperty("revision").GetInt64(),
                    Str(args, "operation"),
                    Str(args, "id"),
                    Optional(args, "name"),
                    args.TryGetProperty("order", out var resourceOrder)
                        ? resourceOrder.EnumerateArray().Select(p => p.GetString()!).ToArray()
                        : null
                );
            case "media.resources.reveal":
                await platform.RevealFileAsync(
                    (await repository.ResourceFileAsync(Str(args, "filmId"), Str(args, "fileId"))).Path
                );
                return true;
            case "external.players":
                return externalPlayers is null ? Array.Empty<ExternalPlayer>() : await externalPlayers.ListAsync();
            case "external.open":
                return await (
                    externalPlayers ?? throw new InvalidOperationException("host.ExternalPlayers.unavailable")
                ).OpenAsync(Str(args, "filmId"), Optional(args, "partId"), Str(args, "playerId"));
            case "playback.info":
                return await media.InspectAsync(Str(args, "id"), partId: Optional(args, "partId"));
            case "playback.preview":
                if (!TagSchemas.Get("playback-preview.schema.json").Evaluate(JsonNode.Parse(args.GetRawText())).IsValid)
                    throw new ArgumentException("host.Playback.invalidOptions");
                return await media.PreviewAsync(
                    Str(args, "id"),
                    Str(args, "mediaRevision"),
                    args.GetProperty("position").GetDouble(),
                    partId: Optional(args, "partId")
                );
            case "playback.open":
                var at = args.TryGetProperty("start", out var start) ? start.GetDouble() : 0;
                if (
                    args.TryGetProperty("options", out var optionDocument)
                    && !TagSchemas
                        .Get("playback-options.schema.json")
                        .Evaluate(JsonNode.Parse(optionDocument.GetRawText()))
                        .IsValid
                )
                    throw new ArgumentException("host.Playback.invalidOptions");
                var playbackOptions = args.TryGetProperty("options", out var options)
                    ? options.Deserialize<PlaybackOptions>(CatalogRepository.Json) ?? new()
                    : new PlaybackOptions();
                playbackOptions.Validate();
                return Bool(args, "transcode") || playbackOptions.NeedsProcessing
                    ? new
                    {
                        jobId = await media.StartTranscodeAsync(
                            Str(args, "id"),
                            at,
                            Bool(args, "forceEncode"),
                            playbackOptions,
                            Optional(args, "partId")
                        ),
                    }
                    : (object)await media.OpenAsync(Str(args, "id"), false, at, partId: Optional(args, "partId"));
            case "playback.status":
                return media.Status(Str(args, "sessionId"));
            case "playback.stop":
                await media.StopPlaybackAsync(Optional(args, "sessionId"));
                return true;
            default:
                return Unhandled;
        }
    }
}
