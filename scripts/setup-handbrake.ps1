param([ValidateSet('x86_64','aarch64')][string]$Architecture = 'x86_64')
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'runtime-download.ps1')
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimeDir = Join-Path $projectRoot 'runtime/handbrake'
$downloadDir = Join-Path $projectRoot 'runtime/downloads'
$version = '1.11.2'
$hashes = @{ x86_64 = '80bfe8d5f5d11cc3ef76b834add3ed4e82dee6523ffeb435c283f88b1a21f09d'; aarch64 = '708ac040bf1ca41d46dbe5f355b588863d60366a67072a974e6829c314ac060d' }
$name = "HandBrakeCLI-$version-win-$Architecture.zip"
New-Item -ItemType Directory -Force $runtimeDir,$downloadDir | Out-Null
$archive = Join-Path $downloadDir $name
if (!(Test-Path -LiteralPath $archive) -or (Get-FileHash -LiteralPath $archive).Hash -ne $hashes[$Architecture]) {
    Get-VerifiedRuntimeFile -Urls @("https://github.com/HandBrake/HandBrake/releases/download/$version/$name") -Destination $archive -Sha256 $hashes[$Architecture]
}
Expand-Archive -LiteralPath $archive -DestinationPath $runtimeDir -Force
Test-RuntimeExecutable -Executable (Join-Path $runtimeDir 'HandBrakeCLI.exe')
Write-Output "HandBrake runtime ready: $runtimeDir (official archive and license documents retained)"
