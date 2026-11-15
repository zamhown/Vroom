import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import readline from 'node:readline';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { root } from './lib/process.mjs';

const decoder = process.env.VROOM_TEST_DECODER || path.join(root, 'runtime/host/vroom-decoder');
const ffmpeg = process.env.VROOM_TEST_FFMPEG || path.join(root, 'runtime/ffmpeg/ffmpeg');
const available = process.platform === 'darwin' && fs.existsSync(decoder) && fs.existsSync(ffmpeg);

test(
  'isolated GPU decoders transmit changing frames, resize, and survive a peer crash or suspension',
  { skip: !available && process.env.VROOM_REQUIRE_GPU !== '1', timeout: 60000 },
  async context => {
    assert(available, 'GPU validation requires macOS and prepared decoder/FFmpeg runtimes.');
    const capabilities = JSON.parse(execFileSync(decoder, ['--capabilities'], { encoding: 'utf8' }));
    if (!capabilities.gpu) {
      assert.notEqual(
        process.env.VROOM_REQUIRE_GPU,
        '1',
        'This validation requires a real accelerated OpenGL/Metal Mac.',
      );
      context.skip('No accelerated OpenGL device on this host; GPU acceptance requires a physical Mac.');
      return;
    }
    const directory = fs.mkdtempSync('/tmp/vroom-gpu-');
    fs.chmodSync(directory, 0o700);
    const children = [],
      connections = [];
    try {
      const probe = path.join(directory, 'probe');
      execFileSync('xcrun', [
        'clang',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-O2',
        '-fobjc-arc',
        path.join(root, 'tests/native/macos-video-probe.m'),
        '-framework',
        'Foundation',
        '-framework',
        'IOSurface',
        '-o',
        probe,
      ]);
      const file = path.join(directory, '测试 sample.mp4');
      execFileSync(ffmpeg, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=640x360:rate=30',
        '-vf',
        'drawbox=x=0:y=0:w=40:h=40:c=red:t=fill,drawbox=x=0:y=ih-40:w=40:h=40:c=blue:t=fill',
        '-t',
        '12',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        file,
      ]);
      const waitFor = async (condition, label) => {
        const deadline = Date.now() + 12000;
        while (!condition()) {
          assert(Date.now() < deadline, label);
          await delay(30);
        }
      };
      async function player(index) {
        const host = spawn(probe, [], { stdio: ['ignore', 'pipe', 'pipe'] });
        children.push(host);
        let service;
        const frames = [];
        readline.createInterface({ input: host.stdout }).on('line', line => {
          const value = JSON.parse(line);
          if (value.service) service = value.service;
          if (value.frame) frames.push(value);
        });
        await waitFor(() => service, 'presenter registration');
        const socket = path.join(directory, `ipc-${index}`);
        const child = spawn(
          decoder,
          [
            `--vroom-surface=${service}`,
            '--no-config',
            '--idle=yes',
            '--keep-open=yes',
            '--pause=yes',
            '--ao=null',
            '--hwdec=auto-safe',
            '--load-scripts=no',
            '--ytdl=no',
            '--msg-level=all=warn',
            `--input-ipc-server=${socket}`,
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        children.push(child);
        let errors = '';
        child.stderr.on('data', data => {
          errors += data;
        });
        await waitFor(() => fs.existsSync(socket) || child.exitCode != null, 'decoder IPC');
        assert.equal(child.exitCode, null, errors);
        const connection = net.createConnection(socket);
        connections.push(connection);
        await new Promise((resolve, reject) => {
          connection.once('connect', resolve);
          connection.once('error', reject);
        });
        let loaded = false;
        readline.createInterface({ input: connection }).on('line', line => {
          if (JSON.parse(line).event === 'file-loaded') loaded = true;
        });
        connection.write(JSON.stringify({ command: ['loadfile', file] }) + '\n');
        await waitFor(() => loaded || child.exitCode != null, 'load fixture: ' + errors);
        connection.write(JSON.stringify({ command: ['set_property', 'pause', false] }) + '\n');
        try {
          await waitFor(() => frames.length >= 25 || child.exitCode != null, 'changing GPU frames');
        } catch (error) {
          throw new Error(`${error.message}: count=${frames.length}; ${errors}`, { cause: error });
        }
        assert.equal(child.exitCode, null, errors);
        assert(new Set(frames.map(frame => frame.hash)).size > 10, 'real changing pixels must arrive');
        assert(frames.some(frame => frame.width === 320 && frame.height === 180));
        assert(frames.some(frame => frame.width === 640 && frame.height === 360));
        assert(
          frames.slice(-10).every(frame => frame.upright),
          'shared textures must preserve orientation and color channels',
        );
        return { child, frames, connection };
      }
      const first = await player(1),
        second = await player(2);
      first.child.kill('SIGSTOP');
      const before = second.frames.length;
      await waitFor(() => second.frames.length >= before + 10, 'peer must keep rendering while decoder is suspended');
      first.child.kill('SIGKILL');
      const after = second.frames.length;
      await waitFor(() => second.frames.length >= after + 10, 'peer must keep rendering after decoder crash');
      second.connection.write(JSON.stringify({ command: ['seek', 1, 'absolute+exact'] }) + '\n');
      await waitFor(() => second.frames.length >= after + 15, 'surviving session must remain controllable');
    } finally {
      for (const connection of connections) connection.destroy();
      for (const child of children) {
        if (child.exitCode == null && child.signalCode == null) {
          child.kill('SIGKILL');
          await new Promise(resolve => child.once('exit', resolve));
        }
      }
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);
