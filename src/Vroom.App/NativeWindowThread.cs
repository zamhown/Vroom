#if WINDOWS
using System.Collections.Concurrent;
using System.Runtime.InteropServices;

namespace Vroom.App;

/// <summary>A message-pumped owner thread keeps foreign decoder HWND messages off the UI thread.</summary>
internal sealed class NativeWindowThread : IDisposable
{
    private readonly ConcurrentQueue<Action> actions = new();
    private readonly TaskCompletionSource<uint> ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private int disposed;

    public NativeWindowThread()
    {
        new Thread(() =>
        {
            PeekMessage(out _, 0, 0, 0, 0);
            ready.SetResult(GetCurrentThreadId());
            while (GetMessage(out var message, 0, 0, 0) > 0)
            {
                if (message.Id == 0x8001)
                {
                    while (actions.TryDequeue(out var action))
                        action();
                }
                else
                {
                    TranslateMessage(ref message);
                    DispatchMessage(ref message);
                }
            }
        })
        {
            IsBackground = true,
            Name = "Native video windows",
        }.Start();
    }

    public async Task<T> InvokeAsync<T>(Func<T> action)
    {
        ObjectDisposedException.ThrowIf(disposed != 0, this);
        var thread = await ready.Task;
        var result = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        actions.Enqueue(() =>
        {
            try
            {
                result.TrySetResult(action());
            }
            catch (Exception ex)
            {
                result.TrySetException(ex);
            }
        });
        if (!PostThreadMessage(thread, 0x8001, 0, 0))
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        return await result.Task.WaitAsync(TimeSpan.FromSeconds(5));
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposed, 1) == 0 && ready.Task.IsCompletedSuccessfully)
            PostThreadMessage(ready.Task.Result, 0x0012, 0, 0);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Message
    {
        public nint Window;
        public uint Id;
        public nuint WParam;
        public nint LParam;
        public uint Time;
        public int X,
            Y;
        public uint Private;
    }

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool PostThreadMessage(uint thread, uint message, nuint wparam, nint lparam);

    [DllImport("user32.dll")]
    private static extern bool PeekMessage(out Message message, nint window, uint min, uint max, uint flags);

    [DllImport("user32.dll")]
    private static extern int GetMessage(out Message message, nint window, uint min, uint max);

    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref Message message);

    [DllImport("user32.dll")]
    private static extern nint DispatchMessage(ref Message message);
}
#endif
