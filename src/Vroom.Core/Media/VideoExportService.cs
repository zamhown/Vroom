using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Json.Schema;
using Vroom.Core.Application;
using Vroom.Core.Domain;
using Vroom.Core.Jobs;
using Vroom.Core.Storage;
using Vroom.Core.Tagging;

namespace Vroom.Core.Media;

public sealed record ExportTarget(
    string OutputPath,
    string? FilmId = null,
    string? SourcePath = null,
    string? PartId = null
);

public sealed record ExportRequest(
    ExportTarget[] Targets,
    string PresetName,
    Dictionary<string, string?> Options,
    JsonObject? Preset = null,
    JobSchedule? Schedule = null
);

public sealed record SourceStamp(string Path, long Bytes, long ModifiedTicks, string? TreeHash = null);

public sealed record FrozenExport(
    string JobId,
    string? FilmId,
    string? MediaRevision,
    string Name,
    SourceStamp Source,
    string OutputPath,
    string? PartId = null
);

public sealed record ExportPreview(
    string PreviewToken,
    DateTimeOffset Created,
    string EngineFingerprint,
    string Executable,
    JsonObject Preset,
    Dictionary<string, string?> Options,
    SourceStamp[] Attachments,
    FrozenExport[] Targets,
    JobSchedule Schedule
);

public sealed record ExportReceipt(string Path, long Bytes, string Sha256, string LogPath);

/// <summary>Reviewed immutable exports. Source files and existing destinations are never overwritten.</summary>
public sealed class VideoExportService
{
    private readonly CatalogRepository repository;
    private readonly TagEngine tagging;
    private readonly HandBrakeService handbrake;
    private readonly FfmpegService ffmpeg;
    private readonly JobCoordinator jobs;
    private readonly SemaphoreSlim previewGate = new(1, 1);

    public VideoExportService(
        CatalogRepository repository,
        TagEngine tagging,
        HandBrakeService handbrake,
        FfmpegService ffmpeg,
        JobCoordinator jobs
    )
    {
        this.repository = repository;
        this.tagging = tagging;
        this.handbrake = handbrake;
        this.ffmpeg = ffmpeg;
        this.jobs = jobs;
        jobs.Register("media.export.scan", ScanAsync, canRetry: true);
        jobs.Register(
            "media.export",
            EncodeAsync,
            canPause: true,
            canRetry: true,
            workerClass: "encoding",
            restartOnPause: true
        );
    }

    public async Task<object?> DispatchAsync(string method, JsonElement args, CancellationToken ct = default)
    {
        if (method == "export.preview")
        {
            var result = Json.Schema.JsonSchema.FromText(TagResources.Read("media-export.schema.json")).Evaluate(args);
            if (!result.IsValid)
                throw new ArgumentException("host.VideoExportService.exportRequestDoesNotMatchMediaExport");
        }
        T Parse<T>() =>
            args.Deserialize<T>(CatalogRepository.Json)
            ?? throw new ArgumentException("host.VideoExportService.invalidExportArguments");
        string Str(string key) => args.GetProperty(key).GetString() ?? throw new ArgumentException(key);
        return method switch
        {
            "export.capabilities" => new
            {
                engine = await handbrake.DescribeAsync(args.TryGetProperty("refresh", out var r) && r.GetBoolean(), ct),
                contract = TagResources.Json("media-export.json"),
                presets = await PresetsAsync(ct),
            },
            "export.scan" => new
            {
                jobId = await StartScanAsync(
                    args.TryGetProperty("filmId", out var f) ? f.GetString() : null,
                    args.TryGetProperty("sourcePath", out var p) ? p.GetString() : null,
                    ct,
                    args.TryGetProperty("partId", out var part) ? part.GetString() : null
                ),
            },
            "export.encoder" => await handbrake.EncoderOptionsAsync(Str("encoder"), ct),
            "export.preset.resolve" => await handbrake.PresetAsync(
                Str("presetName"),
                args.TryGetProperty("preset", out var preset) && preset.ValueKind == JsonValueKind.Object
                    ? preset.Deserialize<JsonObject>()
                    : null,
                args.TryGetProperty("options", out var overrides)
                    ? overrides.Deserialize<Dictionary<string, string?>>() ?? new()
                    : new(),
                ct
            ),
            "export.preview" => await PreviewAsync(Parse<ExportRequest>(), ct),
            "export.commit" => await CommitAsync(Str("previewToken"), ct),
            "export.preset.save" => await SavePresetAsync(
                Str("name"),
                args.GetProperty("preset").Deserialize<JsonObject>()!,
                ct
            ),
            "export.preset.delete" => await DeletePresetAsync(Str("name"), ct),
            "export.log" => await LogAsync(Str("jobId"), ct),
            _ => throw new ArgumentException("host.VideoExportService.unknownExportCommand"),
        };
    }

    private async Task<object> PresetsAsync(CancellationToken ct) =>
        await repository.Database.RunAsync(
            db =>
                db.Scalar("SELECT value FROM settings WHERE key='export.presets'") is string json
                    ? JsonNode.Parse(json)!.AsObject()
                    : new JsonObject(),
            ct
        );

    private async Task<bool> SavePresetAsync(string name, JsonObject preset, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(name) || name.Length > 160)
            throw new ArgumentException("host.VideoExportService.presetNameIsRequiredMaximum160Characters");
        HandBrakeService.ValidatePreset(preset);
        await repository.Database.RunAsync(
            db =>
            {
                using var tx = db.BeginTransaction();
                var presets = db.Scalar("SELECT value FROM settings WHERE key='export.presets'") is string json
                    ? JsonNode.Parse(json)!.AsObject()
                    : new JsonObject();
                if (presets.Count >= 100 && !presets.ContainsKey(name))
                    throw new ArgumentException("host.VideoExportService.maximum100UserPresets");
                presets[name] = preset.DeepClone();
                db.Execute(
                    "INSERT INTO settings VALUES('export.presets',@value) ON CONFLICT(key) DO UPDATE SET value=@value",
                    ("@value", presets.ToJsonString())
                );
                tx.Commit();
            },
            ct
        );
        await repository.AuditAsync("export.preset.save", name, ct);
        return true;
    }

    private async Task<bool> DeletePresetAsync(string name, CancellationToken ct)
    {
        await repository.Database.RunAsync(
            db =>
            {
                var presets = db.Scalar("SELECT value FROM settings WHERE key='export.presets'") is string json
                    ? JsonNode.Parse(json)!.AsObject()
                    : new JsonObject();
                presets.Remove(name);
                db.Execute(
                    "UPDATE settings SET value=@value WHERE key='export.presets'",
                    ("@value", presets.ToJsonString())
                );
            },
            ct
        );
        await repository.AuditAsync("export.preset.delete", name, ct);
        return true;
    }

    public async Task<string> StartScanAsync(
        string? filmId,
        string? sourcePath,
        CancellationToken ct = default,
        string? partId = null
    )
    {
        var source = await ResolveSourceAsync(filmId, sourcePath, ct, partId);
        return await jobs.StartAsync(
            "media.export.scan",
            "host.VideoExportService.handbrakeScanSourceMedia",
            new { source = source.Stamp },
            "handbrake.scan:" + PathKey(source.Stamp.Path)
        );
    }

    private async Task<object?> ScanAsync(JobContext context, JsonElement payload)
    {
        var source = payload.GetProperty("source").Deserialize<SourceStamp>(CatalogRepository.Json)!;
        await CheckStampAsync(source, context.CancellationToken);
        var capabilities = await handbrake.DescribeAsync(ct: context.CancellationToken);
        JsonObject? titles = null;
        await context.ReportAsync(0, null, "host.VideoExportService.handbrakeScanningTitlesAudioSubtitlesAndChapters");
        await handbrake.RunAsync(
            capabilities.Executable,
            ["--json", "--scan", "--title", "0", "--min-duration", "0", "--input", source.Path],
            TimeSpan.FromMinutes(10),
            context.CancellationToken,
            obj =>
            {
                if (obj["TitleList"] is JsonArray)
                    titles = obj;
                return Task.CompletedTask;
            }
        );
        return titles ?? throw new IOException("host.VideoExportService.handbrakeDidNotFindAnySourceTitles");
    }

    public async Task<ExportPreview> PreviewAsync(ExportRequest request, CancellationToken ct = default)
    {
        if (
            request.Targets is null
            || request.Targets.Length is < 1 or > 500
            || request.Options is null
            || string.IsNullOrEmpty(request.PresetName)
        )
            throw new ArgumentException("host.VideoExportService.select1500SourceFilesAndA");
        if (request.Schedule?.Priority is < -10 or > 10)
            throw new ArgumentException("host.VideoExportService.priorityMustBeBetween10And10");
        var capabilities = await handbrake.DescribeAsync(ct: ct);
        HandBrakeProtocol.Arguments(request.Options, capabilities.Options);
        var options = new Dictionary<string, string?>(request.Options, StringComparer.Ordinal);
        var attachments = new List<SourceStamp>();
        foreach (var key in new[] { "srt-file", "ssa-file" })
            if (options.TryGetValue(key, out var value) && value is not null)
            {
                var files = value.Split(',').Select(s => Stamp(s.Trim())).ToArray();
                if (files.Any(f => f.TreeHash is not null))
                    throw new ArgumentException("host.VideoExportService.subtitleInputMustBeAFile");
                attachments.AddRange(files);
                options[key] = string.Join(',', files.Select(f => f.Path));
            }
        var preset = await handbrake.PresetAsync(request.PresetName, request.Preset, options, ct);
        var format = options.GetValueOrDefault("format") ?? preset["PresetList"]![0]!["FileFormat"]?.GetValue<string>();
        var extension = format switch
        {
            "av_mp4" => ".mp4",
            "av_mov" => ".mov",
            "av_mkv" => ".mkv",
            "av_webm" => ".webm",
            _ => throw new ArgumentException("host.VideoExportService.unsupportedOutputContainer"),
        };
        var token = Guid.NewGuid().ToString("N");
        var frozen = new List<FrozenExport>();
        var outputs = new HashSet<string>(CatalogRepository.PathComparer);
        foreach (var target in request.Targets)
        {
            ct.ThrowIfCancellationRequested();
            var source = await ResolveSourceAsync(target.FilmId, target.SourcePath, ct, target.PartId);
            var output = OutputPath(target.OutputPath);
            if (
                !string.Equals(Path.GetExtension(output), extension, StringComparison.OrdinalIgnoreCase)
                && !(
                    extension == ".mp4" && Path.GetExtension(output).Equals(".m4v", StringComparison.OrdinalIgnoreCase)
                )
            )
                throw new ArgumentException("host.export.extensionMismatch").Localize(
                    "host.export.extensionMismatch",
                    extension,
                    output
                );
            if (!outputs.Add(output))
                throw new ArgumentException("host.export.duplicateDestination").Localize(
                    "host.export.duplicateDestination",
                    output
                );
            if (
                CatalogRepository.PathComparer.Equals(output, source.Stamp.Path)
                || source.Stamp.TreeHash is not null
                    && output.StartsWith(
                        source.Stamp.Path + Path.DirectorySeparatorChar,
                        OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal
                    )
            )
                throw new ArgumentException("host.VideoExportService.exportDestinationMustBeSeparateFromThe");
            frozen.Add(
                new(
                    token + "-" + frozen.Count,
                    target.FilmId,
                    source.Revision,
                    source.Name,
                    source.Stamp,
                    output,
                    source.PartId
                )
            );
        }
        var preview = new ExportPreview(
            token,
            DateTimeOffset.UtcNow,
            capabilities.Fingerprint,
            capabilities.Executable,
            preset,
            options,
            attachments.ToArray(),
            frozen.ToArray(),
            request.Schedule ?? new()
        );
        await repository.Database.RunAsync(
            db =>
                db.Execute(
                    "INSERT INTO settings VALUES(@key,@value)",
                    ("@key", "export.preview:" + token),
                    ("@value", CatalogRepository.Serialize(preview))
                ),
            ct
        );
        await repository.AuditAsync("export.preview", token + " · " + frozen.Count, ct);
        return preview;
    }

    public async Task<object> CommitAsync(string token, CancellationToken ct = default)
    {
        await previewGate.WaitAsync(ct);
        try
        {
            var preview = await LoadPreviewAsync(token, ct);
            var ids = new List<string>();
            var conflicts = new List<object>();
            // Each frozen target has a deterministic identity. Retrying a partial commit cannot duplicate jobs.
            foreach (var target in preview.Targets)
            {
                if (jobs.Jobs.Any(j => j.Id == target.JobId))
                {
                    ids.Add(target.JobId);
                    continue;
                }
                try
                {
                    await ValidateFrozenAsync(preview, target, ct);
                    ids.Add(
                        await jobs.StartAsync(
                            "media.export",
                            Vroom.Core.Application.UiMessage.Of("host.VideoExportService.export", target.Name),
                            new { previewToken = token, targetId = target.JobId },
                            "export:" + PathKey(target.OutputPath),
                            preview.Schedule,
                            target.JobId
                        )
                    );
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    conflicts.Add(
                        new
                        {
                            targetId = target.JobId,
                            error = ex.Message,
                            errorArgs = HostMessages.Arguments(ex),
                        }
                    );
                }
            }
            await repository.AuditAsync("export.commit", token + " · " + ids.Count, ct);
            return new { jobIds = ids, conflicts };
        }
        finally
        {
            previewGate.Release();
        }
    }

    private async Task<ExportPreview> LoadPreviewAsync(string token, CancellationToken ct) =>
        await repository.Database.RunAsync(
            db =>
                db.Scalar("SELECT value FROM settings WHERE key=@key", ("@key", "export.preview:" + token))
                    is string json
                    ? CatalogRepository.Deserialize<ExportPreview>(json)
                    : throw new KeyNotFoundException("host.VideoExportService.exportPreviewNotFound"),
            ct
        );

    private async Task ValidateFrozenAsync(
        ExportPreview preview,
        FrozenExport target,
        CancellationToken ct,
        bool allowCompleted = false
    )
    {
        var engine = await handbrake.DescribeAsync(refresh: true, ct: ct);
        if (engine.Fingerprint != preview.EngineFingerprint || engine.Executable != preview.Executable)
            throw new InvalidOperationException("host.VideoExportService.handbrakeEngineChangedCreateANewPreview");
        if (
            target.FilmId is { } id
            && TagEngine.MediaRevision(await repository.GetMediaPartAsync(id, target.PartId, ct))
                != target.MediaRevision
        )
            throw new InvalidOperationException("host.VideoExportService.sourceMediaRevisionChangedCreateANew");
        await CheckStampAsync(target.Source, ct);
        foreach (var attachment in preview.Attachments)
            await CheckStampAsync(attachment, ct);
        if (
            !CatalogRepository.PathComparer.Equals(
                ResolvePath(Path.GetDirectoryName(target.OutputPath)!),
                Path.GetDirectoryName(target.OutputPath)
            )
        )
            throw new IOException("host.VideoExportService.destinationDirectoryChanged");
        if (!allowCompleted && (File.Exists(target.OutputPath) || Directory.Exists(target.OutputPath)))
            throw new IOException("host.export.destinationExists").Localize(
                "host.export.destinationExists",
                target.OutputPath
            );
    }

    private async Task<object?> EncodeAsync(JobContext context, JsonElement payload)
    {
        var ct = context.CancellationToken;
        var preview = await LoadPreviewAsync(payload.GetProperty("previewToken").GetString()!, ct);
        var target = preview.Targets.Single(t => t.JobId == payload.GetProperty("targetId").GetString());
        var receipt = context.CheckpointJson is { } checkpoint
            ? CatalogRepository.Deserialize<ExportReceipt>(checkpoint)
            : null;
        await ValidateFrozenAsync(preview, target, ct, receipt is not null);
        if (File.Exists(target.OutputPath))
        {
            if (
                receipt is null
                || receipt.Path != target.OutputPath
                || await HashAsync(target.OutputPath, ct) != receipt.Sha256
            )
                throw new IOException("host.VideoExportService.destinationConflictExistingFileWasPreserved");
            await context.FinishAsync(() => Task.FromResult<object?>(receipt));
            return receipt;
        }
        var work = Path.Combine(Path.GetDirectoryName(target.OutputPath)!, ".vroom-export-" + target.JobId);
        Directory.CreateDirectory(work);
        if (!CatalogRepository.PathComparer.Equals(ResolvePath(work), work))
            throw new IOException("host.VideoExportService.exportWorkDirectoryMustNotBeA");
        // OS-level lease also protects staging files against a second catalog exporting the same preview.
        await using var lease = new FileStream(
            Path.Combine(work, "lock"),
            FileMode.OpenOrCreate,
            FileAccess.ReadWrite,
            FileShare.None
        );
        var staged = Path.Combine(work, "output" + Path.GetExtension(target.OutputPath));
        var presetPath = Path.Combine(work, "preset.json");
        var logs = Path.Combine(repository.Database.DataDirectory, "export-logs");
        Directory.CreateDirectory(logs);
        var logPath = Path.Combine(logs, context.Id + ".log");
        try
        {
            if (File.Exists(staged))
                File.Delete(staged);
            await File.WriteAllTextAsync(presetPath, preview.Preset.ToJsonString(), ct);
            var options = HandBrakeProtocol.Arguments(preview.Options, (await handbrake.DescribeAsync(ct: ct)).Options);
            var argv = new[]
            {
                "--json",
                "--preset-import-file",
                presetPath,
                "--preset",
                "Vroom Frozen",
                "--input",
                target.Source.Path,
                "--output",
                staged,
            }.Concat(options);
            var last = DateTimeOffset.MinValue;
            var workDone = false;
            await context.ReportAsync(0, 10000, "host.VideoExportService.handbrakeEncoding");
            await handbrake.RunAsync(
                preview.Executable,
                argv,
                null,
                ct,
                async obj =>
                {
                    if (obj["State"]?.GetValue<string>() == "WORKDONE")
                        workDone = obj["WorkDone"]?["Error"]?.GetValue<int>() == 0;
                    if (
                        HandBrakeProtocol.Progress(obj) is { } progress
                        && DateTimeOffset.UtcNow - last >= TimeSpan.FromMilliseconds(750)
                    )
                    {
                        last = DateTimeOffset.UtcNow;
                        await context.ReportAsync(
                            progress.Progress,
                            10000,
                            UiMessage.Of("host.export.phase", progress.Telemetry.Phase),
                            progress.Telemetry
                        );
                    }
                },
                logPath
            );
            ct.ThrowIfCancellationRequested();
            if (!workDone || !File.Exists(staged) || new FileInfo(staged).Length == 0)
                throw new IOException("host.VideoExportService.handbrakeDidNotConfirmACompleteExport");
            await context.ReportAsync(9900, 10000, "host.VideoExportService.validatingExportedFile", new("VALIDATING"));
            var probe = await ffmpeg.ProbeAsync(staged, ct);
            if (probe.Width <= 0 || probe.Height <= 0 || probe.Duration <= 0)
                throw new IOException("host.VideoExportService.exportValidationFailedSourceAndExistingFiles");
            await ValidateFrozenAsync(preview, target, ct);
            receipt = new(target.OutputPath, new FileInfo(staged).Length, await HashAsync(staged, ct), logPath);
            // A durable receipt precedes atomic publication, so a crash after rename is recoverable.
            await context.SaveCheckpointAsync(receipt);
            await context.FinishAsync(async () =>
            {
                File.Move(staged, target.OutputPath, overwrite: false);
                await repository.AuditAsync("export.completed", context.Id + " · " + target.OutputPath);
                return receipt;
            });
            return receipt;
        }
        finally
        {
            // Only deterministic files owned by this job are removed; the destination is never deleted.
            await DeleteStagingFileAsync(staged);
            await DeleteStagingFileAsync(presetPath);
        }
    }

    internal static async Task DeleteStagingFileAsync(string path)
    {
        // Windows can briefly retain a sharing lock after an encoder exits. Cleanup must finish
        // even when the operation token is cancelled, without masking cancellation with that race.
        for (var attempt = 0; ; attempt++)
        {
            try
            {
                File.Delete(path);
                return;
            }
            catch (IOException ex) when (attempt < 20 && (ex.HResult & 0xFFFF) is 32 or 33)
            {
                await Task.Delay(50);
            }
        }
    }

    private async Task<(SourceStamp Stamp, string? Revision, string Name, string? PartId)> ResolveSourceAsync(
        string? filmId,
        string? sourcePath,
        CancellationToken ct,
        string? partId
    )
    {
        if (!string.IsNullOrEmpty(filmId))
        {
            if (!string.IsNullOrEmpty(sourcePath))
                throw new ArgumentException("host.VideoExportService.useEitherFilmidOrSourcepath");
            var media = await repository.GetMediaPartAsync(filmId, partId, ct);
            var detail = await tagging.FilmAsync(filmId, ct, partId: partId);
            return (
                await Task.Run(() => Stamp(media.Path), ct),
                TagEngine.MediaRevision(media),
                detail["film"]!["presentation"]!["title"]!.GetValue<string>(),
                media.PartId
            );
        }
        if (string.IsNullOrWhiteSpace(sourcePath))
            throw new ArgumentException("host.VideoExportService.selectASourceFileOrDiscDirectory");
        var stamp = await Task.Run(() => Stamp(sourcePath), ct);
        if (partId is not null)
            throw new ArgumentException("host.MediaStructure.invalidTarget");
        return (stamp, null, Path.GetFileName(stamp.Path), null);
    }

    public static string ResolvePath(string path)
    {
        if (!Path.IsPathFullyQualified(path) || path.Contains('\0'))
            throw new ArgumentException("host.VideoExportService.anAbsoluteLocalPathIsRequired");
        var full = Path.GetFullPath(path);
        var root = Path.GetPathRoot(full)!;
        var current = root;
        foreach (
            var segment in full[root.Length..].Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries)
        )
        {
            current = Path.Combine(current, segment);
            FileSystemInfo info = Directory.Exists(current) ? new DirectoryInfo(current) : new FileInfo(current);
            if (info.LinkTarget is not null)
                current =
                    info.ResolveLinkTarget(true)?.FullName
                    ?? throw new IOException("host.VideoExportService.brokenFilesystemLink");
        }
        return Path.TrimEndingDirectorySeparator(current);
    }

    private static string OutputPath(string path)
    {
        if (!Path.IsPathFullyQualified(path))
            throw new ArgumentException("host.VideoExportService.anAbsoluteDestinationPathIsRequired");
        var file = Path.GetFileName(path);
        if (file.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || file.TrimEnd(' ', '.') != file || file.Length == 0)
            throw new ArgumentException("host.VideoExportService.invalidDestinationFilename");
        var parent = ResolvePath(Path.GetDirectoryName(path)!);
        if (!Directory.Exists(parent))
            throw new DirectoryNotFoundException("host.VideoExportService.chooseAnExistingDestinationDirectory");
        var output = Path.Combine(parent, file);
        if (File.Exists(output) || Directory.Exists(output) || new FileInfo(output).LinkTarget is not null)
            throw new IOException("host.export.destinationExists").Localize("host.export.destinationExists", output);
        return output;
    }

    public static SourceStamp Stamp(string path)
    {
        var resolved = ResolvePath(path);
        if (File.Exists(resolved))
        {
            var info = new FileInfo(resolved);
            return new(resolved, info.Length, info.LastWriteTimeUtc.Ticks);
        }
        if (!Directory.Exists(resolved))
            throw new FileNotFoundException("host.VideoExportService.sourceIsUnavailable", resolved);
        var entries = Directory
            .EnumerateFiles(
                resolved,
                "*",
                new EnumerationOptions
                {
                    RecurseSubdirectories = true,
                    AttributesToSkip = FileAttributes.ReparsePoint,
                    IgnoreInaccessible = false,
                }
            )
            .Take(100001)
            .Order(StringComparer.Ordinal)
            .ToArray();
        if (entries.Length > 100000)
            throw new IOException("host.VideoExportService.sourceDirectoryHasTooManyFiles");
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        long bytes = 0;
        foreach (var entry in entries)
        {
            var info = new FileInfo(entry);
            bytes += info.Length;
            hash.AppendData(
                Encoding.UTF8.GetBytes(entry + "\0" + info.Length + "\0" + info.LastWriteTimeUtc.Ticks + "\n")
            );
        }
        return new(resolved, bytes, 0, Convert.ToHexString(hash.GetHashAndReset()));
    }

    private static async Task CheckStampAsync(SourceStamp source, CancellationToken ct)
    {
        if (await Task.Run(() => Stamp(source.Path), ct) != source)
            throw new InvalidOperationException("host.export.sourceChanged").Localize(
                "host.export.sourceChanged",
                source.Path
            );
    }

    private static async Task<string> HashAsync(string path, CancellationToken ct)
    {
        await using var stream = File.OpenRead(path);
        return Convert.ToHexString(await SHA256.HashDataAsync(stream, ct));
    }

    private static string PathKey(string path) => OperatingSystem.IsWindows() ? path.ToUpperInvariant() : path;

    private async Task<object> LogAsync(string id, CancellationToken ct)
    {
        var job = jobs.Get(id);
        if (job.Kind != "media.export")
            throw new ArgumentException("host.VideoExportService.notAnExportJob");
        var path = Path.Combine(repository.Database.DataDirectory, "export-logs", job.Id + ".log");
        if (!File.Exists(path))
            return new { text = "" };
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        if (stream.Length > 64000)
            stream.Seek(-64000, SeekOrigin.End);
        using var reader = new StreamReader(stream);
        return new { text = await reader.ReadToEndAsync(ct) };
    }
}
