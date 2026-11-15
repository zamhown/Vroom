#!/usr/bin/env node
// Real runtime/GPU validation plus an isolated launcher. Visual acceptance remains manual.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { dotnetEnvironment, installedWorkloads } from './lib/dotnet.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const client = path.join(root, 'src/Vroom.Client');
const app = path.join(root, 'src/Vroom.App/Vroom.App.csproj');
const buildArgs = [
  'build',
  app,
  '-p:VroomTargetFramework=net10.0-maccatalyst',
  '-f',
  'net10.0-maccatalyst',
  '-r',
  `maccatalyst-${process.arch}`,
  '-c',
  'Debug',
];

export function verifyDecoderResults(trx) {
  const counters = /<Counters\b([^>]+)>/.exec(trx)?.[1];
  if (!counters) throw new Error('The decoder test report has no counters.');
  const value = name => Number(new RegExp(`\\b${name}="(\\d+)"`).exec(counters)?.[1] ?? NaN);
  const results = [...trx.matchAll(/<UnitTestResult\b([^>]+)>/g)];
  const real = results.some(
    ([, attributes]) =>
      /testName="[^"]*RealMpvDecodesTracksAppliesSettingsAndSurvivesAnotherDecoderCrash"/.test(attributes) &&
      /outcome="Passed"/.test(attributes),
  );
  if (
    !real ||
    value('total') < 4 ||
    value('passed') !== value('total') ||
    value('failed') !== 0 ||
    value('notExecuted') !== 0
  )
    throw new Error('Real decoder tests must execute and pass; skipped tests do not validate mpv.');
  return { total: value('total'), passed: value('passed'), skipped: 0, realDecoderExecuted: true };
}

export function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

async function findExecutable(name, explicit) {
  const candidates = explicit
    ? [explicit]
    : [...(process.env.PATH ?? '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin'].map(dir =>
        path.join(dir, name),
      );
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    try {
      await fs.access(candidate, fs.constants.X_OK);
      return await fs.realpath(candidate);
    } catch {
      /* Try the next installed location. */
    }
  }
  return undefined;
}

async function main() {
  const mode = process.argv[2] ?? '--check';
  if (mode === '--help') {
    console.log(
      'Usage: node scripts/verify-macos.mjs [--check|--build|--run]\n--check: inspect a Mac and write a local report.\n--build: also install project npm dependencies, run real GPU/decoder tests, build Mac Catalyst, and generate a synthetic clip and isolated launcher.\n--run: perform --build and launch the isolated development app.\nRequires native arm64 or x64 Node, the SDK selected by global.json, a matching Mac Catalyst workload/Xcode, Homebrew libmpv, FFmpeg, ffprobe and HandBrakeCLI.\nNo system tools are installed, no catalog is reset, and no report is uploaded.',
    );
    return;
  }
  if (!['--check', '--build', '--run'].includes(mode) || process.argv.length > 3)
    throw new Error('Use --check, --build, or --run (see --help).');
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch))
    throw new Error('Run this script on a Mac using native arm64 or x64 Node.');
  if (Number(process.versions.node.split('.')[0]) < 20)
    throw new Error('Node 20 or newer is required to prepare the project Node runtime.');
  await fs.mkdir(path.join(root, '.artifacts'), { recursive: true });
  const output = await fs.mkdtemp(path.join(root, '.artifacts/macos-playback-'));
  const report = {
    mode,
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    started: new Date().toISOString(),
    steps: [],
    warnings: [],
    errors: [],
    embeddedPlayback: 'not-tested',
    nativeDialogWindows: 'requires-visual-verification',
    visualParity: 'not-verified',
    hardwareDecoding: 'not-verified',
    hostCrashCleanup: 'not-verified',
    status: 'running',
  };
  const env = { ...dotnetEnvironment(root), DOTNET_CLI_UI_LANGUAGE: 'en' };
  async function command(label, executable, args = [], options = {}) {
    const logfile = path.join(output, `${report.steps.length + 1}-${label}.log`);
    console.log(label);
    const log = await fs.open(logfile, 'w');
    let child,
      timeout,
      force,
      timedOut = false;
    const signal = name => {
      if (child?.pid) {
        try {
          process.kill(-child.pid, name);
        } catch {
          /* The process group has exited. */
        }
      }
    };
    try {
      await log.writeFile(JSON.stringify({ executable, args }) + '\n');
      child = spawn(executable, args, {
        cwd: options.cwd ?? root,
        env: { ...env, ...options.env },
        detached: true,
        stdio: ['ignore', log.fd, log.fd],
      });
      timeout = setTimeout(() => {
        timedOut = true;
        signal('SIGTERM');
        force = setTimeout(() => signal('SIGKILL'), 3000);
      }, options.timeout ?? 60000);
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      report.steps.push({ label, code, timedOut, log: path.basename(logfile) });
      const text = await fs.readFile(logfile, 'utf8');
      if (code !== 0 || timedOut) throw new Error(`${label} failed. See ${logfile}\n${text.slice(-4000)}`);
      return text.slice(text.indexOf('\n') + 1);
    } catch (error) {
      if (!report.steps.some(step => step.log === path.basename(logfile)))
        report.steps.push({ label, code: null, log: path.basename(logfile), error: error.message });
      throw error;
    } finally {
      clearTimeout(timeout);
      clearTimeout(force);
      await log.close();
    }
  }
  try {
    const inspect = async (label, executable, args, options) => {
      try {
        return await command(label, executable, args, options);
      } catch (error) {
        report.errors.push(error.message);
        return '';
      }
    };
    report.macos = (await inspect('macos', '/usr/bin/sw_vers')).trim();
    report.xcode = (await inspect('xcode', '/usr/bin/xcodebuild', ['-version'])).trim();
    report.sdk = (await inspect('dotnet-sdk', 'dotnet', ['--version'])).trim();
    await inspect('dotnet-info', 'dotnet', ['--info']);
    const workloads = await inspect('dotnet-workloads', 'dotnet', ['workload', 'list', '--machine-readable']);
    if (!installedWorkloads(workloads).some(id => ['maui', 'maui-maccatalyst'].includes(id)))
      report.errors.push(
        'Install the Mac Catalyst workload matching global.json and the selected Xcode; do not disable the Xcode version check.',
      );
    const tools = {};
    for (const [name, variable] of [
      ['mpv', 'VROOM_TEST_MPV'],
      ['ffmpeg', 'VROOM_TEST_FFMPEG'],
      ['ffprobe', 'VROOM_TEST_FFPROBE'],
      ['HandBrakeCLI', 'VROOM_TEST_HANDBRAKE'],
    ]) {
      tools[name] = await findExecutable(name, process.env[variable]);
      if (!tools[name]) {
        report.errors.push(
          `Missing ${name}. Install it first (Homebrew: brew install mpv ffmpeg handbrake), or set ${variable} to its absolute executable path.`,
        );
        continue;
      }
      const architecture = await inspect(`${name}-architecture`, '/usr/bin/lipo', ['-archs', tools[name]]);
      const expected = process.arch === 'arm64' ? 'arm64' : 'x86_64';
      if (!architecture.trim().split(/\s+/).includes(expected))
        report.errors.push(`${name} must include ${expected}; found ${architecture.trim()}.`);
      const version = await inspect(`${name}-version`, tools[name], [
        ['mpv', 'HandBrakeCLI'].includes(name) ? '--version' : '-version',
      ]);
      report[name] = { path: tools[name], version: version.split('\n')[0] };
    }
    if (tools.mpv) {
      await inspect('mpv-hwdec-capabilities', tools.mpv, ['--no-config', '--hwdec=help']);
      const library = path.resolve(path.dirname(tools.mpv), '../lib/libmpv.dylib');
      try {
        await fs.access(library);
        report.libmpv = await fs.realpath(library);
      } catch {
        report.warnings.push(
          'libmpv.dylib was not found beside this mpv installation. Building the isolated renderer requires Homebrew mpv development headers and library.',
        );
      }
      if (!/^mpv v?0\.42\.0(?:\s|$)/.test(report.mpv.version))
        report.warnings.push(
          'This mpv differs from the project reference version 0.42.0; real parameter tests are required.',
        );
    }
    if (report.errors.length) throw new Error('Preflight failed. Resolve the errors in report.json before building.');
    if (mode === '--check') {
      report.status = 'preflight-passed';
      return;
    }

    // Explicitly use the project Node binary after npm has installed platform-native dependencies.
    await command('npm-ci', 'npm', ['ci', '--no-audit', '--no-fund'], { cwd: client, timeout: 15 * 60_000 });
    const node = path.join(client, 'node_modules/node/bin/node');
    await command('process-host-build', node, ['scripts/build-process-host.mjs']);
    await command('native-renderer-build', node, ['scripts/build-macos-native.mjs', '--decoder']);
    await command('process-ownership-tests', node, ['--test', 'scripts/process-host.test.mjs']);
    await command('gpu-isolation-tests', node, ['--test', 'scripts/macos-video.test.mjs'], {
      env: { VROOM_TEST_FFMPEG: tools.ffmpeg, VROOM_REQUIRE_GPU: '1' },
    });
    report.embeddedPlayback = 'gpu-transfer-resize-orientation-and-isolation-tested';
    report.hostCrashCleanup = 'tested-abrupt-host-exit';
    await command('typescript', node, ['node_modules/typescript/bin/tsc', '-b'], { cwd: client, timeout: 5 * 60_000 });
    await command('frontend-tests', node, ['node_modules/vitest/vitest.mjs', 'run'], {
      cwd: client,
      timeout: 5 * 60_000,
    });
    await command('vite', node, ['node_modules/vite/bin/vite.js', 'build'], { cwd: client, timeout: 5 * 60_000 });
    await command('native-theme', node, ['scripts/sync-native-theme.mjs'], { cwd: client });
    await command('client-assets', node, ['scripts/sync-assets.mjs'], { cwd: client });
    const results = path.join(output, 'test-results');
    await command(
      'decoder-tests',
      'dotnet',
      [
        'test',
        'tests/Vroom.Tests/Vroom.Tests.csproj',
        '--filter',
        'FullyQualifiedName~NativePlaybackTests',
        '--logger',
        'trx;LogFileName=native-playback.trx',
        '--results-directory',
        results,
      ],
      { env: { VROOM_TEST_MPV: tools.mpv, VROOM_TEST_FFMPEG: tools.ffmpeg }, timeout: 10 * 60_000 },
    );
    report.decoderTests = verifyDecoderResults(await fs.readFile(path.join(results, 'native-playback.trx'), 'utf8'));
    await command(
      'media-source-extension-tests',
      'dotnet',
      [
        'test',
        'tests/Vroom.Tests/Vroom.Tests.csproj',
        '--filter',
        'FullyQualifiedName~MediaStructure|FullyQualifiedName~VerifiedMove|FullyQualifiedName~RelinkRehashes|FullyQualifiedName~NetworkTests|FullyQualifiedName~SourceDiscovery|FullyQualifiedName~DiscoveryReview|FullyQualifiedName~SubscriptionRuns|FullyQualifiedName~CandidateCannotIntroduce|FullyQualifiedName~IndependentAgreement|FullyQualifiedName~TermProfiles|FullyQualifiedName~Subtitle|FullyQualifiedName~CredentialApiRedirect|FullyQualifiedName~InvalidDownload|FullyQualifiedName~EnrichmentExpression',
        '--logger',
        'trx;LogFileName=media-source-extensions.trx',
        '--results-directory',
        results,
      ],
      { timeout: 10 * 60_000 },
    );
    report.extensionTests = path.join(results, 'media-source-extensions.trx');
    await command('maccatalyst-build', 'dotnet', buildArgs, { timeout: 30 * 60_000 });

    const runtime = path.join(output, 'runtime');
    for (const [name, directory] of [
      ['mpv', 'mpv'],
      ['ffmpeg', 'ffmpeg'],
      ['ffprobe', 'ffmpeg'],
      ['HandBrakeCLI', 'handbrake'],
    ]) {
      await fs.mkdir(path.join(runtime, directory), { recursive: true });
      await fs.symlink(tools[name], path.join(runtime, directory, name));
    }
    await fs.mkdir(path.join(runtime, 'host'), { recursive: true });
    await fs.symlink(path.join(root, 'runtime/host/vroom-process-host'), path.join(runtime, 'host/vroom-process-host'));
    await fs.symlink(path.join(root, 'runtime/host/vroom-decoder'), path.join(runtime, 'host/vroom-decoder'));
    const media = path.join(output, 'media');
    await fs.mkdir(media);
    const fixture = path.join(media, 'playback-fixture.mp4');
    await command('synthetic-media', tools.ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1280x720:rate=30',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440',
      '-t',
      '15',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-movflags',
      '+faststart',
      fixture,
    ]);
    const isolated = { VROOM_DATA: path.join(output, 'catalog'), VROOM_RUNTIME: runtime };
    const bundle = path.join(
      root,
      'src/Vroom.App/bin/Debug/net10.0-maccatalyst',
      `maccatalyst-${process.arch}`,
      'Vroom.app',
    );
    const launchArgs = [
      '-n',
      bundle,
      ...Object.entries(isolated).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    ];
    const launcher = path.join(output, 'launch.command');
    await fs.writeFile(
      launcher,
      '#!/bin/bash\nset -euo pipefail\ncd ' +
        shellQuote(root) +
        '\n' +
        Object.entries(isolated)
          .map(([key, value]) => `export ${key}=${shellQuote(value)}\n`)
          .join('') +
        ['/usr/bin/open', ...launchArgs].map(shellQuote).join(' ') +
        '\n',
      { mode: 0o700 },
    );
    report.launcher = launcher;
    report.fixture = fixture;
    report.status = 'baseline-passed';
    report.warnings.push(
      'The isolated runtime links to this Mac’s installed tools; it is a development fixture, not a redistributable package. Import only the generated media folder for this test.',
    );
    report.warnings.push(
      'Manually check part switching, modeless dialogs over video, resizing, fullscreen, external mpv/IINA/VLC launch and Keychain persistence. Online subtitle authentication/download needs your own OpenSubtitles credentials. Automated contract tests do not establish visual or native-window parity.',
    );
    if (mode === '--run') await command('isolated-app', '/usr/bin/open', launchArgs);
  } catch (error) {
    report.status = 'failed';
    report.errors.push(error.message);
    process.exitCode = 1;
  } finally {
    report.finished = new Date().toISOString();
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(
      `Report: ${path.join(output, 'report.json')}\nStatus: ${report.status}\nGPU transport: ${report.embeddedPlayback}\nNative window and visual acceptance remain manual.`,
    );
    for (const error of report.errors) console.error(error);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
