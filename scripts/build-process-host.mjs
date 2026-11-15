import fs from 'node:fs';
import path from 'node:path';
import { root, run, flags } from './lib/process.mjs';
flags([]);
if (process.platform === 'darwin') {
  const directory = path.join(root, 'runtime/host');
  fs.mkdirSync(directory, { recursive: true });
  run('xcrun', [
    'clang',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-O2',
    '-mmacosx-version-min=14.0',
    'src/Vroom.App/Platforms/MacCatalyst/process-host.c',
    '-o',
    path.join(directory, 'vroom-process-host'),
  ]);
}
