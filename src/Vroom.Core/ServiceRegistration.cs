using Microsoft.Extensions.DependencyInjection;
using Vroom.Core.Application;
using Vroom.Core.Catalog;
using Vroom.Core.Intelligence;
using Vroom.Core.Jobs;
using Vroom.Core.Media;
using Vroom.Core.Storage;
using Vroom.Core.Tagging;

namespace Vroom.Core;

public static class ServiceRegistration
{
    public static IServiceCollection AddVroom(
        this IServiceCollection services,
        string dataDirectory,
        bool allowSourceBrowser = false,
        bool allowExternalPlayers = false
    )
    {
        services.AddSingleton(new CatalogDatabase(dataDirectory));
        services.AddSingleton<LocalDiagnostics>(_ => new LocalDiagnostics(dataDirectory));
        services.AddSingleton<CatalogRepository>();
        services.AddSingleton<FfmpegService>();
        services.AddSingleton<LocalMediaServer>();
        services.AddSingleton<Vroom.Core.Network.NetworkService>();
        services.AddSingleton<Vroom.Core.Network.NetworkRecovery>();
        services.AddSingleton<HandBrakeService>();
        services.AddSingleton<VideoExportService>();
        Microsoft.Extensions.DependencyInjection.Extensions.ServiceCollectionDescriptorExtensions.TryAddSingleton<
            INativeVideoSurface,
            DetachedVideoSurface
        >(services);
        services.AddSingleton<NativeMpvService>();
        Microsoft.Extensions.DependencyInjection.Extensions.ServiceCollectionDescriptorExtensions.TryAddSingleton<
            ISecretStore,
            UnavailableSecretStore
        >(services);
        services.AddSingleton<OnlineSubtitles>();
        services.AddSingleton<MediaIdentity>();
        services.AddSingleton(p => new ExternalPlayers(
            p.GetRequiredService<CatalogRepository>(),
            p.GetRequiredService<TagEngine>(),
            p.GetRequiredService<LocalDiagnostics>(),
            allowExternalPlayers
        ));
        services.AddSingleton<TagEventPump>();
        services.AddSingleton<TagEngine>();
        services.AddSingleton<TagJobs>();
        services.AddSingleton<TagSources>(provider =>
        {
            var network = provider.GetRequiredService<Vroom.Core.Network.NetworkService>();
            return new TagSources(
                provider.GetRequiredService<TagEngine>(),
                new SourceHttpClient(),
                new SourceBrowser(dataDirectory, allowSourceBrowser, routeProvider: network.CaptureProxy),
                network
            );
        });
        services.AddSingleton<TagRpc>();
        services.AddSingleton<SourceSubscriptions>();
        services.AddSingleton<JobCoordinator>();
        services.AddSingleton<CatalogMaintenance>();
        services.AddSingleton<ChangeFeed>();
        services.AddSingleton<LibraryScanner>();
        services.AddSingleton<ILocalModel, LocalModel>();
        services.AddSingleton<AgentTools>();
        services.AddSingleton<LocalAgent>();
        services.AddSingleton<BackgroundOperations>();
        services.AddSingleton<ClientApi>();
        services.AddSingleton<LanguagePacks>();
        return services;
    }

    public static async Task InitializeVroomAsync(this IServiceProvider services, string? runtimePath = null)
    {
        var repo = services.GetRequiredService<CatalogRepository>();
        await repo.InitializeAsync();
        await services.GetRequiredService<Vroom.Core.Network.NetworkService>().InitializeAsync();
        await services.GetRequiredService<TagEngine>().InitializeAsync();
        services.GetRequiredService<TagJobs>();
        if (runtimePath is not null)
            MediaRuntime.Directory = runtimePath;
        await services.GetRequiredService<LocalMediaServer>().StartAsync();
        services.GetRequiredService<BackgroundOperations>();
        services.GetRequiredService<SourceSubscriptions>();
        services.GetRequiredService<VideoExportService>();
        await services.GetRequiredService<JobCoordinator>().InitializeAsync();
        await services.GetRequiredService<TagEngine>().ResumeEventsAsync();
        services.GetRequiredService<TagEventPump>().Start();
        services.GetRequiredService<LibraryScanner>().StartAutoDiscovery();
        services.GetRequiredService<Vroom.Core.Network.NetworkRecovery>().Start();
        services.GetRequiredService<SourceSubscriptions>().Start();
        services.GetRequiredService<CatalogMaintenance>().Start();
    }
}
