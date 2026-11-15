import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  auditMachO,
  bundleMachO,
  linkedLibraries,
  minimumMacOS,
  newerVersion,
  prepareNativeLibraries,
  rpaths,
  systemLibrary,
} from './lib/macho.mjs';

test('Mach-O dependency parsing preserves spaces and weak dependencies', () => {
  assert.deepEqual(
    linkedLibraries(
      'tool:\n\t/opt/test path/lib.dylib (compatibility version 1.0.0, current version 2.0.0)\n\t/usr/lib/libc.dylib (compatibility version 1.0.0, current version 2.0.0, weak)\n',
    ),
    ['/opt/test path/lib.dylib', '/usr/lib/libc.dylib'],
  );
  assert.deepEqual(rpaths('cmd LC_RPATH\n cmdsize 40\n path @loader_path/../lib (offset 12)'), ['@loader_path/../lib']);
  assert(systemLibrary('/System/Library/Frameworks/AppKit.framework/AppKit'));
  assert(!systemLibrary('/usr/local/lib/libmpv.dylib'));
  assert.equal(minimumMacOS('cmd LC_BUILD_VERSION\ncmdsize 32\nplatform 1\nminos 27.2\nsdk 27.2'), '27.2');
  assert.equal(minimumMacOS('cmd LC_BUILD_VERSION\ncmdsize 32\nplatform 6\nminos 17.0\nsdk 27.2'), '14.0');
  assert.equal(newerVersion('14.9', '14.10.1'), '14.10.1');
});

test(
  'native libraries and executable run after original dependency paths disappear',
  { skip: process.platform !== 'darwin' },
  () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vroom relocation '));
    const source = path.join(directory, 'original');
    const sibling = path.join(directory, 'sibling');
    const bundle = path.join(directory, 'bundle');
    fs.mkdirSync(source);
    try {
      fs.writeFileSync(path.join(directory, 'answer.c'), 'int answer(void) { return 42; }');
      fs.writeFileSync(
        path.join(directory, 'consumer.c'),
        'extern int answer(void); int result(void) { return answer(); }',
      );
      fs.writeFileSync(
        path.join(directory, 'main.c'),
        '#include <stdio.h>\nextern int result(void); int main(void) { printf("%d", result()); return 0; }',
      );
      const compile = args => execFileSync('xcrun', ['clang', ...args]);
      compile([
        '-dynamiclib',
        path.join(directory, 'answer.c'),
        '-install_name',
        '@rpath/libanswer.dylib',
        '-o',
        path.join(source, 'libanswer.dylib'),
      ]);
      compile([
        '-dynamiclib',
        path.join(directory, 'consumer.c'),
        '-L' + source,
        '-lanswer',
        '-Wl,-rpath,' + source,
        '-install_name',
        '@rpath/libconsumer.dylib',
        '-o',
        path.join(source, 'libconsumer.dylib'),
      ]);
      compile([
        path.join(directory, 'main.c'),
        '-L' + source,
        '-lconsumer',
        '-Wl,-rpath,' + source,
        '-o',
        path.join(directory, 'tool'),
      ]);
      const original = fs.readFileSync(path.join(source, 'libconsumer.dylib'));
      prepareNativeLibraries(source, sibling);
      assert.deepEqual(fs.readFileSync(path.join(source, 'libconsumer.dylib')), original);
      const graph = bundleMachO(bundle, process.arch === 'x64' ? 'x86_64' : 'arm64');
      graph.copy(path.join(directory, 'tool'), path.join(bundle, 'tool'));
      // Link a second executable against the normalized package without depending on its old rpath.
      compile([
        path.join(directory, 'main.c'),
        '-L' + sibling,
        '-lconsumer',
        '-Wl,-rpath,' + sibling,
        '-o',
        path.join(directory, 'sibling-tool'),
      ]);
      fs.renameSync(source, source + '-unavailable');
      auditMachO(bundle);
      auditMachO(sibling);
      const env = { PATH: '/usr/bin:/bin' };
      assert.equal(execFileSync(path.join(bundle, 'tool'), [], { env, encoding: 'utf8' }), '42');
      assert.equal(execFileSync(path.join(directory, 'sibling-tool'), [], { env, encoding: 'utf8' }), '42');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);
