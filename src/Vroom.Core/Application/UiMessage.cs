using System.Text.Json.Nodes;

namespace Vroom.Core.Application;

/// <summary>Deferred presentation: persist a message ID and values, format in the client's current locale.</summary>
public sealed record UiMessage(string Id, IReadOnlyDictionary<string, object?>? Args = null)
{
    public static implicit operator UiMessage(string id) => new(id);

    public static UiMessage Of(string id, params object?[] args) =>
        new(
            id,
            args.Select((value, index) => (value, index)).ToDictionary(item => "p" + item.index, item => item.value)
        );
}

public static class HostMessages
{
    public static T Localize<T>(this T exception, string id, params object?[] args)
        where T : Exception
    {
        exception.Data["messageArgs"] = UiMessage.Of(id, args).Args;
        return exception;
    }

    public static IReadOnlyDictionary<string, object?>? Arguments(Exception exception) =>
        exception.Data["messageArgs"] as IReadOnlyDictionary<string, object?>;

    public static string Resolve(string id) =>
        LanguagePacks
            .Bundled.Single(p => p["locale"]!.GetValue<string>() == LanguagePacks.DefaultLocale)["messages"]
            ?[id]?.GetValue<string>()
        ?? id;

    public static string Resolve(JsonNode text) =>
        text is JsonValue value && value.TryGetValue<string>(out var id)
            ? Resolve(id)
            : Vroom.Core.Tagging.TagJson.Label(text);
}
