using System.Text.Json.Nodes;
using Vroom.Core.Domain;
using Vroom.Core.Storage;

namespace Vroom.Tests;

public sealed class SettingsPatchTests : IAsyncLifetime
{
    private readonly string directory = Path.Combine(
        Path.GetTempPath(),
        "vroom-settings-tests",
        Guid.NewGuid().ToString("N")
    );
    private CatalogDatabase db = null!;
    private CatalogRepository repo = null!;

    public async Task InitializeAsync()
    {
        db = new(directory);
        repo = new(db);
        await repo.InitializeAsync();
    }

    public Task DisposeAsync()
    {
        db.Dispose();
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        Directory.Delete(directory, true);
        return Task.CompletedTask;
    }

    [Fact]
    public async Task SuccessfulSaveNotifiesConsumersOnlyAfterPersistence()
    {
        Vroom.Core.Domain.AppSettings? notified = null;
        repo.SettingsChanged += value => notified = value;
        await repo.PatchSettingsAsync(new() { ["scanIntervalMinutes"] = 12 });
        Assert.Equal(await repo.SettingsAsync(), notified);
        notified = null;
        await Assert.ThrowsAsync<ArgumentException>(() =>
            repo.PatchSettingsAsync(new() { ["scanIntervalMinutes"] = "invalid" })
        );
        Assert.Null(notified);
    }

    [Fact]
    public async Task OnlinePermissionIsDurableAndAnUnrelatedSaveCannotOverwriteIt()
    {
        var original = new AppSettings
        {
            ScanIntervalMinutes = 42,
            MpvPath = "review-mpv",
            ModelPath = "review-model",
        };
        await repo.SaveSettingsAsync(original);
        var enabled = await repo.PatchSettingsAsync(new() { ["onlineMetadata"] = true });
        Assert.Equal(original with { OnlineMetadata = true }, enabled);
        await repo.PatchSettingsAsync(new() { ["scanIntervalMinutes"] = 75 });
        using var reopened = new CatalogDatabase(directory);
        Assert.Equal(enabled with { ScanIntervalMinutes = 75 }, await new CatalogRepository(reopened).SettingsAsync());
    }

    [Fact]
    public async Task ConcurrentPatchesFromIndependentReadersPreserveBothChanges()
    {
        using var otherDb = new CatalogDatabase(directory);
        var other = new CatalogRepository(otherDb);
        await other.InitializeAsync();
        await Task.WhenAll(
            repo.PatchSettingsAsync(new() { ["onlineMetadata"] = true }),
            other.PatchSettingsAsync(new() { ["scanIntervalMinutes"] = 75 })
        );
        var result = await repo.SettingsAsync();
        Assert.True(result.OnlineMetadata);
        Assert.Equal(75, result.ScanIntervalMinutes);
    }

    [Theory]
    [InlineData("{\"onlineMetadata\":true,\"unknownSetting\":1}")]
    [InlineData("{\"onlineMetadata\":\"true\"}")]
    [InlineData("{\"onlineMetadata\":null}")]
    [InlineData("{\"onlineMetadata\":true,\"scanIntervalMinutes\":\"invalid\"}")]
    public async Task InvalidPatchesDoNotPartiallySavePermission(string json)
    {
        var original = await repo.SettingsAsync();
        var error = await Assert.ThrowsAsync<ArgumentException>(() =>
            repo.PatchSettingsAsync(JsonNode.Parse(json)!.AsObject())
        );
        Assert.Equal("host.CatalogRepository.invalidSettingsPatch", error.Message);
        Assert.Equal(original, await repo.SettingsAsync());
    }
}
