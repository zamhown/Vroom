namespace Vroom.Core.Application;

// Secrets never enter catalog settings, RPC responses, task payloads or diagnostics.
public interface ISecretStore
{
    bool Available { get; }
    Task<string?> GetAsync(string key);
    Task SetAsync(string key, string? value);
}

public sealed class UnavailableSecretStore : ISecretStore
{
    public bool Available => false;

    public Task<string?> GetAsync(string key) => Task.FromResult<string?>(null);

    public Task SetAsync(string key, string? value) =>
        throw new InvalidOperationException("host.Subtitles.secureStoreUnavailable");
}
