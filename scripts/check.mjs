#!/usr/bin/env node
import {
  buildHosts,
  client,
  configureTestRuntime,
  flags,
  formatRepository,
  node,
  requireDependencies,
  run,
} from './lib/process.mjs';

const options = flags(['--install', '--web', '--skip-runtime', '--skip-model', '--require-media']);
if ((options.has('--skip-runtime') || options.has('--skip-model')) && !options.has('--install'))
  throw new Error('--skip-runtime and --skip-model require --install.');
if (options.has('--skip-runtime') && options.has('--require-media'))
  throw new Error('--skip-runtime conflicts with --require-media.');
if (options.has('--install'))
  run(process.execPath, [
    'scripts/setup.mjs',
    ...[...options].filter(flag => ['--web', '--skip-runtime', '--skip-model'].includes(flag)),
  ]);
requireDependencies();
configureTestRuntime(options.has('--require-media'));
run('dotnet', ['tool', 'restore']);
run(node, ['scripts/check-repository.mjs']);
run(node, ['scripts/test-scripts.mjs']);
run(node, ['scripts/sync-branding.mjs', '--check']);
run('dotnet', ['csharpier', 'check', '.']);
formatRepository();
run(node, ['scripts/generate-rpc-methods.mjs', '--check']);
run('npm', ['run', 'check'], { cwd: client });
run('npm', ['run', 'build'], { cwd: client });
run(node, ['scripts/bundle-budget.mjs']);
buildHosts(options.has('--web') || process.platform === 'linux');
run('dotnet', [
  'test',
  'tests/Vroom.Tests',
  '--no-build',
  '-nologo',
  '--logger',
  'trx',
  '--results-directory',
  '.artifacts/test-results',
]);
run(node, ['scripts/e2e-web.mjs']);
console.log('\nAll checks passed.');
