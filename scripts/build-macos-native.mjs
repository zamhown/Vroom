#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { root, run } from './lib/process.mjs';
import { minimumMacOS } from './lib/macho.mjs';

if (process.platform !== 'darwin') throw new Error('macOS native components require Xcode on macOS.');
const args = process.argv.slice(2);
const arch = args.find(value => value.startsWith('--arch='))?.slice(7) ?? process.arch;
if (!['arm64', 'x64'].includes(arch) || args.some(value => value !== '--decoder' && value !== `--arch=${arch}`))
  throw new Error('Usage: build-macos-native.mjs [--arch=arm64|x64] [--decoder]');
const architecture = arch === 'x64' ? 'x86_64' : 'arm64';
const source = path.join(root, 'src/Vroom.App/Platforms/MacCatalyst');
const output = path.join(root, 'runtime/host', arch);
fs.mkdirSync(output, { recursive: true });
const sdk = execFileSync('xcrun', ['--show-sdk-path'], { encoding: 'utf8' }).trim();
const compiler = execFileSync('xcrun', ['clang', '--version'], { encoding: 'utf8' });
const common = ['-Wall', '-Wextra', '-Werror', '-O2', '-fobjc-arc', '-isysroot', sdk];
function compile(name, dependencies, command) {
  const hash = createHash('sha256')
    .update(command.toString())
    .update(JSON.stringify({ common, architecture, compiler }));
  for (const dependency of dependencies) hash.update(fs.readFileSync(path.join(source, dependency)));
  const stamp = path.join(output, name + '.sha256');
  const digest = hash.digest('hex');
  if (fs.existsSync(path.join(output, name)) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === digest)
    return;
  command();
  fs.writeFileSync(stamp, digest);
}
compile('libvroom-video.a', ['video-presenter.m', 'video-wire.h'], () => {
  const object = path.join(output, 'video-presenter.o');
  run('xcrun', [
    'clang',
    ...common,
    '-target',
    `${architecture}-apple-ios17.0-macabi`,
    '-iframework',
    path.join(sdk, 'System/iOSSupport/System/Library/Frameworks'),
    '-isystem',
    path.join(sdk, 'System/iOSSupport/usr/include'),
    '-c',
    path.join(source, 'video-presenter.m'),
    '-o',
    object,
  ]);
  run('xcrun', ['ar', 'rcs', path.join(output, 'libvroom-video.a'), object]);
});
compile('libvroom-window.dylib', ['window-controls.m'], () => {
  run('xcrun', [
    'clang',
    ...common,
    '-arch',
    architecture,
    '-mmacosx-version-min=14.0',
    '-dynamiclib',
    path.join(source, 'window-controls.m'),
    '-framework',
    'AppKit',
    '-install_name',
    '@rpath/libvroom-window.dylib',
    '-o',
    path.join(output, 'libvroom-window.dylib'),
  ]);
});
if (args.includes('--decoder')) {
  const brew = execFileSync('brew', ['--prefix', 'mpv'], { encoding: 'utf8' }).trim();
  const minimum = minimumMacOS(
    execFileSync('/usr/bin/otool', ['-l', path.join(brew, 'lib/libmpv.dylib')], { encoding: 'utf8' }),
  );
  run('xcrun', [
    'clang',
    ...common,
    '-arch',
    architecture,
    '-mmacosx-version-min=' + minimum,
    path.join(source, 'video-decoder.m'),
    '-I' + path.join(brew, 'include'),
    '-L' + path.join(brew, 'lib'),
    '-lmpv',
    '-Wl,-rpath,' + path.join(brew, 'lib'),
    '-framework',
    'Foundation',
    '-framework',
    'OpenGL',
    '-framework',
    'IOSurface',
    '-o',
    path.join(root, 'runtime/host/vroom-decoder'),
  ]);
}
