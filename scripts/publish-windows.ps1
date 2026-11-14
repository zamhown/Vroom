param([ValidateSet('Debug', 'Release')][string]$Configuration = 'Release', [switch]$WithoutModel)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$publishRoot = Join-Path $projectRoot 'artifacts/publish'
$output = Join-Path $publishRoot 'windows-x64'
$staging = Join-Path $publishRoot ('windows-x64.staging-' + [Guid]::NewGuid().ToString('N'))
$backup = Join-Path $publishRoot ('windows-x64.previous-' + [Guid]::NewGuid().ToString('N'))
$runtime = if ($env:VROOM_RUNTIME) { [IO.Path]::GetFullPath($env:VROOM_RUNTIME) } else { Join-Path $projectRoot 'runtime' }

function Assert-PublishPath([string]$Path) {
    $resolved = [IO.Path]::GetFullPath($Path)
    if (![string]::Equals([IO.Path]::GetDirectoryName($resolved), $publishRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to change a path outside the publish directory: $resolved"
    }
    foreach ($candidate in @($projectRoot, (Join-Path $projectRoot 'artifacts'), $publishRoot, $resolved)) {
        if ((Test-Path -LiteralPath $candidate) -and ((Get-Item -LiteralPath $candidate -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Refusing to publish through a filesystem link: $candidate"
        }
    }
}

# Fail before building or touching the last successful output.
$required = @('ffmpeg/ffmpeg.exe', 'ffmpeg/ffprobe.exe', 'ffmpeg/LICENSE', 'handbrake/HandBrakeCLI.exe', 'handbrake/doc', 'mpv/mpv.exe', 'mpv/LICENSE.GPL')
if (!$WithoutModel) { $required += @('models/qwen2.5-0.5b-instruct-q4_k_m.gguf', 'models/LICENSE') }
foreach ($relative in $required) {
    if (!(Test-Path -LiteralPath (Join-Path $runtime $relative))) { throw "Missing runtime/$relative. Run scripts/setup-runtime.ps1 first, or select -WithoutModel." }
}
Assert-PublishPath $staging
Assert-PublishPath $output
Assert-PublishPath $backup
New-Item -ItemType Directory -Force $publishRoot | Out-Null
Push-Location $projectRoot
try {
    & (Join-Path $PSScriptRoot 'build-client.ps1')
    dotnet publish src/Vroom.App -f net10.0-windows10.0.19041.0 -r win-x64 -p:WindowsPackageType=None -c $Configuration -o $staging
    if ($LASTEXITCODE -ne 0) { throw 'Publish failed; the previous output is unchanged.' }
    $runtimeOut = Join-Path $staging 'runtime'
    New-Item -ItemType Directory -Force $runtimeOut | Out-Null
    foreach ($component in @('ffmpeg', 'handbrake', 'mpv')) {
        Copy-Item -LiteralPath (Join-Path $runtime $component) -Destination $runtimeOut -Recurse -Force
    }
    if (!$WithoutModel) { Copy-Item -LiteralPath (Join-Path $runtime 'models') -Destination $runtimeOut -Recurse -Force }
    Copy-Item -LiteralPath (Join-Path $projectRoot 'LICENSE') -Destination $staging
    Copy-Item -LiteralPath (Join-Path $projectRoot 'docs/THIRD-PARTY-NOTICES.md') -Destination $staging
    Copy-Item -LiteralPath (Join-Path $projectRoot 'docs/licenses') -Destination $staging -Recurse
    if (!(Test-Path -LiteralPath (Join-Path $staging 'Vroom.App.exe'))) { throw 'Published executable missing.' }
    Assert-PublishPath $output
    Assert-PublishPath $backup
    if (Test-Path -LiteralPath $output) { Move-Item -LiteralPath $output -Destination $backup }
    try {
        Assert-PublishPath $staging
        Move-Item -LiteralPath $staging -Destination $output
    } catch {
        if (Test-Path -LiteralPath $backup) {
            Assert-PublishPath $backup
            Move-Item -LiteralPath $backup -Destination $output
        }
        throw
    }
    # Retain the previous successful package for manual recovery.
    Write-Output "Published: $output"
    if (Test-Path -LiteralPath $backup) { Write-Output "Previous package retained: $backup" }
} finally { Pop-Location }
