using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Vroom.Core.Application;
using Vroom.Core.Storage;
using Vroom.Core.Tagging;

namespace Vroom.Core.Media;

public sealed class HandBrakeService(CatalogRepository repository)
{
    private readonly SemaphoreSlim discoveryGate = new(1, 1);
    private HandBrakeCapabilities? cached;

    public async Task<HandBrakeCapabilities> DescribeAsync(bool refresh = false, CancellationToken ct = default)
    {
        var executable = MediaRuntime.Resolve(await repository.SettingsAsync(ct)).HandBrake.Path;
        await discoveryGate.WaitAsync(ct);
        try
        {
            if (!refresh && cached?.Executable == executable)
                return cached;
            var help = await RunAsync(executable, ["--help"], TimeSpan.FromSeconds(30), ct);
            var version = await RunAsync(executable, ["--version"], TimeSpan.FromSeconds(30), ct);
            var presets = await RunAsync(executable, ["--preset-list"], TimeSpan.FromSeconds(30), ct);
            var options = HandBrakeProtocol.ParseHelp(help.Output);
            if (options.Count < 20)
                throw new IOException("host.HandBrakeService.handbrakecliDidNotReturnASupportedOption");
            var list = new List<HandBrakePreset>();
            var category = "";
            foreach (var line in (presets.Output + "\n" + presets.Error).Replace("\r", "").Split('\n'))
            {
                if (Regex.IsMatch(line, @"^[A-Za-z].*/$"))
                    category = line.TrimEnd('/');
                else if (Regex.IsMatch(line, @"^ {4}\S"))
                    list.Add(new(line.Trim(), category));
            }
            var fingerprint = Convert.ToHexString(
                SHA256.HashData(Encoding.UTF8.GetBytes(version.Output + help.Output))
            );
            var labels = TagResources.Json("media-export.json")["fields"]!.AsObject();
            options = options
                .Select(o => labels[o.Key] is JsonObject label ? o with { Label = label.DeepClone().AsObject() } : o)
                .ToArray();
            return cached = new(executable, version.Output.Trim(), fingerprint, options, list);
        }
        finally
        {
            discoveryGate.Release();
        }
    }

    public async Task<JsonObject> PresetAsync(
        string name,
        JsonObject? imported,
        IReadOnlyDictionary<string, string?> options,
        CancellationToken ct
    )
    {
        var capabilities = await DescribeAsync(ct: ct);
        var arguments = new List<string>();
        string? importPath = null;
        try
        {
            if (imported is not null)
            {
                ValidatePreset(imported);
                importPath = Path.Combine(
                    repository.Database.DataDirectory,
                    "handbrake",
                    Guid.NewGuid().ToString("N") + ".json"
                );
                Directory.CreateDirectory(Path.GetDirectoryName(importPath)!);
                await File.WriteAllTextAsync(importPath, imported.ToJsonString(), ct);
                arguments.AddRange(["--preset-import-file", importPath]);
            }
            else if (!capabilities.Presets.Any(p => p.Name == name))
                throw new ArgumentException("host.HandBrakeService.presetIsUnavailableRefreshHandbrakeCapabilities");
            arguments.AddRange(["--preset", name]);
            arguments.AddRange(HandBrakeProtocol.Arguments(options, capabilities.Options));
            arguments.AddRange(["--preset-export", "Vroom Frozen"]);
            var result = await RunAsync(capabilities.Executable, arguments, TimeSpan.FromSeconds(45), ct);
            var preset =
                new HandBrakeJsonReader().Feed(result.Output).FirstOrDefault(p => p["PresetList"] is JsonArray)
                ?? throw new IOException("host.HandBrakeService.handbrakePresetExportFailed");
            ValidatePreset(preset);
            return preset;
        }
        finally
        {
            if (importPath is not null)
                File.Delete(importPath);
        }
    }

    public async Task<Dictionary<string, string[]>> EncoderOptionsAsync(string encoder, CancellationToken ct)
    {
        var capabilities = await DescribeAsync(ct: ct);
        if (!capabilities.Options.Single(o => o.Key == "encoder").Choices.Contains(encoder))
            throw new ArgumentException("host.HandBrakeService.unknownVideoEncoder");
        var result = new Dictionary<string, string[]>();
        foreach (var key in new[] { "encoder-preset", "encoder-tune", "encoder-profile", "encoder-level" })
        {
            var output = await RunAsync(
                capabilities.Executable,
                ["--" + key + "-list", encoder],
                TimeSpan.FromSeconds(20),
                ct
            );
            result[key] = (output.Output + "\n" + output.Error)
                .Replace("\r", "")
                .Split('\n')
                .Where(line => Regex.IsMatch(line, @"^ {4}\S"))
                .Select(line => line.Trim())
                .Distinct()
                .ToArray();
        }
        return result;
    }

    public static void ValidatePreset(JsonObject preset)
    {
        if (preset.ToJsonString().Length > 2_000_000 || preset["PresetList"] is not JsonArray { Count: > 0 } list)
            throw new ArgumentException("host.HandBrakeService.aHandbrakePresetlistJsonDocumentIsRequired");
        var count = 0;
        void Walk(JsonArray items, int depth)
        {
            if (depth > 12)
                throw new ArgumentException("host.HandBrakeService.presetFoldersAreTooDeeplyNested");
            foreach (var node in items.OfType<JsonObject>())
            {
                if (++count > 500 || string.IsNullOrWhiteSpace(node["PresetName"]?.GetValue<string>()))
                    throw new ArgumentException("host.HandBrakeService.invalidPresetNameOrCount");
                if (node["ChildrenArray"] is JsonArray children)
                    Walk(children, depth + 1);
                // External input paths are supplied and frozen separately, never imported through a preset.
                if (
                    node["SubtitleList"] is JsonArray subtitles
                    && subtitles.Any(s =>
                        s?.ToJsonString().Contains("File", StringComparison.OrdinalIgnoreCase) == true
                    )
                )
                    throw new ArgumentException("host.HandBrakeService.addExternalSubtitleFilesInTheSubtitle");
            }
        }
        Walk(list, 0);
    }

    public async Task<ProcessResult> RunAsync(
        string executable,
        IEnumerable<string> arguments,
        TimeSpan? timeout,
        CancellationToken ct,
        Func<JsonObject, Task>? onJson = null,
        string? logPath = null
    )
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        if (timeout is { } duration)
            deadline.CancelAfter(duration);
        var start = new ProcessStartInfo(executable)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            RedirectStandardInput = true,
        };
        foreach (var arg in arguments)
            start.ArgumentList.Add(arg);
        if (OperatingSystem.IsAndroid() || (OperatingSystem.IsIOS() && !OperatingSystem.IsMacCatalyst()))
            throw new PlatformNotSupportedException("host.HandBrakeService.handbrakecliRequiresADesktopHost");
        using var process =
            Vroom.Core.Processes.ChildProcessLifetime.Start(start)
            ?? throw new IOException("host.HandBrakeService.cannotStartHandbrakecli");
        using var ownership = new HandBrakeProcessScope(process);
        process.StandardInput.Close();
        using var registration = deadline.Token.Register(() => FfmpegService.Kill(process));
        using var log = logPath is null ? null : new StreamWriter(logPath, false, Encoding.UTF8) { AutoFlush = true };
        var gate = new SemaphoreSlim(1, 1);
        long logBytes = 0;
        async Task<string> ReadAsync(StreamReader stream, bool parse)
        {
            var tail = new StringBuilder();
            var reader = new HandBrakeJsonReader();
            while (await stream.ReadLineAsync(deadline.Token) is { } line)
            {
                tail.AppendLine(line);
                if (tail.Length > 2_000_000)
                    tail.Remove(0, tail.Length - 1_000_000);
                if (log is not null)
                {
                    await gate.WaitAsync(deadline.Token);
                    try
                    {
                        if (logBytes < 8_000_000)
                        {
                            await log.WriteLineAsync(line);
                            logBytes += Encoding.UTF8.GetByteCount(line) + 1;
                        }
                    }
                    finally
                    {
                        gate.Release();
                    }
                }
                if (parse && onJson is not null)
                    foreach (var obj in reader.Feed(line + "\n"))
                        await onJson(obj);
            }
            return tail.ToString();
        }
        var output = ReadAsync(process.StandardOutput, true);
        var errors = ReadAsync(process.StandardError, false);
        // Drain both pipes concurrently. A parser/log failure must also terminate the child.
        var drains = Task.WhenAll(output, errors);
        foreach (var drain in new[] { output, errors })
            _ = drain.ContinueWith(
                _ => FfmpegService.Kill(process),
                CancellationToken.None,
                TaskContinuationOptions.OnlyOnFaulted,
                TaskScheduler.Default
            );
        try
        {
            await process.WaitForExitAsync(deadline.Token);
            await drains;
            if (process.ExitCode != 0)
                throw new IOException("host.export.engineExited").Localize(
                    "host.export.engineExited",
                    process.ExitCode,
                    errors.Result[^Math.Min(2400, errors.Result.Length)..]
                );
            return new(output.Result, errors.Result);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new TimeoutException("host.HandBrakeService.handbrakeOperationTimedOut");
        }
        finally
        {
            FfmpegService.Kill(process);
            await process.WaitForExitAsync(CancellationToken.None);
            try
            {
                await drains;
            }
            catch (OperationCanceledException) { }
            gate.Dispose();
        }
    }
}

public sealed record ProcessResult(string Output, string Error);
