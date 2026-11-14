using System.Text.Json.Nodes;
using Vroom.Core.Domain;
using Vroom.Core.Jobs;
using Vroom.Core.Media;
using Vroom.Core.Storage;
using Vroom.Core.Tagging;

namespace Vroom.Tests;

public sealed partial class TaggingTests
{
    private static async Task<JobInfo> WaitIdentityJob(JobCoordinator jobs, string id)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (JobCoordinator.IsActive(jobs.Get(id).State))
            await Task.Delay(15, timeout.Token);
        return jobs.Get(id);
    }

    [Fact]
    public async Task VerifiedMovePreservesWorkPartPositionAndAnnotationHistoryEvenWhenModificationTimeChanges()
    {
        var oldPath = Path.Combine(directory, "before.mp4");
        await File.WriteAllTextAsync(oldPath, "stable byte sequence");
        var info = new FileInfo(oldPath);
        var work = await repo.ImportMediaAsync(
            new()
            {
                LibraryId = "lib",
                Path = oldPath,
                Size = info.Length,
                Modified = info.LastWriteTimeUtc,
                Duration = 30,
            }
        );
        await repo.SavePositionAsync(work.Id, work.PartId, 12);
        var field = await AddDefinition("user.unknown.clock");
        var write = Write(field.Text("key"), JsonValue.Create(42));
        write["subject"]!["id"] = work.Id;
        write["scope"] = new JsonObject
        {
            ["kind"] = "point",
            ["scopeId"] = "clock",
            ["partId"] = work.PartId,
            ["startUs"] = "1000000",
        };
        await Batch(write);
        var original = await db.ReadAsync(c =>
            c.Scalar(
                "SELECT payload FROM tag_heads WHERE subject_id=@id AND tag_key=@key",
                ("@id", work.Id),
                ("@key", field.Text("key"))
            ) as string
        );
        await using var jobs = new JobCoordinator(db);
        var identity = new MediaIdentity(repo, engine, jobs);
        await jobs.InitializeAsync();
        Assert.Equal(
            JobState.Completed,
            (await WaitIdentityJob(jobs, await identity.IdentifyAsync(work.Id, work.FileId!))).State
        );
        await repo.UpdateMediaAsync(work.Id, f => f with { Width = 640 });
        Assert.NotNull((await repo.ResourceFileAsync(work.Id, work.FileId!)).ContentFingerprint);
        var path = Path.Combine(directory, "after.mp4");
        File.Copy(oldPath, path);
        File.SetLastWriteTimeUtc(path, DateTime.UtcNow.AddSeconds(-30));
        File.Delete(oldPath);
        var preview = await WaitIdentityJob(
            jobs,
            await identity.PreviewAsync(work.Id, work.FileId!, work.StructureRevision, path)
        );
        Assert.True(preview.State == JobState.Completed, preview.Error);
        var token = JsonNode.Parse(preview.ResultJson!)!.Text("previewToken");
        var commit = await WaitIdentityJob(jobs, await identity.CommitAsync(token));
        Assert.True(commit.State == JobState.Completed, commit.Error);
        var current = await repo.GetMediaAsync(work.Id);
        Assert.Equal(work.Id, current.Id);
        Assert.Equal(work.FileId, current.FileId);
        Assert.Equal(work.PartId, current.PartId);
        Assert.Equal(path, current.Path);
        Assert.Equal(12, current.Position);
        Assert.Equal(new FileInfo(path).LastWriteTimeUtc, current.Modified.UtcDateTime);
        Assert.Single((await engine.FilmAsync(work.Id)).List("annotations"));
        Assert.Equal(
            original,
            await db.ReadAsync(c =>
                c.Scalar(
                    "SELECT payload FROM tag_history WHERE id=@id AND revision=1",
                    ("@id", JsonNode.Parse(original!)!.Text("id"))
                )
            )
        );
        Assert.Equal(
            2L,
            await db.ReadAsync(c =>
                c.Scalar(
                    "SELECT revision FROM tag_heads WHERE subject_id=@id AND tag_key=@key",
                    ("@id", work.Id),
                    ("@key", field.Text("key"))
                )
            )
        );
        Assert.False(File.Exists(oldPath));
        Assert.True(File.Exists(path));
    }

    [Fact]
    public async Task RelinkRehashesAtCommitAndRejectsAChangedFileEvenWithTheSameLengthAndTimestamp()
    {
        var path = Path.Combine(directory, "identity.mp4");
        await File.WriteAllTextAsync(path, "original bytes");
        var info = new FileInfo(path);
        var work = await repo.ImportMediaAsync(
            new()
            {
                LibraryId = "lib",
                Path = path,
                Size = info.Length,
                Modified = info.LastWriteTimeUtc,
            }
        );
        var moved = Path.Combine(directory, "copy.mp4");
        File.Copy(path, moved);
        await using var jobs = new JobCoordinator(db);
        var identity = new MediaIdentity(repo, engine, jobs);
        await jobs.InitializeAsync();
        var preview = await WaitIdentityJob(
            jobs,
            await identity.PreviewAsync(work.Id, work.FileId!, work.StructureRevision, moved)
        );
        Assert.True(preview.State == JobState.Completed, preview.Error);
        var token = JsonNode.Parse(preview.ResultJson!)!.Text("previewToken");
        var stamp = File.GetLastWriteTimeUtc(moved);
        await File.WriteAllTextAsync(moved, "modified bytes");
        File.SetLastWriteTimeUtc(moved, stamp);
        Assert.Equal(JobState.Failed, (await WaitIdentityJob(jobs, await identity.CommitAsync(token))).State);
        Assert.Equal(path, (await repo.GetMediaAsync(work.Id)).Path);
        Assert.True(File.Exists(path));
        Assert.True(File.Exists(moved));
    }
}
