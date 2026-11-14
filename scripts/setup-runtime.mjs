import { flags, run, root } from './lib/process.mjs';
import { resolvePowerShell, powershellArguments, powershellEnvironment } from './lib/powershell.mjs';
import path from 'node:path';
const options = flags(['--skip-model']);
if (process.platform === 'win32') {
  if (process.arch !== 'x64') throw new Error('The bundled Windows FFmpeg runtime currently requires x64 Node.');
  run(
    resolvePowerShell(),
    powershellArguments(
      path.join(root, 'scripts/setup-runtime.ps1'),
      options.has('--skip-model') ? ['-SkipModel'] : [],
    ),
    { env: powershellEnvironment() },
  );
} else if (['darwin', 'linux'].includes(process.platform)) {
  run('bash', [path.join(root, 'scripts/setup-runtime.sh'), ...(options.has('--skip-model') ? ['--skip-model'] : [])]);
} else throw new Error(`Unsupported runtime platform: ${process.platform}`);
