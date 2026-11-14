#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { client, flags, requireDependencies, root, run } from './lib/process.mjs';

const options = flags(['--web', '--demo']);
requireDependencies();
const env = { ...process.env, VROOM_RUNTIME: process.env.VROOM_RUNTIME || path.join(root, 'runtime') };
if (options.has('--demo')) env.VROOM_DATA = path.join(root, 'artifacts/smoke-data');
run('npm', ['run', 'build'], { cwd: client, env });
if (options.has('--web')) {
  run('dotnet', ['run', '--project', 'src/Vroom.Web', '--no-launch-profile'], { env });
} else if (process.platform === 'win32') {
  const framework = 'net10.0-windows10.0.19041.0';
  run('dotnet', ['build', 'src/Vroom.App', '-f', framework], { env });
  const exe = path.join(root, 'src/Vroom.App/bin/Debug', framework, 'win-x64/Vroom.App.exe');
  const app = spawn(exe, [], { cwd: root, env, detached: true, stdio: 'ignore', windowsHide: true });
  app.on('error', error => {
    console.error(error);
    process.exitCode = 1;
  });
  app.unref();
} else if (process.platform === 'darwin') {
  run('dotnet', ['build', 'src/Vroom.App', '-t:Run', '-p:VroomTargetFramework=net10.0-maccatalyst'], { env });
} else {
  throw new Error('The desktop app targets Windows and macOS; on this platform use --web.');
}
