param([ValidateSet('x64','arm64')][string]$Architecture='x64')
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
. (Join-Path $PSScriptRoot 'runtime-download.ps1')
$projectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$version='0.42.0'
$target=if($Architecture -eq 'arm64'){'aarch64'}else{'x86_64'}
$expected=if($Architecture -eq 'arm64'){'6ea73a506a9c4372b253494c84b1a58d7b2cd09bcd290e4521cddee1f74401c6'}else{'c7d4ff6a67dd33659f71d81efa56335fea2213c7522fd67235f3abf0d9ea1dbd'}
$asset="mpv-v$version-$target-w64-mingw32-full.zip"
$downloads=Join-Path $projectRoot 'runtime/downloads'
$destination=Join-Path $projectRoot 'runtime/mpv'
New-Item -ItemType Directory -Force $downloads,$destination | Out-Null
$archive=Join-Path $downloads $asset
if(!(Test-Path -LiteralPath $archive) -or (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expected){
    Get-VerifiedRuntimeFile -Urls @("https://github.com/mpv-player/mpv/releases/download/v$version/$asset") -Destination $archive -Sha256 $expected
}
Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force
if(!(Test-Path -LiteralPath (Join-Path $destination 'mpv.exe'))){throw 'mpv.exe missing from verified archive.'}
# Keep the GPL notice shipped by upstream beside the executable.
if(!(Test-Path -LiteralPath (Join-Path $destination 'LICENSE.GPL'))){throw 'Upstream license missing.'}
Test-RuntimeExecutable -Executable (Join-Path $destination 'mpv.exe')
Write-Output "mpv $version ($Architecture) verified and installed: $destination"
