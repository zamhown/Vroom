using System.Text.Json;
using System.Text.Json.Nodes;
using Vroom.Core.Catalog;
using Vroom.Core.Domain;
using Vroom.Core.Intelligence;
using Vroom.Core.Jobs;
using Vroom.Core.Media;
using Vroom.Core.Storage;
using Vroom.Core.Tagging;

namespace Vroom.Core.Application;

public sealed partial class ClientApi
{
    /// <summary>Persistent task requests.</summary>
    private async Task<object?> JobsAsync(string method, JsonElement args)
    {
        switch (method)
        {
            case "job.start":
                return new { jobId = await operations.StartAsync(Str(args, "kind"), args.GetProperty("payload")) };
            case "job.list":
                return jobs.List(Optional(args, "filter"), Int(args, "offset", 0), Int(args, "limit", 50));
            case "job.get":
                return jobs.Get(Str(args, "id"));
            case "job.scheduler":
                return jobs.Policy;
            case "job.configure":
                await jobs.ConfigureAsync(Parse<SchedulerPolicy>(args));
                return jobs.Policy;
            case "job.schedule":
                await jobs.ScheduleAsync(
                    Str(args, "id"),
                    args.GetProperty("schedule").Deserialize<JobSchedule>(CatalogRepository.Json)!
                );
                return true;
            case "job.events":
                return await jobs.EventsAsync(Str(args, "id"));
            case "job.pause":
                await jobs.PauseAsync(Str(args, "id"));
                return true;
            case "job.resume":
                await jobs.ResumeAsync(Str(args, "id"));
                return true;
            case "job.stop":
                await jobs.StopAsync(Str(args, "id"));
                return true;
            default:
                return Unhandled;
        }
    }
}
