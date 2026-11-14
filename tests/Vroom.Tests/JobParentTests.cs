using Vroom.Core.Domain;
using Vroom.Core.Jobs;

namespace Vroom.Tests;

public sealed partial class TaggingTests
{
    [Fact]
    public async Task TasksStartedByAnotherTaskRecordTheirParent()
    {
        await using var jobs = new JobCoordinator(db);
        string? child = null;
        jobs.Register("fixture.child", (_, _) => Task.FromResult<object?>(null));
        jobs.Register(
            "fixture.parent",
            async (_, _) =>
            {
                child = await jobs.StartAsync("fixture.child", "fixture");
                return null;
            }
        );
        await jobs.InitializeAsync();
        var parent = await jobs.WaitAsync(await jobs.StartAsync("fixture.parent", "fixture"));
        Assert.Equal(JobState.Completed, parent.State);
        Assert.Equal(parent.Id, (await jobs.WaitAsync(child!)).ParentId);
        Assert.Null(parent.ParentId);
    }
}
