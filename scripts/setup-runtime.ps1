param([switch]$SkipModel,[switch]$SkipFfmpeg,[switch]$SkipHandBrake,[switch]$SkipMpv)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
. (Join-Path $PSScriptRoot 'runtime-download.ps1')
$projectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimeRoot=Join-Path $projectRoot 'runtime'
$modelDir=Join-Path $runtimeRoot 'models'
$mediaDir=Join-Path $runtimeRoot 'ffmpeg'
$downloads=Join-Path $runtimeRoot 'downloads'
New-Item -ItemType Directory -Force $modelDir,$mediaDir,$downloads | Out-Null
if(!$SkipModel){
    $modelFile=Join-Path $modelDir 'qwen2.5-0.5b-instruct-q4_k_m.gguf'
    $expected='74A4DA8C9FDBCD15BD1F6D01D621410D31C6FC00986F5EB687824E7B93D7A9DB'
    if(!(Test-Path -LiteralPath $modelFile) -or (Get-FileHash -LiteralPath $modelFile).Hash -ne $expected){
        Write-Output 'Downloading Qwen 0.5B Q4_K_M (491,400,032 bytes)...'
        Get-VerifiedRuntimeFile -Urls @('https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/9217f5db79a29953eb74d5343926648285ec7e67/qwen2.5-0.5b-instruct-q4_k_m.gguf') -Destination $modelFile -Sha256 $expected
    }
    Get-VerifiedRuntimeFile -Urls @('https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/raw/9217f5db79a29953eb74d5343926648285ec7e67/LICENSE') -Destination (Join-Path $modelDir 'LICENSE') -Sha256 '832dd9e00a68dd83b3c3fb9f5588dad7dcf337a0db50f7d9483f310cd292e92e'
    Write-Output 'Model verified.'
}
if(!$SkipFfmpeg){
    $archive=Join-Path $downloads 'ffmpeg-9.0.2-essentials_build.zip'
    $url='https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip'
    $expectedHash='60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba'
    if (!(Test-Path -LiteralPath $archive) -or (Get-FileHash -LiteralPath $archive).Hash -ne $expectedHash) {
        Write-Output 'Downloading pinned FFmpeg 9.0.2 essentials...'
        Get-VerifiedRuntimeFile -Urls @('https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip', $url) -Destination $archive -Sha256 $expectedHash
    }
    $unpack=Join-Path $downloads 'ffmpeg-9.0.2'
    Expand-Archive -LiteralPath $archive -DestinationPath $unpack -Force
    $ffmpeg=Get-ChildItem -LiteralPath $unpack -Recurse -Filter ffmpeg.exe | Select-Object -First 1
    if(!$ffmpeg){throw 'ffmpeg.exe missing from archive'}
    Copy-Item -LiteralPath $ffmpeg.FullName -Destination (Join-Path $mediaDir 'ffmpeg.exe') -Force
    Copy-Item -LiteralPath (Join-Path $ffmpeg.DirectoryName 'ffprobe.exe') -Destination (Join-Path $mediaDir 'ffprobe.exe') -Force
    $notice=Get-ChildItem -LiteralPath $unpack -Recurse -Filter LICENSE | Select-Object -First 1
    if(!$notice){throw 'FFmpeg license missing from verified archive.'}
    Copy-Item -LiteralPath $notice.FullName -Destination (Join-Path $mediaDir 'LICENSE') -Force
    $readme=Get-ChildItem -LiteralPath $unpack -Recurse -Filter README.txt | Select-Object -First 1
    if($readme){Copy-Item -LiteralPath $readme.FullName -Destination (Join-Path $mediaDir 'README.txt') -Force}
    Test-RuntimeExecutable -Executable (Join-Path $mediaDir 'ffmpeg.exe') -Arguments @('-version')
    Test-RuntimeExecutable -Executable (Join-Path $mediaDir 'ffprobe.exe') -Arguments @('-version')
}
if (!$SkipHandBrake) { & (Join-Path $PSScriptRoot 'setup-handbrake.ps1') }
if (!$SkipMpv) { & (Join-Path $PSScriptRoot 'setup-mpv.ps1') }
Write-Output "Runtime ready: $runtimeRoot"
