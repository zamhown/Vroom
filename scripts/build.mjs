import { buildHosts, client, flags, requireDependencies, run } from './lib/process.mjs';
const options = flags(['--web']);
requireDependencies();
run('npm', ['run', 'build'], { cwd: client });
buildHosts(options.has('--web') || process.platform === 'linux');
