using Vroom.Core.Application;

namespace Vroom.App;

public sealed class NativeSecretStore : ISecretStore
{
    public bool Available => true;

    public Task<string?> GetAsync(string key) => SecureStorage.Default.GetAsync(key);

    public Task SetAsync(string key, string? value)
    {
        if (string.IsNullOrEmpty(value))
        {
            SecureStorage.Default.Remove(key);
            return Task.CompletedTask;
        }
        return SecureStorage.Default.SetAsync(key, value);
    }
}
