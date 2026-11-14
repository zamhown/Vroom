using System.Text.Json.Nodes;
using Vroom.Core.Application;
using Vroom.Core.Jobs;
using Vroom.Core.Storage;

namespace Vroom.Core.Tagging;

internal sealed record SubscriptionTarget(
    string Kind,
    string Id,
    long Generation,
    long SubjectRevision,
    string ValuesHash,
    IReadOnlyList<string> SourceIds
);

public sealed partial class TagEngine
{
    internal Task<IReadOnlyList<SubscriptionTarget>> DueSubscriptionsAsync(DateTimeOffset now, CancellationToken ct) =>
        repository.Database.ReadAsync<IReadOnlyList<SubscriptionTarget>>(
            db =>
            {
                var c = Current(db);
                var rows = new List<(string Kind, string Id, string Source)>();
                foreach (
                    var source in c
                        .Package.Map("sources")
                        .Where(s => s.Value.Flag("enabled", true) && s.Value?["subscription"] is not null)
                )
                {
                    var configuration = TagJson.Hash(source.Value);
                    var tag = source.Value!["subscription"].Text("enabledTag");
                    rows.AddRange(
                        ReadRows(
                            db,
                            "SELECT e.subject_kind,e.subject_id FROM tag_effective e LEFT JOIN tag_subscriptions s ON s.source_id=@source AND s.subject_kind=e.subject_kind AND s.subject_id=e.subject_id WHERE e.tag_key=@tag AND e.scope_id='whole' AND e.value_json='true' AND (s.next_run IS NULL OR s.next_run<=@now OR s.configuration<>@config) ORDER BY e.subject_kind,e.subject_id LIMIT 100",
                            r => (r.GetString(0), r.GetString(1), source.Key),
                            ("@source", source.Key),
                            ("@tag", tag),
                            ("@now", now.ToString("O")),
                            ("@config", configuration)
                        )
                    );
                }
                var result = new List<SubscriptionTarget>();
                foreach (var kind in rows.GroupBy(r => r.Kind))
                {
                    var groups = kind.GroupBy(r => r.Id).Take(100).ToArray();
                    var values = ValuesForMany(db, c, kind.Key, groups.Select(g => g.Key).ToArray(), "whole");
                    foreach (var subject in groups)
                    {
                        var target = new JsonObject { ["kind"] = kind.Key, ["id"] = subject.Key };
                        var eligible = subject
                            .Where(s =>
                                c.Definitions.Values.Any(d =>
                                    d.Flag("enabled", true)
                                    && AnnotationTargets.Supports(d, kind.Key, "whole")
                                    && c.SubjectIssue(d, target) is null
                                    && d.List("enrichment").Any(r => r.Text("source") == s.Source)
                                )
                            )
                            .Select(s => s.Source)
                            .Distinct()
                            .ToArray();
                        if (eligible.Length > 0)
                            result.Add(
                                new(
                                    kind.Key,
                                    subject.Key,
                                    Generation(db),
                                    kind.Key == "term" ? (long)c.RequireTerm(subject.Key).Number("revision") : 0,
                                    TagJson.Hash(values[subject.Key]),
                                    eligible
                                )
                            );
                    }
                }
                return result;
            },
            ct
        );

    internal Task MarkSubscriptionAsync(
        SubscriptionTarget target,
        DateTimeOffset now,
        string jobId,
        CancellationToken ct
    ) =>
        repository.Database.RunAsync(
            db =>
            {
                using var tx = db.BeginTransaction();
                var c = Current(db);
                if (Generation(db) != target.Generation)
                    return;
                foreach (var id in target.SourceIds)
                {
                    var source = c.Package["sources"]![id]!;
                    var due = now.AddMinutes(source["subscription"].Number("intervalMinutes"));
                    db.Execute(
                        "INSERT INTO tag_subscriptions VALUES(@source,@kind,@id,@config,@next,@job) ON CONFLICT(source_id,subject_kind,subject_id) DO UPDATE SET configuration=@config,next_run=@next,job_id=@job",
                        ("@source", id),
                        ("@kind", target.Kind),
                        ("@id", target.Id),
                        ("@config", TagJson.Hash(source)),
                        ("@next", due.ToString("O")),
                        ("@job", jobId)
                    );
                }
                tx.Commit();
            },
            ct
        );

    internal static void ValidateSubscription(SourceSnapshot snapshot, SubscriptionTarget target)
    {
        if (
            snapshot.Generation != target.Generation
            || snapshot.SubjectRevision != target.SubjectRevision
            || TagJson.Hash(snapshot.Values) != target.ValuesHash
        )
            throw new TagException("STALE_SOURCE_RESULT");
        if (
            !target.SourceIds.Any(id =>
                snapshot.Package["sources"]?[id] is { } source
                && source.Flag("enabled", true)
                && snapshot.Values[source["subscription"].Text("enabledTag")]?["value"]?.ToString() == "true"
            )
        )
            throw new TagException("SUBSCRIPTION_DISABLED");
    }
}

// Scheduling is driven solely by public source declarations and effective annotations.
// Each task freezes one subject and its revision; running jobs never rerun a mutable query.
public sealed class SourceSubscriptions : IDisposable, IAsyncDisposable
{
    private readonly TagEngine engine;
    private readonly JobCoordinator jobs;
    private readonly LocalDiagnostics diagnostics;
    private readonly CancellationTokenSource stop = new();
    private readonly SemaphoreSlim tickGate = new(1, 1);
    private Task? worker;

    public SourceSubscriptions(TagEngine engine, TagSources sources, JobCoordinator jobs, LocalDiagnostics diagnostics)
    {
        this.engine = engine;
        this.jobs = jobs;
        this.diagnostics = diagnostics;
        jobs.Register(
            "sources.subscription",
            async (context, args) =>
            {
                await context.CheckpointAsync();
                var target = CatalogRepository.Deserialize<SubscriptionTarget>(args.GetRawText());
                if (!(await engine.Repository.SettingsAsync(context.CancellationToken)).OnlineMetadata)
                    throw new TagException("SUBSCRIPTION_DISABLED");
                var result = await sources.EnrichSubscriptionAsync(
                    target,
                    context.CancellationToken,
                    message => context.ReportAsync(0, 1, message)
                );
                if (result.HasFailures && !result.Found)
                    throw new JobResultFailure("host.SourceAccess.failed", result);
                await context.ReportAsync(1, 1, "host.Subscriptions.refreshed");
                return result;
            },
            canRetry: true
        );
    }

    public void Start()
    {
        worker ??= RunAsync();
    }

    private async Task RunAsync()
    {
        while (!stop.IsCancellationRequested)
        {
            try
            {
                await TickAsync(DateTimeOffset.UtcNow, stop.Token);
                await Task.Delay(TimeSpan.FromMinutes(1), stop.Token);
            }
            catch (OperationCanceledException) when (stop.IsCancellationRequested)
            {
                break;
            }
            catch (Exception e)
            {
                diagnostics.Error("sources.subscription", e);
                try
                {
                    await Task.Delay(TimeSpan.FromMinutes(1), stop.Token);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
            }
        }
    }

    internal async Task<int> TickAsync(DateTimeOffset now, CancellationToken ct)
    {
        await tickGate.WaitAsync(ct);
        try
        {
            if (!(await engine.Repository.SettingsAsync(ct)).OnlineMetadata)
                return 0;
            await engine.InitializeAsync(ct);
            var targets = await engine.DueSubscriptionsAsync(now, ct);
            var count = 0;
            foreach (var target in targets)
            {
                ct.ThrowIfCancellationRequested();
                var id = await jobs.StartAsync(
                    "sources.subscription",
                    "host.Subscriptions.refresh",
                    target,
                    "subscription:" + target.Kind + ":" + target.Id
                );
                await engine.MarkSubscriptionAsync(target, now, id, ct);
                count++;
            }
            return count;
        }
        finally
        {
            tickGate.Release();
        }
    }

    public void Dispose() => stop.Cancel();

    public async ValueTask DisposeAsync()
    {
        Dispose();
        if (worker is not null)
            await worker;
    }
}
