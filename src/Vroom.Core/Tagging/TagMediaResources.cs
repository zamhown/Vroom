using Vroom.Core.Domain;

namespace Vroom.Core.Tagging;

public sealed partial class TagEngine
{
    public async Task<MediaStructure> ChangeMediaStructureAsync(
        string filmId,
        long revision,
        string operation,
        string id,
        string? name = null,
        IReadOnlyList<string>? order = null,
        CancellationToken ct = default
    )
    {
        await InitializeAsync(ct);
        return await repository.ChangeResourcesAsync(
            filmId,
            revision,
            operation,
            id,
            name,
            order,
            ct,
            db =>
            {
                var c = Current(db);
                foreach (var record in Records(db, filmId).Where(r => r["scope"].Text("kind") != "whole"))
                    ProjectRecord(db, c, record);
            }
        );
    }
}
