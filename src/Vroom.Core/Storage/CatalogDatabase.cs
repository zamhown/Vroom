using Microsoft.Data.Sqlite;

namespace Vroom.Core.Storage;

// Microsoft.Data.Sqlite performs synchronous I/O even for its Async methods. All database work
// runs off the UI thread. Writes serialize; read-only requests use independent WAL snapshots.
public sealed partial class CatalogDatabase(string dataDirectory) : IDisposable
{
    private readonly SemaphoreSlim gate = new(1, 1);
    private volatile bool initialized;
    public string DataDirectory { get; } = System.IO.Path.GetFullPath(dataDirectory);
    public string DatabasePath => System.IO.Path.Combine(DataDirectory, "catalog.db");

    public Task<T> RunAsync<T>(Func<SqliteConnection, T> action, CancellationToken ct = default) =>
        Task.Run(
            async () =>
            {
                await gate.WaitAsync(ct).ConfigureAwait(false);
                try
                {
                    Directory.CreateDirectory(DataDirectory);
                    using var db = new SqliteConnection(
                        new SqliteConnectionStringBuilder { DataSource = DatabasePath, Pooling = true }.ToString()
                    );
                    db.Open();
                    db.Execute("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
                    if (!initialized)
                    {
                        var version = Convert.ToInt64(db.Scalar("PRAGMA user_version"));
                        var hasTables =
                            Convert.ToInt64(
                                db.Scalar(
                                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
                                )
                            ) > 0;
                        if ((hasTables && version is not (3 or 4)) || (!hasTables && version is not (0 or 4)))
                            throw new InvalidOperationException("CATALOG_FORMAT_UNSUPPORTED");
                        db.Execute("PRAGMA journal_mode=WAL;");
                        if (hasTables && version == 3)
                            UpgradeMediaStructure(db);
                        using var transaction = db.BeginTransaction();
                        db.Execute(Schema);
                        db.Execute(TagSchema);
                        transaction.Commit();
                        initialized = true;
                    }
                    ct.ThrowIfCancellationRequested();
                    return action(db);
                }
                finally
                {
                    gate.Release();
                }
            },
            ct
        );

    public async Task<T> ReadAsync<T>(Func<SqliteConnection, T> action, CancellationToken ct = default)
    {
        if (!initialized)
            await RunAsync(_ => true, ct).ConfigureAwait(false);
        return await Task.Run(
                () =>
                {
                    ct.ThrowIfCancellationRequested();
                    using var db = new SqliteConnection(
                        new SqliteConnectionStringBuilder
                        {
                            DataSource = DatabasePath,
                            Mode = SqliteOpenMode.ReadOnly,
                            Pooling = true,
                        }.ToString()
                    );
                    db.Open();
                    db.Execute("PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN;");
                    try
                    {
                        var result = action(db);
                        db.Execute("COMMIT;");
                        return result;
                    }
                    catch
                    {
                        db.Execute("ROLLBACK;");
                        throw;
                    }
                },
                ct
            )
            .ConfigureAwait(false);
    }

    public Task RunAsync(Action<SqliteConnection> action, CancellationToken ct = default) =>
        RunAsync(
            db =>
            {
                action(db);
                return true;
            },
            ct
        );

    public void Dispose() => gate.Dispose();
}

internal static class SqliteExtensions
{
    public static SqliteCommand Command(
        this SqliteConnection db,
        string sql,
        params (string Name, object? Value)[] parameters
    )
    {
        var cmd = db.CreateCommand();
        cmd.CommandText = sql;
        foreach (var (name, value) in parameters)
            cmd.Parameters.AddWithValue(name, value ?? DBNull.Value);
        return cmd;
    }

    public static int Execute(this SqliteConnection db, string sql, params (string Name, object? Value)[] args)
    {
        using var cmd = db.Command(sql, args);
        return cmd.ExecuteNonQuery();
    }

    public static object? Scalar(this SqliteConnection db, string sql, params (string Name, object? Value)[] args)
    {
        using var cmd = db.Command(sql, args);
        return cmd.ExecuteScalar();
    }
}
