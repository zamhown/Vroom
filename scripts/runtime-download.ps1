# Shared, checksum-gated downloads. Incomplete transfers never replace installed files.
function Get-VerifiedRuntimeFile {
    param([string[]]$Urls, [string]$Destination, [string]$Sha256)
    if ((Test-Path -LiteralPath $Destination) -and (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash -eq $Sha256) {
        Write-Output "Verified cache: $([IO.Path]::GetFileName($Destination))"
        return
    }
    $partial = $Destination + '.partial'
    foreach ($url in $Urls) {
        Write-Output "Downloading: $url"
        & curl.exe --fail --location --silent --show-error --connect-timeout 30 --max-time 1800 --speed-time 30 --speed-limit 1024 --retry 2 --retry-all-errors --retry-delay 2 --output $partial $url
        if ($LASTEXITCODE -ne 0) {
            Write-Warning 'Transfer failed or stalled; trying the next configured source.'
            continue
        }
        if ((Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash -ne $Sha256) {
            throw "SHA-256 mismatch: $([IO.Path]::GetFileName($Destination)). Nothing was installed."
        }
        Move-Item -LiteralPath $partial -Destination $Destination -Force
        return
    }
    throw "All download sources failed: $([IO.Path]::GetFileName($Destination)). Re-run setup to retry."
}

function Test-RuntimeExecutable {
    param([string]$Executable, [ValidateSet('--version', '-version')][string[]]$Arguments = @('--version'))
    # .NET process I/O works on both Windows PowerShell 5.1 and PowerShell 7.
    # In 5.1, redirecting native stderr with 2>&1 under Stop can throw even for a successful tool.
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $Executable
    $start.Arguments = $Arguments -join ' '
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($start)
    try {
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (!$process.WaitForExit(30000)) { $process.Kill(); throw "Runtime validation timed out: $Executable" }
        $output = $stdout.GetAwaiter().GetResult()
        $errors = $stderr.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw "Runtime validation failed: $Executable`n$errors" }
        $versionOutput = if ($output.Trim()) { $output } else { $errors }
        ($versionOutput -split '\r?\n') | Select-Object -First 1
    } finally { $process.Dispose() }
}
