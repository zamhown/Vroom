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
    /// <summary>Platform, network, diagnostics and language requests.</summary>
    private async Task<object?> PlatformAsync(string method, JsonElement args)
    {
        switch (method)
        {
            case "network.status":
                return network?.Status;
            case "network.check":
                return await (network ?? throw new InvalidOperationException("host.Network.unavailable")).CheckAsync();
            case "diagnostics.write":
                return diagnostics?.Write(
                        Optional(args, "source") ?? "client",
                        Str(args, "message"),
                        Optional(args, "stack"),
                        Optional(args, "tabId")
                    )
                    ?? false;
            case "diagnostics.path":
                return diagnostics?.FilePath;
            case "diagnostics.reveal":
                if (diagnostics is not null)
                {
                    diagnostics.Write("host", "Diagnostics opened");
                    await platform.RevealFileAsync(diagnostics.FilePath);
                }
                return true;
            case "language.state":
                return new { installed = await languages.ListAsync(), systemLanguages = platform.SystemLanguages };
            case "language.schema":
                return LanguagePacks.Schema;
            case "language.install":
                await languages.InstallAsync(JsonNode.Parse(args.GetRawText())!.AsObject());
                return true;
            case "language.remove":
                await languages.RemoveAsync(Str(args, "locale"));
                return true;
            case "platform.pickFolder":
                return await platform.PickFolderAsync();
            case "platform.pickFiles":
                return await platform.PickFilesAsync();
            case "platform.reveal":
                await platform.RevealFileAsync(
                    (await repository.GetMediaPartAsync(Str(args, "id"), Optional(args, "partId"))).Path
                );
                return true;
            default:
                return Unhandled;
        }
    }
}
