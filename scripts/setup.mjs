import { spawnSync } from 'node:child_process';
import { client, flags, root, run } from './lib/process.mjs';
const options = flags(['--skip-runtime', '--skip-model', '--web']);
// Keep the bootstrap process outside node_modules while npm replaces that directory.
run('npm', ['ci', '--no-fund', '--no-audit'], { cwd: client, npmRuntime: process.execPath });
run('dotnet', ['tool', 'restore']);
if (!options.has('--web') && ['win32', 'darwin'].includes(process.platform)) {
  const workload = process.platform === 'win32' ? 'maui-windows' : 'maui-maccatalyst';
  const inventory = spawnSync('dotnet', ['workload', 'list', '--machine-readable'], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
  });
  if (inventory.error) throw inventory.error;
  if (inventory.status !== 0) throw new Error(inventory.stderr || 'Cannot inspect .NET workloads.');
  const { installed } = JSON.parse(inventory.stdout.trim());
  if (!installed.includes(workload) && !installed.includes('maui')) {
    run('dotnet', ['workload', 'install', workload, '--skip-manifest-update']);
  } else console.log(`Desktop workload ready: ${workload}`);
}
if (options.has('--web') || process.platform === 'linux') {
  run('dotnet', ['restore', 'src/Vroom.Web']);
  run('dotnet', ['restore', 'tests/Vroom.Tests']);
} else run('dotnet', ['restore', 'Vroom.sln']);
if (!options.has('--skip-runtime')) {
  run(process.execPath, ['scripts/setup-runtime.mjs', ...(options.has('--skip-model') ? ['--skip-model'] : [])]);
}
console.log('Vroom setup complete. Run npm start (desktop) or npm run start:web.');
