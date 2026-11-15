#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { root, client, run, requireDependencies, flags } from './lib/process.mjs';
import { auditMachO, bundleMachO, minimumMacOS, newerVersion } from './lib/macho.mjs';
import { smokeMacApp } from './lib/macos-app-smoke.mjs';

const options = flags(['--without-model', '--sign', '--notarize']);
if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch))
  throw new Error('Publish on a native arm64 or x64 Mac.');
if (options.has('--notarize') && !options.has('--sign')) throw new Error('--notarize requires --sign.');
const identity = options.has('--sign') ? process.env.VROOM_CODESIGN_IDENTITY : '-';
if (!identity || (options.has('--sign') && !identity.startsWith('Developer ID Application:')))
  throw new Error('Set VROOM_CODESIGN_IDENTITY to your Developer ID Application identity.');
if (options.has('--notarize') && !process.env.VROOM_NOTARY_PROFILE)
  throw new Error('Set VROOM_NOTARY_PROFILE to an existing notarytool Keychain profile.');
requireDependencies();
const architecture = process.arch === 'x64' ? 'x86_64' : 'arm64';
const rid = `maccatalyst-${process.arch}`;
const runtime = path.resolve(process.env.VROOM_RUNTIME || path.join(root, 'runtime'));
const required = [
  'ffmpeg/ffmpeg',
  'ffmpeg/ffprobe',
  'mpv/mpv',
  'handbrake/HandBrakeCLI',
  'host/vroom-process-host',
  'host/vroom-decoder',
];
if (!options.has('--without-model')) required.push('models/qwen2.5-0.5b-instruct-q4_k_m.gguf', 'models/LICENSE');
for (const relative of required)
  if (!fs.existsSync(path.join(runtime, relative)))
    throw new Error(`Missing runtime/${relative}. Run npm run setup first.`);
const publish = path.join(root, 'artifacts/publish');
// Refuse symlink destinations before creating or replacing any package.
for (const candidate of [path.join(root, 'artifacts'), publish])
  if (fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink())
    throw new Error(`Linked publish destination: ${candidate}`);
fs.mkdirSync(publish, { recursive: true });
const stage = fs.mkdtempSync(path.join(publish, `macos-${process.arch}.staging-`));
const output = path.join(publish, `macos-${process.arch}`);
if (fs.existsSync(output) && fs.lstatSync(output).isSymbolicLink()) throw new Error('Linked output directory.');

// Failed stages are retained for diagnosis; the last successful package is untouched.
run('npm', ['run', 'build'], { cwd: client });
run('dotnet', ['clean', 'src/Vroom.App', '-f', 'net10.0-maccatalyst', '-r', rid, '-c', 'Release']);
run('dotnet', [
  'publish',
  'src/Vroom.App',
  '-f',
  'net10.0-maccatalyst',
  '-r',
  rid,
  '-c',
  'Release',
  '-p:CreatePackage=false',
  '-p:EnableCodeSigning=false',
]);
const app = path.join(stage, 'Vroom.app');
fs.cpSync(path.join(root, 'src/Vroom.App/bin/Release/net10.0-maccatalyst', rid, 'Vroom.app'), app, { recursive: true });
const resources = path.join(app, 'Contents/Resources');
const bundled = path.join(resources, 'runtime');
const graph = bundleMachO(bundled, architecture);
for (const relative of required.filter(name => !name.startsWith('models/')))
  graph.copy(path.join(runtime, relative), path.join(bundled, relative));

// Vulkan's driver is loaded dynamically, so it is not an otool dependency edge.
const brew = execFileSync('brew', ['--prefix', 'molten-vk'], { encoding: 'utf8' }).trim();
const driver = graph.copy(path.join(brew, 'lib/libMoltenVK.dylib'));
const icdDirectory = path.join(bundled, 'share/vulkan/icd.d');
fs.mkdirSync(icdDirectory, { recursive: true });
const icd = JSON.parse(fs.readFileSync(path.join(brew, 'etc/vulkan/icd.d/MoltenVK_icd.json'), 'utf8'));
icd.ICD.library_path = path.relative(icdDirectory, driver);
fs.writeFileSync(path.join(icdDirectory, 'MoltenVK_icd.json'), JSON.stringify(icd, null, 2) + '\n');
if (!options.has('--without-model')) {
  fs.mkdirSync(path.join(bundled, 'models'), { recursive: true });
  for (const relative of required.filter(name => name.startsWith('models/')))
    fs.copyFileSync(path.join(runtime, relative), path.join(bundled, relative));
}
fs.writeFileSync(path.join(bundled, 'provenance.json'), JSON.stringify(graph.records, null, 2) + '\n');
for (const name of ['LICENSE', 'docs/THIRD-PARTY-NOTICES.md', 'docs/licenses'])
  fs.cpSync(path.join(root, name), path.join(resources, path.basename(name)), { recursive: true });

const binaries = auditMachO(app);
// Homebrew may build against a newer deployment target than Catalyst's source
// minimum. Declare the actual package floor instead of shipping a false promise.
const minimumSystem = binaries
  .map(file => minimumMacOS(execFileSync('/usr/bin/otool', ['-l', file], { encoding: 'utf8' })))
  .reduce(newerVersion, '14.0');
run('/usr/bin/plutil', [
  '-replace',
  'LSMinimumSystemVersion',
  '-string',
  minimumSystem,
  path.join(app, 'Contents/Info.plist'),
]);
const sign = file =>
  run('/usr/bin/codesign', [
    '--force',
    '--sign',
    identity,
    ...(identity === '-' ? [] : ['--timestamp', '--options', 'runtime']),
    file,
  ]);
for (const file of binaries) sign(file);
run('/usr/bin/codesign', [
  '--force',
  '--sign',
  identity,
  ...(identity === '-' ? [] : ['--timestamp', '--options', 'runtime']),
  '--entitlements',
  path.join(root, 'src/Vroom.App/Platforms/MacCatalyst/Entitlements.plist'),
  app,
]);
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
// Exercise relocated tools with no Homebrew PATH or DYLD overrides.
const environment = {
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  HOME: process.env.HOME,
  VK_DRIVER_FILES: path.join(icdDirectory, 'MoltenVK_icd.json'),
};
for (const [relative, argument] of [
  ['ffmpeg/ffmpeg', '-version'],
  ['ffmpeg/ffprobe', '-version'],
  ['mpv/mpv', '--version'],
  ['handbrake/HandBrakeCLI', '--version'],
  ['host/vroom-decoder', '--version'],
])
  execFileSync(path.join(bundled, relative), [argument], { env: environment, stdio: 'pipe' });
const gpuTest = execFileSync(process.execPath, ['--test', '--test-reporter=tap', 'scripts/macos-video.test.mjs'], {
  cwd: root,
  encoding: 'utf8',
  env: {
    ...process.env,
    VROOM_TEST_DECODER: path.join(bundled, 'host/vroom-decoder'),
    VROOM_TEST_FFMPEG: path.join(bundled, 'ffmpeg/ffmpeg'),
  },
});
console.log(gpuTest);
await smokeMacApp(app);
console.log('Published app: native client bootstrap passed with an isolated catalog and bundled runtime.');
const zip = path.join(stage, 'Vroom.zip');
run('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, zip]);
if (options.has('--notarize')) {
  run('xcrun', ['notarytool', 'submit', zip, '--keychain-profile', process.env.VROOM_NOTARY_PROFILE, '--wait']);
  run('xcrun', ['stapler', 'staple', app]);
  run('xcrun', ['stapler', 'validate', app]);
  run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
  fs.unlinkSync(zip);
  run('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, zip]);
}
fs.writeFileSync(
  path.join(stage, 'SHA256SUMS'),
  createHash('sha256').update(fs.readFileSync(zip)).digest('hex') + '  Vroom.zip\n',
);
fs.writeFileSync(
  path.join(stage, 'validation.json'),
  JSON.stringify(
    {
      architecture,
      minimumMacOS: minimumSystem,
      identity: identity === '-' ? 'ad-hoc' : 'Developer ID',
      notarized: options.has('--notarize'),
      nativeLibraries: binaries.length,
      relocatedTools: 'passed',
      nativeClientBootstrap: 'passed',
      isolatedGpuDecoders: /^# pass 1\s*$/m.test(gpuTest) ? 'passed' : 'unavailable-on-host',
      visualParity: 'not-certified',
    },
    null,
    2,
  ) + '\n',
);
const backup = output + `.previous-${Date.now()}`;
if (fs.existsSync(output)) fs.renameSync(output, backup);
try {
  fs.renameSync(stage, output);
} catch (error) {
  if (fs.existsSync(backup)) fs.renameSync(backup, output);
  throw error;
}
console.log(
  `Published: ${output}\n${identity === '-' ? 'Ad-hoc development build; not notarized for distribution.' : 'Developer ID signed.'}`,
);
