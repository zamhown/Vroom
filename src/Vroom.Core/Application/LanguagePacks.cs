using System.Globalization;
using System.Text.Json.Nodes;
using Json.Schema;
using Vroom.Core.Storage;

namespace Vroom.Core.Application;

/// <summary>Data-only language packs. User packs never overwrite installed resources.</summary>
public sealed class LanguagePacks(CatalogDatabase database)
{
    private static string Resource(string name)
    {
        using var stream =
            typeof(LanguagePacks).Assembly.GetManifestResourceStream("Vroom.Localization." + name)
            ?? throw new InvalidOperationException("LANGUAGE_RESOURCE_MISSING");
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }

    public static string DefaultLocale { get; } =
        JsonNode.Parse(Resource("manifest.json"))!["defaultLocale"]!.GetValue<string>();
    public static JsonObject Schema => JsonNode.Parse(Resource("language-pack.schema.json"))!.AsObject();
    private static readonly JsonSchema Contract = JsonSchema.FromText(Resource("language-pack.schema.json"));
    public static IReadOnlyList<JsonObject> Bundled { get; } =
        typeof(LanguagePacks)
            .Assembly.GetManifestResourceNames()
            .Where(name => name.StartsWith("Vroom.Localization.packs.", StringComparison.Ordinal))
            .Select(name => JsonNode.Parse(Resource(name["Vroom.Localization.".Length..]))!.AsObject())
            .ToArray();

    public Task<JsonObject[]> ListAsync() =>
        database.RunAsync(db =>
        {
            using var command = db.CreateCommand();
            command.CommandText = "SELECT value FROM settings WHERE key LIKE 'language.pack.%'";
            using var reader = command.ExecuteReader();
            var result = new List<JsonObject>();
            while (reader.Read())
                result.Add(JsonNode.Parse(reader.GetString(0))!.AsObject());
            return result.ToArray();
        });

    public Task InstallAsync(JsonObject pack)
    {
        Validate(pack);
        var locale = pack["locale"]!.GetValue<string>();
        return database.RunAsync(db =>
            db.Execute(
                "INSERT INTO settings(key,value) VALUES(@key,@value) ON CONFLICT(key) DO UPDATE SET value=@value",
                ("@key", "language.pack." + locale),
                ("@value", pack.ToJsonString())
            )
        );
    }

    public Task RemoveAsync(string locale) =>
        database.RunAsync(db => db.Execute("DELETE FROM settings WHERE key=@key", ("@key", "language.pack." + locale)));

    public static void Validate(JsonObject pack)
    {
        if (
            pack.ToJsonString().Length > 2_000_000
            || !Contract.Evaluate(pack).IsValid
            || string.IsNullOrWhiteSpace(pack["displayName"]!.GetValue<string>())
        )
            throw new ArgumentException("LANGUAGE_PACK_INVALID");
        var locale = pack["locale"]!.GetValue<string>();
        var messages = pack["messages"]!.AsObject();
        if (CultureInfo.GetCultureInfo(locale).Name != locale)
            throw new ArgumentException("LANGUAGE_PACK_LOCALE_INVALID");
        if (Bundled.Any(p => p["locale"]!.GetValue<string>() == locale))
            throw new ArgumentException("LANGUAGE_PACK_BUILTIN");
        var known = Bundled.Single(p => p["locale"]!.GetValue<string>() == DefaultLocale)["messages"]!.AsObject();
        foreach (var (key, value) in messages)
            if (
                !known.ContainsKey(key)
                || value is not JsonValue message
                || !message.TryGetValue<string>(out var text)
                || string.IsNullOrWhiteSpace(text)
            )
                throw new ArgumentException("LANGUAGE_PACK_MESSAGE_INVALID");
    }
}
