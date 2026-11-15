using System.Diagnostics;
using Vroom.Core.Application;

namespace Vroom.App;

public sealed class NativePlatformActions : IPlatformActions
{
    public IReadOnlyList<string> SystemLanguages
    {
        get
        {
#if WINDOWS
            return Windows.System.UserProfile.GlobalizationPreferences.Languages.ToArray();
#elif MACCATALYST
            return Foundation.NSLocale.PreferredLanguages;
#else
            return [System.Globalization.CultureInfo.CurrentUICulture.Name];
#endif
        }
    }

    public async Task<IReadOnlyList<string>> PickFilesAsync() =>
#if MACCATALYST
        await PickDocumentsAsync(false);
#else
        await MainThread.InvokeOnMainThreadAsync(async () =>
            (IReadOnlyList<string>)
                ((await FilePicker.Default.PickMultipleAsync()) ?? []).Select(file => file.FullPath).ToArray()
        );
#endif

    public async Task<string?> PickFolderAsync()
    {
#if WINDOWS
        return await MainThread.InvokeOnMainThreadAsync(async () =>
        {
            var picker = new Windows.Storage.Pickers.FolderPicker();
            picker.FileTypeFilter.Add("*");
            var window = (Microsoft.UI.Xaml.Window)Application.Current!.Windows[0].Handler!.PlatformView!;
            WinRT.Interop.InitializeWithWindow.Initialize(picker, WinRT.Interop.WindowNative.GetWindowHandle(window));
            var folder = await picker.PickSingleFolderAsync();
            return folder?.Path;
        });
#elif MACCATALYST
        return (await PickDocumentsAsync(true)).FirstOrDefault();
#else
        await Task.CompletedTask;
        return null;
#endif
    }

#if MACCATALYST
    private static readonly SemaphoreSlim PickerGate = new(1, 1);

    private static async Task<IReadOnlyList<string>> PickDocumentsAsync(bool folder)
    {
        await PickerGate.WaitAsync();
        try
        {
            // Open in place: a media library must refer to the original file, never a picker cache copy.
            return await MainThread.InvokeOnMainThreadAsync(async () =>
            {
                var completion = new TaskCompletionSource<IReadOnlyList<string>>(
                    TaskCreationOptions.RunContinuationsAsynchronously
                );
                using var picker = new UIKit.UIDocumentPickerViewController(
                    [folder ? UniformTypeIdentifiers.UTTypes.Folder : UniformTypeIdentifiers.UTTypes.Item],
                    false
                )
                {
                    AllowsMultipleSelection = !folder,
                };
                picker.DidPickDocumentAtUrls += (_, e) =>
                {
                    // This direct-distribution host is not sandboxed; normal filesystem/TCC access
                    // persists across launches, without retaining security-scope grants indefinitely.
                    completion.TrySetResult(
                        e.Urls.Where(url => url.IsFileUrl && url.Path is not null).Select(url => url.Path!).ToArray()
                    );
                };
                picker.WasCancelled += (_, _) => completion.TrySetResult([]);
                var controller = Platform.GetCurrentUIViewController();
                if (controller is null)
                    return [];
                await controller.PresentViewControllerAsync(picker, true);
                return await completion.Task;
            });
        }
        finally
        {
            PickerGate.Release();
        }
    }
#endif

    public Task RevealFileAsync(string path) =>
        Task.Run(() =>
        {
#if WINDOWS
            var info = new ProcessStartInfo("explorer.exe") { UseShellExecute = false };
            info.ArgumentList.Add("/select,");
            info.ArgumentList.Add(path);
            Process.Start(info)?.Dispose();
#elif MACCATALYST
            var info = new ProcessStartInfo("/usr/bin/open") { UseShellExecute = false };
            info.ArgumentList.Add("-R");
            info.ArgumentList.Add(path);
            Process.Start(info)?.Dispose();
#else
            // Other desktops: open the containing folder with the default file manager.
            var info = new ProcessStartInfo("xdg-open") { UseShellExecute = false };
            info.ArgumentList.Add(Path.GetDirectoryName(path) ?? path);
            Process.Start(info)?.Dispose();
#endif
        });
}
