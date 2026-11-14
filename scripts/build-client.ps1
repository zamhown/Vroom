param([switch]$Install)
$ErrorActionPreference='Stop'
$clientRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../src/Vroom.Client'))
Push-Location $clientRoot
try {
    if($Install -or !(Test-Path -LiteralPath 'node_modules/.bin/vite.cmd')) {
        npm ci --no-fund
        if($LASTEXITCODE -ne 0){throw 'React dependencies could not be installed'}
        npm audit --omit=dev --audit-level=high
        if($LASTEXITCODE -ne 0){throw 'Production dependencies have high-severity advisories'}
    }
    if(!(Test-Path -LiteralPath 'node_modules/node/bin/node.exe')) {
        npm rebuild node --no-fund --no-audit
        if($LASTEXITCODE -ne 0){throw 'Project Node runtime could not be initialized'}
    }
    npm run build
    if($LASTEXITCODE -ne 0){throw 'React client build failed'}
} finally {Pop-Location}
