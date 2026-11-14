using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Vroom.Core.Domain;

/// <summary>Order-independent JSON form used for content hashes and revision stamps across layers.</summary>
public static class CanonicalJson
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web) { WriteIndented = false };

    public static string Write(JsonNode? node) =>
        node switch
        {
            JsonObject obj => "{"
                + string.Join(
                    ',',
                    obj.OrderBy(p => p.Key, StringComparer.Ordinal)
                        .Select(p => JsonSerializer.Serialize(p.Key) + ":" + Write(p.Value))
                )
                + "}",
            JsonArray array => "[" + string.Join(',', array.Select(Write)) + "]",
            _ => node?.ToJsonString(Options) ?? "null",
        };

    public static string Hash(JsonNode? node) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(Write(node))));
}

/// <summary>
/// Stamp of the media bytes a part points at. Time-scoped annotations and playback positions bind to it,
/// so a replaced or changed file invalidates them. Owned by the host media model, not by tagging.
/// </summary>
public static class MediaRevisions
{
    public static string Of(Film film) =>
        CanonicalJson.Hash(
            new JsonObject
            {
                ["id"] = film.FileId ?? film.Id,
                ["size"] = film.Size,
                ["modified"] = film.Modified.ToString("O"),
            }
        );
}
