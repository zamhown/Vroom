import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const client = path.join(root, 'src/Vroom.Client');
export const projectNode = path.join(
  client,
  'node_modules/node/bin',
  process.platform === 'win32' ? 'node.exe' : 'node',
);
export const node = fs.existsSync(projectNode) ? projectNode : process.execPath;

// Invoke npm's JS entry point directly: no shell expansion of paths or arguments.
function npmCli() {
  const candidates = [process.env.npm_execpath];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const bin = path.join(dir.replace(/^"|"$/g, ''), process.platform === 'win32' ? 'npm.cmd' : 'npm');
    if (!fs.existsSync(bin)) continue;
    candidates.push(
      process.platform === 'win32'
        ? path.join(path.dirname(bin), 'node_modules/npm/bin/npm-cli.js')
        : fs.realpathSync(bin),
    );
  }
  const found = candidates.find(
    candidate => candidate && /npm(?:-cli)?\.(?:c?js)$/.test(candidate) && fs.existsSync(candidate),
  );
  if (!found) throw new Error('npm CLI not found. Install Node.js with npm and add it to PATH.');
  return found;
}

export function run(command, args, options = {}) {
  console.log(`\n> ${command} ${args.join(' ')}`);
  const { npmRuntime = node, ...spawnOptions } = options;
  const executable = command === 'npm' ? npmRuntime : command;
  const parameters = command === 'npm' ? [npmCli(), ...args] : args;
  const result = spawnSync(executable, parameters, { cwd: root, stdio: 'inherit', ...spawnOptions, shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.signal ?? result.status}).`);
}

export function flags(allowed) {
  const args = process.argv.slice(2);
  for (const arg of args)
    if (!allowed.includes(arg)) throw new Error(`Unknown option: ${arg}. Allowed: ${allowed.join(', ')}`);
  return new Set(args);
}

export function requireDependencies() {
  if (!fs.existsSync(projectNode)) throw new Error('Run npm run setup before building or checking.');
}

export function configureTestRuntime(required = false) {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  for (const [key, relative] of Object.entries({
    VROOM_TEST_MPV: `mpv/mpv${suffix}`,
    VROOM_TEST_FFMPEG: `ffmpeg/ffmpeg${suffix}`,
    VROOM_TEST_FFPROBE: `ffmpeg/ffprobe${suffix}`,
    VROOM_TEST_HANDBRAKE: `handbrake/HandBrakeCLI${suffix}`,
  })) {
    const candidate = process.env[key] || path.join(root, 'runtime', relative);
    if (fs.existsSync(candidate)) process.env[key] = candidate;
    else if (required || process.env[key]) throw new Error(`${key}: executable missing. Run npm run setup.`);
  }
}

export function buildHosts(webOnly = process.platform === 'linux') {
  run('dotnet', ['build', webOnly ? 'src/Vroom.Web' : 'Vroom.sln', '-nologo']);
  if (webOnly) run('dotnet', ['build', 'tests/Vroom.Tests', '-nologo']);
}

export const formatTargets = [
  'package.json',
  '.prettierrc.json',
  '.config/dotnet-tools.json',
  '.github/**/*.yml',
  '.github/**/*.md',
  'scripts/**/*.mjs',
  'resources/branding/*.svg',
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'docs/DEVELOPMENT.md',
  'docs/BRANDING.md',
  'docs/REPOSITORY-MIGRATION.md',
];
export function formatRepository(write = false) {
  run(node, [
    path.join(client, 'node_modules/prettier/bin/prettier.cjs'),
    write ? '--write' : '--check',
    ...formatTargets,
  ]);
}
