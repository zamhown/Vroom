import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolvePowerShell, powershellArguments } from './lib/powershell.mjs';

test(
  'a Windows environment without pwsh can execute scripts with literal arguments',
  { skip: process.platform !== 'win32' },
  () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vroom powershell '));
    try {
      const env = { SystemRoot: process.env.SystemRoot, TEMP: directory, TMP: directory, PATH: '' };
      const executable = resolvePowerShell(env);
      assert.match(executable, /WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i);
      const script = path.join(directory, 'script with spaces.ps1');
      fs.writeFileSync(script, 'param([string]$Value)\nWrite-Output $Value\n');
      const argument = 'spaces $(not_a_command) & literal';
      const result = spawnSync(executable, powershellArguments(script, [argument]), { env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(result.stdout.trim(), argument);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

test('PowerShell discovery handles quoted PATH entries and standard installations outside PATH', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vroom shell discovery '));
  try {
    const onPath = path.join(directory, 'bin with spaces');
    const installed = path.join(directory, 'PowerShell/7');
    fs.mkdirSync(onPath, { recursive: true });
    fs.mkdirSync(installed, { recursive: true });
    fs.writeFileSync(path.join(onPath, 'pwsh.exe'), 'fixture');
    fs.writeFileSync(path.join(installed, 'pwsh.exe'), 'fixture');
    assert.equal(resolvePowerShell({ Path: `"${onPath}"`, ProgramFiles: directory }), path.join(onPath, 'pwsh.exe'));
    assert.equal(resolvePowerShell({ PATH: '', ProgramFiles: directory }), path.join(installed, 'pwsh.exe'));
    assert.throws(() => resolvePowerShell({ PATH: '' }), /No PowerShell installation found/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
