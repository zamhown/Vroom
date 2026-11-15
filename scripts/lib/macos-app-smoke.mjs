import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

// Exercise the shipping entry point, WKWebView, its JS bridge and catalog bootstrap.
// A successful tool --version or .NET build cannot detect a blank Release window.
export async function smokeMacApp(app) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'vroom-package-smoke-'));
  const env = { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', VROOM_DATA: data };
  for (const name of Object.keys(env)) if (name === 'VROOM_RUNTIME' || name.startsWith('DYLD_')) delete env[name];
  const log = fs.openSync(path.join(data, 'process.log'), 'w');
  const child = spawn(path.join(app, 'Contents/MacOS/Vroom.App'), [], { env, stdio: ['ignore', log, log] });
  const exited = new Promise(resolve => {
    child.once('exit', resolve);
    child.once('error', resolve);
  });
  let failure;
  child.once('error', error => {
    failure = error;
  });
  let passed = false;
  try {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`Published app exited before bootstrap (${child.exitCode ?? child.signalCode}).`);
      const diagnostics = path.join(data, 'logs', `vroom-${child.pid}.jsonl`);
      if (fs.existsSync(diagnostics)) {
        const records = fs.readFileSync(diagnostics, 'utf8').trim().split('\n');
        if (
          records.some(line => {
            try {
              return JSON.parse(line).source === 'native.client.ready';
            } catch {
              return false;
            }
          })
        ) {
          passed = true;
          return;
        }
      }
      await delay(250);
    }
    throw new Error(`Published app did not complete client bootstrap within 45 seconds. Logs: ${data}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await Promise.race([exited, delay(3000)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
    fs.closeSync(log);
    if (passed) fs.rmSync(data, { recursive: true, force: true });
    else console.error(`App smoke diagnostics retained: ${data}`);
  }
}
