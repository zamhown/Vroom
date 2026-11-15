import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { root } from './lib/process.mjs';

const supervisor = path.join(root, 'runtime/host/vroom-process-host');
const mac = { skip: process.platform !== 'darwin', timeout: 15_000 };
test('macOS supervisor preserves arguments, streams and exit status', mac, () => {
  assert(fs.existsSync(supervisor), 'Run node scripts/build-process-host.mjs first');
  const value = "中文 path with 'quotes' $(not-a-command)";
  const result = spawnSync(
    supervisor,
    ['/bin/sh', '-c', 'read -r line; printf "%s|%s" "$line" "$1"; exit 7', 'fixture', value],
    { input: 'stdin data\n', encoding: 'utf8' },
  );
  assert.equal(result.status, 7);
  assert.equal(result.stdout, `stdin data|${value}`);
});

test('abrupt host death reaps its macOS tool and descendants', mac, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vroom-supervisor-'));
  const marker = path.join(directory, 'pid');
  const source = `const {spawn}=require('node:child_process');
    spawn(process.argv[1], ['/bin/sh','-c','sleep 300 & echo $! > "$1"; wait','fixture',process.argv[2]], {stdio:'ignore'});
    setInterval(()=>{}, 1000);`;
  const host = spawn(process.execPath, ['-e', source, supervisor, marker], { stdio: 'ignore' });
  let child;
  try {
    const until = Date.now() + 5000;
    while (!fs.existsSync(marker) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25));
    child = Number(fs.readFileSync(marker, 'utf8').trim());
    assert(child > 1);
    process.kill(child, 0);
    host.kill('SIGKILL');
    let alive = true;
    for (let attempt = 0; attempt < 100 && alive; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 30));
      try {
        process.kill(child, 0);
      } catch (error) {
        assert.equal(error.code, 'ESRCH');
        alive = false;
      }
    }
    assert.equal(alive, false, 'Descendant survived the owning host');
  } finally {
    host.kill('SIGKILL');
    if (child)
      try {
        process.kill(child, 'SIGKILL');
      } catch {
        /* Already reaped. */
      }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
