import { readdirSync } from 'node:fs';
import path from 'node:path';
import { flags, node, root, run } from './lib/process.mjs';
import { resolvePowerShell, powershellArguments, powershellEnvironment } from './lib/powershell.mjs';
flags([]);
const scripts = path.join(root, 'scripts');
for (const file of readdirSync(scripts, { recursive: true }).filter(file => file.endsWith('.mjs'))) {
  run(node, ['--check', path.join(scripts, file)]);
}
run(node, [
  '--test',
  ...readdirSync(scripts)
    .filter(name => name.endsWith('.test.mjs'))
    .map(name => path.join(scripts, name)),
]);
if (process.platform === 'win32')
  run(resolvePowerShell(), powershellArguments(path.join(scripts, 'check-powershell.ps1')), {
    env: powershellEnvironment(),
  });
