import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { root } from './lib/process.mjs';
import { resolvePowerShell, powershellArguments, powershellEnvironment } from './lib/powershell.mjs';

test(
  'runtime downloads retry another source, reuse verified cache and preserve installed files on checksum failure',
  { skip: process.platform !== 'win32' },
  () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vroom-download-test-'));
    try {
      const harness = path.join(directory, 'test.ps1');
      fs.writeFileSync(
        harness,
        `param($Helper, $Directory)
$ErrorActionPreference = 'Stop'
. $Helper
$script:requests = 0
function curl.exe {
    $script:requests++
    $output = $args[[Array]::IndexOf($args, '--output') + 1]
    if ($args[-1] -eq 'https://fixture/fail') { $global:LASTEXITCODE = 22; return }
    $content = if ($args[-1] -eq 'https://fixture/corrupt') { 'corrupt' } else { 'verified fixture' }
    [IO.File]::WriteAllText($output, $content)
    $global:LASTEXITCODE = 0
}
$file = Join-Path $Directory 'runtime.zip'
$sha = '${createHash('sha256').update('verified fixture').digest('hex')}'
Get-VerifiedRuntimeFile -Urls @('https://fixture/fail', 'https://fixture/good') -Destination $file -Sha256 $sha
if ($script:requests -ne 2 -or [IO.File]::ReadAllText($file) -ne 'verified fixture') { throw 'Mirror fallback failed.' }
Get-VerifiedRuntimeFile -Urls @('https://fixture/fail') -Destination $file -Sha256 $sha
if ($script:requests -ne 2) { throw 'Verified cache was downloaded again.' }
[IO.File]::WriteAllText($file, 'preserve installed file')
$rejected = $false
try { Get-VerifiedRuntimeFile -Urls @('https://fixture/corrupt') -Destination $file -Sha256 $sha } catch { $rejected = $true }
if (!$rejected -or [IO.File]::ReadAllText($file) -ne 'preserve installed file') { throw 'Checksum failure replaced installed content.' }
Test-RuntimeExecutable -Executable (Join-Path $env:SystemRoot 'System32/curl.exe')
`,
      );
      const shells = new Set([resolvePowerShell(), resolvePowerShell({ SystemRoot: process.env.SystemRoot })]);
      for (const executable of shells) {
        const result = spawnSync(
          executable,
          powershellArguments(harness, [path.join(root, 'scripts/runtime-download.ps1'), directory]),
          { encoding: 'utf8', env: powershellEnvironment() },
        );
        assert.equal(result.status, 0, executable + '\n' + result.stdout + result.stderr);
        fs.unlinkSync(path.join(directory, 'runtime.zip'));
      }
    } finally {
      // This exact test-owned directory comes from mkdtemp above.
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);
