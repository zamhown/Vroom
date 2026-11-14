using System.Globalization;
using System.Text.Json.Nodes;

namespace Vroom.Core.Media;

/// <summary>Closed input vocabulary shared by the generated bindings and IPC parser.</summary>
public sealed record MpvInput(string Kind, string Key, double X, double Y)
{
    private static readonly Dictionary<string, string> Keys = new()
    {
        ["SPACE"] = " ",
        ["k"] = "k",
        ["j"] = "j",
        ["l"] = "l",
        ["LEFT"] = "ArrowLeft",
        ["RIGHT"] = "ArrowRight",
        ["UP"] = "ArrowUp",
        ["DOWN"] = "ArrowDown",
        ["WHEEL_UP"] = "ArrowUp",
        ["WHEEL_DOWN"] = "ArrowDown",
        [","] = ",",
        ["."] = ".",
        ["m"] = "m",
        ["f"] = "f",
        ["t"] = "t",
        ["i"] = "i",
        ["o"] = "o",
        ["?"] = "?",
        ["ESC"] = "Escape",
        ["TAB"] = "Tab",
    };
    public static string Bindings =>
        string.Join(
            '\n',
            new[]
            {
                "MBTN_LEFT script-message vroom-input click ${mouse-pos/x} ${mouse-pos/y} ${osd-width} ${osd-height}",
                "MBTN_LEFT_DBL script-message vroom-input dblclick ${mouse-pos/x} ${mouse-pos/y} ${osd-width} ${osd-height}",
                "MBTN_RIGHT script-message vroom-input contextmenu ${mouse-pos/x} ${mouse-pos/y} ${osd-width} ${osd-height}",
            }.Concat(Keys.Keys.Select(key => $"{key} script-message vroom-input key {key}"))
        ) + "\n";

    public static MpvInput? Parse(JsonNode? node)
    {
        if (
            node is not JsonArray args
            || args.Count < 3
            || args.Any(v => v is not JsonValue value || !value.TryGetValue<string>(out _))
        )
            return null;
        if (args[0]!.GetValue<string>() != "vroom-input")
            return null;
        var kind = args[1]!.GetValue<string>();
        if (kind == "key")
            return args.Count == 3 && Keys.TryGetValue(args[2]!.GetValue<string>(), out var key)
                ? new(kind, key, 0, 0)
                : null;
        if (kind is not ("click" or "dblclick" or "contextmenu") || args.Count != 6)
            return null;
        var numbers = args.Skip(2)
            .Select(v =>
                double.TryParse(v!.GetValue<string>(), NumberStyles.Float, CultureInfo.InvariantCulture, out var number)
                    ? number
                    : double.NaN
            )
            .ToArray();
        if (numbers.Any(n => !double.IsFinite(n)) || numbers[2] <= 0 || numbers[3] <= 0)
            return null;
        return new(kind, "", Math.Clamp(numbers[0] / numbers[2], 0, 1), Math.Clamp(numbers[1] / numbers[3], 0, 1));
    }
}
