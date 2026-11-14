using Vroom.Core.Application;
using Vroom.Core.Jobs;

namespace Vroom.Tests;

public sealed partial class TaggingTests
{
    [Fact]
    public async Task ChangeFeedReturnsNewEventsAndTaskChangesAndOtherwiseWaitsUntilTimeout()
    {
        await using var jobs = new JobCoordinator(db);
        jobs.Register("fixture.feed", (_, _) => Task.FromResult<object?>(null));
        await jobs.InitializeAsync();
        using var feed = new ChangeFeed(db, jobs);
        var idle = await feed.WaitAsync(long.MaxValue, 0, TimeSpan.FromMilliseconds(200));
        Assert.Empty(idle.Events);
        Assert.Null(idle.Jobs);
        await jobs.WaitAsync(await jobs.StartAsync("fixture.feed", "fixture"));
        var changed = await feed.WaitAsync(long.MaxValue, idle.JobsVersion, TimeSpan.FromSeconds(5));
        Assert.NotNull(changed.Jobs);
        Assert.True(changed.JobsVersion > idle.JobsVersion);
        var events = await feed.WaitAsync(0, changed.JobsVersion, TimeSpan.FromSeconds(5));
        Assert.NotEmpty(events.Events);
        Assert.True(events.Cursor > 0);
    }
}
