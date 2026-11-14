using System.Text.Json.Nodes;
using Vroom.Core.Storage;

namespace Vroom.Core.Tagging;

public sealed partial class TagEngine
{
    public async Task SaveViewAsync(JsonObject args, CancellationToken ct = default)
    {
        await InitializeAsync(ct);
        await repository.Database.RunAsync(
            db =>
            {
                var id = args.Text("id");
                var name = args.Text("name").Trim();
                if (id.Length is 0 or > 160 || name.Length is 0 or > 200)
                    throw new TagException("VIEW_NAME_REQUIRED");
                var query = args["query"] as JsonObject ?? throw new TagException("QUERY_REQUIRED");
                var c = Current(db);
                var (_, compiler) = CompileQuery(c, query);
                compiler.Order(query);
                compiler.Groups(query);
                db.Execute(
                    "INSERT INTO views VALUES(@id,@n,@p) ON CONFLICT(id) DO UPDATE SET name=@n,query=@p",
                    ("@id", id),
                    ("@n", name),
                    ("@p", query.ToJsonString())
                );
            },
            ct
        );
    }

    public async Task<string?> ImagePathAsync(string id, CancellationToken ct = default)
    {
        var detail = await FilmAsync(id, ct);
        var image = detail["film"]?["presentation"].Text("image");
        return image?.StartsWith("asset:", StringComparison.Ordinal) == true ? AssetPath(image[6..]) : null;
    }

    public string AssetPath(string hash)
    {
        if (hash.Length != 64 || !hash.All(Uri.IsHexDigit))
            throw new TagException("ASSET_INVALID");
        return Path.Combine(repository.Database.DataDirectory, "tag-assets", hash.ToLowerInvariant());
    }
}
