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
        await MainThread.InvokeOnMainThreadAsync(async () =>
            (IReadOnlyList<string>)
                ((await FilePicker.Default.PickMultipleAsync()) ?? []).Select(file => file.FullPath).ToArray()
        );

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
        // UIDocumentPicker in folder mode; security-scoped access is started so later scans can read it.
        return await MainThread.InvokeOnMainThreadAsync(async () =>
        {
            var completion = new TaskCompletionSource<string?>();
            var picker = new UIKit.UIDocumentPickerViewController([UniformTypeIdentifiers.UTTypes.Folder], false)
            {
                AllowsMultipleSelection = false,
            };
            picker.DidPickDocumentAtUrls += (_, e) =>
            {
                var url = e.Urls.FirstOrDefault();
                url?.StartAccessingSecurityScopedResource();
                completion.TrySetResult(url?.Path);
            };
            picker.WasCancelled += (_, _) => completion.TrySetResult(null);
            var controller = Platform.GetCurrentUIViewController();
            if (controller is null)
                return null;
            await controller.PresentViewControllerAsync(picker, true);
            return await completion.Task;
        });
#else
        await Task.CompletedTask;
        return null;
#endif
    }

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
