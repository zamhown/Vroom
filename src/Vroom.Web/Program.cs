using Vroom.Core;
using Vroom.Core.Application;

var builder = WebApplication.CreateBuilder(args);
var address = Environment.GetEnvironmentVariable("VROOM_WEB_URL") ?? "http://127.0.0.1:5248";
if (!Uri.TryCreate(address, UriKind.Absolute, out var listenUri) || listenUri.Scheme != "http" || !listenUri.IsLoopback)
    throw new ArgumentException("host.Program.theWebDevelopmentHostOnlySupportsLoopback");
builder.WebHost.UseUrls(address);
var data =
    Environment.GetEnvironmentVariable("VROOM_DATA")
    ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Vroom");
builder.Services.AddVroom(data);
builder.Services.AddSingleton<IPlatformActions, BrowserPlatformActions>();

// A per-run session secret: loopback alone admits every local user and process. The first visit uses
// the printed URL; it sets a strict HttpOnly cookie that every API and schema request must carry.
var sessionToken = Environment.GetEnvironmentVariable("VROOM_WEB_TOKEN") is { Length: >= 16 } configured
    ? configured
    : Convert.ToHexStringLower(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32));
const string sessionCookie = "vroom-session";
var app = builder.Build();
var diagnostics = app.Services.GetRequiredService<LocalDiagnostics>();
diagnostics.ObserveProcess();
app.Use(
    async (context, next) =>
    {
        if (
            context.Request.Host.Host is not ("127.0.0.1" or "localhost")
            || context.Connection.RemoteIpAddress is null
            || !System.Net.IPAddress.IsLoopback(context.Connection.RemoteIpAddress)
        )
        {
            context.Response.StatusCode = 403;
            return;
        }
        var origin = context.Request.Headers.Origin.ToString();
        if (
            origin.Length > 0
            && (!Uri.TryCreate(origin, UriKind.Absolute, out var uri) || uri.Authority != context.Request.Host.Value)
        )
        {
            context.Response.StatusCode = 403;
            return;
        }
        context.Response.Headers["Referrer-Policy"] = "no-referrer";
        if (context.Request.Query.TryGetValue("token", out var offered))
        {
            if (
                !System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(
                    System.Text.Encoding.UTF8.GetBytes(offered.ToString()),
                    System.Text.Encoding.UTF8.GetBytes(sessionToken)
                )
            )
            {
                context.Response.StatusCode = 401;
                return;
            }
            context.Response.Cookies.Append(
                sessionCookie,
                sessionToken,
                new CookieOptions
                {
                    HttpOnly = true,
                    SameSite = SameSiteMode.Strict,
                    Path = "/",
                }
            );
            context.Response.Redirect(context.Request.Path.HasValue ? context.Request.Path.Value! : "/");
            return;
        }
        var protectedPath =
            context.Request.Path.StartsWithSegments("/api") || context.Request.Path.StartsWithSegments("/schemas");
        if (
            protectedPath
            && !(
                context.Request.Cookies.TryGetValue(sessionCookie, out var presented)
                && System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(
                    System.Text.Encoding.UTF8.GetBytes(presented),
                    System.Text.Encoding.UTF8.GetBytes(sessionToken)
                )
            )
        )
        {
            context.Response.StatusCode = 401;
            return;
        }
        try
        {
            await next();
        }
        catch (Exception ex)
        {
            diagnostics.Error("http", ex);
            if (!context.Response.HasStarted)
                context.Response.StatusCode = 500;
        }
    }
);
app.UseDefaultFiles();
app.UseStaticFiles();
app.MapGet(
    "/schemas/{resource}",
    (string resource) =>
        Vroom.Core.Tagging.TagResources.Names.Contains(resource)
            ? Results.Text(
                Vroom.Core.Tagging.TagResources.Read(resource),
                resource.EndsWith(".json") ? "application/json" : "text/plain"
            )
            : Results.NotFound()
);
app.MapPost(
    "/api/dispatch",
    async (HttpContext context, ClientApi api) =>
    {
        if (!context.Request.HasJsonContentType() || context.Request.Headers["X-Vroom-Client"] != "react")
            return Results.StatusCode(415);
        if (context.Request.ContentLength > 20_000_000)
            return Results.StatusCode(413);
        using var reader = new StreamReader(context.Request.Body);
        return Results.Content(
            await api.RequestAsync(await reader.ReadToEndAsync(context.RequestAborted)),
            "application/json"
        );
    }
);
try
{
    await app.Services.InitializeVroomAsync();
    Console.WriteLine($"Vroom Web host: {listenUri.GetLeftPart(UriPartial.Authority)}/?token={sessionToken}");
}
catch (Exception ex)
{
    diagnostics.Error("startup", ex);
    throw;
}
await app.RunAsync();
