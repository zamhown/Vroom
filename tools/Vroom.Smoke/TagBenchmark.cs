using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;
using Vroom.Core.Domain;
using Vroom.Core.Storage;
using Vroom.Core.Tagging;

internal static class TagBenchmark
{
    // Synthetic fixture loading is deliberately outside the measured operations.
    // Uses a new database every time; it never resets an existing catalog.
    public static async Task RunAsync(string root)
    {
        var reports = new List<object>();
        foreach (var count in new[] { 10_000, 100_000 })
        {
            var path = Path.Combine(root, ".artifacts", "tag-benchmarks", count + "-" + Guid.NewGuid().ToString("N"));
            using var db = new CatalogDatabase(path);
            var repo = new CatalogRepository(db);
            await repo.InitializeAsync();
            await repo.SaveLibraryAsync(new("bench", "Benchmark", [path], [], false));
            var engine = new TagEngine(repo);
            await engine.InitializeAsync();
            var definition = JsonNode
                .Parse(
                    """{"key":"bench.number","revision":1,"enabled":true,"label":{"en":"Index"},"parents":[],"targets":["film-whole"],"value":{"cardinality":"one","schema":{"type":"integer"},"semanticVersion":1},"input":{"component":"number@1"},"placements":[],"query":{"filter":true,"sort":true,"groupBy":["value"]}}"""
                )!
                .AsObject();
            var text = definition.DeepClone().AsObject();
            text["key"] = "bench.text";
            text["value"]!["schema"]!["type"] = "string";
            text["input"]!["component"] = "text@1";
            var reference = definition.DeepClone().AsObject();
            reference["key"] = "bench.people";
            reference["value"] = JsonNode.Parse(
                """{"cardinality":"many","schema":{"type":"object","properties":{"term":{"type":"string"}},"required":["term"],"additionalProperties":false},"vocabulary":"bench.people","semanticVersion":1}"""
            );
            reference["input"]!["component"] = "multi-select@1";
            reference["query"] = JsonNode.Parse("""{"filter":true,"sort":false,"groupBy":["value","member"]}""");
            var changes = new JsonArray(
                new JsonObject
                {
                    ["kind"] = "vocabularies",
                    ["key"] = "bench.people",
                    ["value"] = new JsonObject
                    {
                        ["label"] = TagJson.Localized("People"),
                        ["enabled"] = true,
                        ["items"] = new JsonArray(),
                    },
                }
            );
            foreach (var d in new[] { definition, text, reference })
                changes.Add(
                    new JsonObject
                    {
                        ["kind"] = "definition",
                        ["key"] = d.Text("key"),
                        ["value"] = d.DeepClone(),
                    }
                );
            var snapshot = await engine.SnapshotAsync();
            var policy = snapshot["package"]!["catalogPolicy"]!.DeepClone();
            policy!["defaultSort"] = "bench.number";
            policy["search"] = new JsonObject
            {
                ["fields"] = new JsonArray(
                    new JsonObject { ["tag"] = "bench.text" },
                    new JsonObject { ["tag"] = "bench.people" }
                ),
            };
            changes.Add(
                new JsonObject
                {
                    ["kind"] = "catalogPolicy",
                    ["key"] = "default",
                    ["value"] = policy,
                }
            );
            var preview = await engine.PreviewConfigAsync(new() { ["changes"] = changes });
            await engine.ApplyConfigAsync(new() { ["previewToken"] = preview.Text("previewToken") });
            var generation = (await engine.SnapshotAsync()).Number("generation");
            var term = new JsonObject
            {
                ["id"] = "person.0",
                ["revision"] = 1,
                ["enabled"] = true,
                ["label"] = TagJson.Localized("Person 0", "en"),
                ["vocabularyIds"] = new JsonArray("bench.people"),
            };
            await engine.PutTermAsync(
                new()
                {
                    ["expectedGeneration"] = generation,
                    ["expectedRevision"] = 0,
                    ["term"] = term.DeepClone(),
                }
            );
            var film = await repo.ImportMediaAsync(
                new()
                {
                    Id = "fixture",
                    LibraryId = "bench",
                    Path = Path.Combine(path, "fixture.mp4"),
                    Duration = 60,
                    Size = 100,
                }
            );
            var writes = new JsonArray();
            foreach (var d in new[] { definition, text, reference })
                writes.Add(
                    new JsonObject
                    {
                        ["subject"] = new JsonObject { ["kind"] = "film", ["id"] = film.Id },
                        ["tagKey"] = d.Text("key"),
                        ["value"] =
                            d == reference ? new JsonArray(new JsonObject { ["term"] = "person.0" })
                            : d == text ? JsonValue.Create("Film")
                            : JsonValue.Create(0),
                        ["expectedRevision"] = 0,
                    }
                );
            await engine.BatchAsync(new() { ["expectedGeneration"] = generation, ["writes"] = writes });
            await db.RunAsync(c =>
            {
                using var tx = c.BeginTransaction();
                void Sql(string sql, params (string, object)[] args)
                {
                    using var cmd = c.CreateCommand();
                    cmd.CommandText = sql;
                    foreach (var (k, v) in args)
                        cmd.Parameters.AddWithValue(k, v);
                    cmd.ExecuteNonQuery();
                }
                Sql(
                    "CREATE TEMP TABLE seq(n INTEGER PRIMARY KEY); WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<@n) INSERT INTO seq SELECT x FROM n",
                    ("@n", count)
                );
                Sql(
                    "INSERT INTO films SELECT 'film.'||n,'bench',@path||'/'||n||'.mp4',@path||'/'||n||'.mp4',100,60,@time,NULL,json_set(@payload,'$.id','film.'||n,'$.path',@path||'/'||n||'.mp4') FROM seq",
                    ("@path", path),
                    ("@time", film.Added.ToString("O")),
                    ("@payload", JsonSerializer.Serialize(film, TagJson.Options))
                );
                Sql(
                    "INSERT INTO tag_terms SELECT 'person.'||n,json_set(@term,'$.id','person.'||n,'$.label.values.en','Person '||n) FROM seq WHERE n<=@n",
                    ("@term", term.ToJsonString()),
                    ("@n", count / 10)
                );
                Sql("INSERT OR REPLACE INTO tag_term_catalog SELECT id,payload FROM tag_terms");
                Sql("UPDATE tag_terms_stamp SET stamp=@stamp", ("@stamp", Guid.NewGuid().ToString("N")));
                Sql(
                    """
                    INSERT INTO tag_heads SELECT 'film','film.'||n,'whole',h.tag_key,h.tag_key||'.'||n,1,
                    json_set(h.payload,'$.id',h.tag_key||'.'||n,'$.subject.id','film.'||n,'$.value',
                    CASE h.tag_key WHEN 'bench.number' THEN n WHEN 'bench.text' THEN 'Film '||n ELSE json_array(json_object('term','person.'||(n%@terms))) END)
                    FROM seq CROSS JOIN tag_heads h WHERE h.subject_id='fixture';
                    """,
                    ("@terms", count / 10)
                );
                Sql(
                    "INSERT INTO tag_effective SELECT subject_kind,subject_id,scope_id,tag_key,CASE WHEN json_type(payload,'$.value') IN('array','object') THEN json(json_extract(payload,'$.value')) ELSE json_quote(json_extract(payload,'$.value')) END,revision FROM tag_heads WHERE subject_id!='fixture'"
                );
                Sql(
                    "INSERT INTO tag_history SELECT id,revision,payload FROM tag_heads WHERE subject_id!='fixture'; INSERT INTO tag_scope_index SELECT 'film','film.'||n,'whole','whole',0,0 FROM seq;"
                );
                Sql(
                    "INSERT INTO tag_reference_edges SELECT 'film','film.'||n,'whole','bench.people','person.'||(n%@terms) FROM seq; INSERT INTO tag_raw_references SELECT * FROM tag_reference_edges WHERE subject_id!='fixture';",
                    ("@terms", count / 10)
                );
                tx.Commit();
            });
            async Task<object> Measure(Func<int, Task> operation)
            {
                await operation(-1);
                var timings = new List<double>();
                for (var i = 0; i < 20; i++)
                {
                    var timer = Stopwatch.StartNew();
                    await operation(i);
                    timings.Add(timer.Elapsed.TotalMilliseconds);
                }
                timings.Sort();
                return new
                {
                    samples = 20,
                    medianMs = Math.Round(timings[9], 2),
                    p95Ms = Math.Round(timings[18], 2),
                };
            }
            var list = await Measure(async i =>
            {
                await engine.QueryAsync(
                    new()
                    {
                        ["ignoreDefaultQuery"] = true,
                        ["limit"] = 30,
                        ["offset"] = Math.Max(0, i) * 30,
                    }
                );
            });
            var filter = await Measure(async i =>
            {
                await engine.QueryAsync(
                    new()
                    {
                        ["ignoreDefaultQuery"] = true,
                        ["limit"] = 30,
                        ["where"] = new JsonObject
                        {
                            ["op"] = "gte",
                            ["tag"] = "bench.number",
                            ["value"] = count / 2,
                        },
                    }
                );
            });
            var search = await Measure(async i =>
            {
                var result = await engine.QueryAsync(
                    new()
                    {
                        ["ignoreDefaultQuery"] = true,
                        ["limit"] = 30,
                        ["search"] = "Person 1",
                    }
                );
                if (result.Number("total") == 0)
                    throw new Exception("Search result missing");
            });
            var revision = 1d;
            var rename = await Measure(async i =>
            {
                term["label"] = TagJson.Localized("Renamed " + i, "en");
                var result = await engine.PutTermAsync(
                    new()
                    {
                        ["term"] = term.DeepClone(),
                        ["expectedGeneration"] = generation,
                        ["expectedRevision"] = revision++,
                    }
                );
                if (result.Number("projectedCount") != 0)
                    throw new Exception("Rename unexpectedly projected annotations");
            });
            var publish = await Measure(async i =>
            {
                definition["label"] = TagJson.Localized("Label " + i);
                var p = await engine.PreviewConfigAsync(
                    new()
                    {
                        ["changes"] = new JsonArray(
                            new JsonObject
                            {
                                ["kind"] = "definition",
                                ["key"] = "bench.number",
                                ["value"] = definition.DeepClone(),
                            }
                        ),
                    }
                );
                var result = await engine.ApplyConfigAsync(new() { ["previewToken"] = p.Text("previewToken") });
                generation = result.Number("generation");
                if (result.Number("projectedCount") != 0)
                    throw new Exception("Presentation edit rebuilt annotations");
            });
            var timer = Stopwatch.StartNew();
            definition["value"]!["schema"]!["maximum"] = count / 2;
            var projectionPreview = await engine.PreviewConfigAsync(
                new()
                {
                    ["changes"] = new JsonArray(
                        new JsonObject
                        {
                            ["kind"] = "definition",
                            ["key"] = "bench.number",
                            ["value"] = definition.DeepClone(),
                        }
                    ),
                }
            );
            var projection = await engine.ApplyConfigAsync(
                new() { ["previewToken"] = projectionPreview.Text("previewToken") }
            );
            var report = new
            {
                films = count + 1,
                annotations = (count + 1) * 3,
                terms = count / 10 + 1,
                path,
                list,
                filter,
                search,
                rename,
                publish,
                contractChange = new
                {
                    elapsedMs = Math.Round(timer.Elapsed.TotalMilliseconds, 2),
                    projected = projection.Number("projectedCount"),
                },
                processPeakMiB = Math.Round(Process.GetCurrentProcess().PeakWorkingSet64 / 1048576d, 1),
            };
            reports.Add(report);
            Console.WriteLine(JsonSerializer.Serialize(report));
        }
        await File.WriteAllTextAsync(
            Path.Combine(root, ".artifacts", "tag-benchmark-results.json"),
            JsonSerializer.Serialize(reports, new JsonSerializerOptions { WriteIndented = true })
        );
    }
}
