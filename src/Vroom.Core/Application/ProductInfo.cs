using System.Reflection;

namespace Vroom.Core.Application;

/// <summary>Product version from the single MSBuild version source (Directory.Build.props).</summary>
public static class ProductInfo
{
    public static string Version { get; } =
        typeof(ProductInfo)
            .Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()
            ?.InformationalVersion.Split('+')[0]
        ?? "0.0.0";
}
