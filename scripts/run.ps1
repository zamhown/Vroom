param([switch]$Web, [switch]$Demo)
$ErrorActionPreference = 'Stop'
$arguments = @((Join-Path $PSScriptRoot 'run.mjs'))
if ($Web) { $arguments += '--web' }
if ($Demo) { $arguments += '--demo' }
& node @arguments
if ($LASTEXITCODE -ne 0) { throw 'Vroom launch failed. Run npm run setup first.' }
