namespace Vroom.Core.Application;

public interface IPlatformActions
{
    IReadOnlyList<string> SystemLanguages => [];
    Task<string?> PickFolderAsync();
    Task<IReadOnlyList<string>> PickFilesAsync() => Task.FromResult<IReadOnlyList<string>>([]);
    Task RevealFileAsync(string path);
}

public sealed class BrowserPlatformActions : IPlatformActions
{
    public Task<string?> PickFolderAsync() => Task.FromResult<string?>(null);

    public Task RevealFileAsync(string path) =>
        throw new PlatformNotSupportedException("host.PlatformActions.revealFilesFromTheDesktopApp");
}
