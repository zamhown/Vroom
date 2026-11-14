#!/usr/bin/env node
// End-to-end journey against the real Web host and a temporary catalog. Builds nothing; run after
// `npm run build` in the client and `dotnet build`. Usage: node scripts/e2e-web.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vroom-e2e-'));
const data = path.join(work, 'data');
const media = path.join(work, 'media');
const port = 5400 + Math.floor(Math.random() * 400);
const base = `http://127.0.0.1:${port}`;
const token = 'e2e' + Math.random().toString(16).slice(2).padEnd(24, '0');
// Run the built host directly (one process), so stopping it releases the catalog immediately.
const configuration = process.env.CONFIGURATION ?? 'Debug';
const assembly = path.join(root, 'src', 'Vroom.Web', 'bin', configuration, 'net10.0', 'Vroom.Web.dll');
assert(fs.existsSync(assembly), 'Build the Web host first: dotnet build src/Vroom.Web');
const host = spawn('dotnet', [assembly], {
  // The project folder is the content root, so wwwroot is served as with dotnet run.
  cwd: path.join(root, 'src', 'Vroom.Web'),
  env: { ...process.env, VROOM_WEB_URL: base, VROOM_DATA: data, VROOM_WEB_TOKEN: token },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const exited = new Promise(resolve => host.once('exit', resolve));
let log = '';
host.stdout.on('data', d => (log += d));
host.stderr.on('data', d => (log += d));
const cookie = 'vroom-session=' + token;
async function api(method, args = {}) {
  const response = await fetch(base + '/api/dispatch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Vroom-Client': 'react', Cookie: cookie },
    body: JSON.stringify({ method, args }),
  });
  assert.equal(response.status, 200, method);
  return response.json();
}
async function ok(method, args) {
  const envelope = await api(method, args);
  assert(envelope.ok, method + ': ' + JSON.stringify(envelope));
  return envelope.data;
}
async function job(id) {
  const until = Date.now() + 120_000;
  while (Date.now() < until) {
    const current = await ok('job.get', { id });
    if (['completed', 'cancelled', 'failed', 'interrupted'].includes(current.state)) return current;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('task did not finish: ' + id);
}
const steps = [];
const step = async (name, run) => {
  await run();
  steps.push(name);
  console.log('ok -', name);
};
try {
  // Host readiness.
  const ready = Date.now() + 120_000;
  for (;;) {
    try {
      if ((await fetch(base + '/')).ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > ready) throw new Error('host did not start\n' + log);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  await step('API requires the session cookie', async () => {
    const anonymous = await fetch(base + '/api/dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Vroom-Client': 'react' },
      body: JSON.stringify({ method: 'bootstrap', args: {} }),
    });
    assert.equal(anonymous.status, 401);
    const login = await fetch(base + '/?token=' + token, { redirect: 'manual' });
    assert.equal(login.status, 302);
    assert.match(login.headers.get('set-cookie') ?? '', /vroom-session=/);
  });
  await step('the client shell is served', async () => {
    const page = await (await fetch(base + '/')).text();
    assert.match(page, /<div id="root"/);
    assert.match(page, /<title>Vroom<\/title>/);
    const icon = await fetch(base + '/vroom.svg');
    assert.equal(icon.status, 200);
    assert.match(icon.headers.get('content-type'), /image\/svg\+xml/);
    assert.equal(await icon.text(), fs.readFileSync(path.join(root, 'resources/branding/vroom.svg'), 'utf8'));
  });
  await step('bootstrap reports the published contract', async () => {
    const boot = await ok('bootstrap');
    const capabilities = JSON.parse(
      fs.readFileSync(path.join(root, 'resources/tagging/host-capabilities.json'), 'utf8'),
    );
    assert.equal(boot.apiVersion, capabilities.clientApiVersion);
    assert(boot.tagging.package.definitions.length > 0);
  });
  let libraryId = '';
  let films = [];
  await step('importing a folder registers its videos', async () => {
    fs.mkdirSync(path.join(media, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(media, 'first.mp4'), Buffer.alloc(4096, 1));
    fs.writeFileSync(path.join(media, 'nested', 'second.mkv'), Buffer.alloc(4096, 2));
    fs.writeFileSync(path.join(media, 'notes.txt'), 'not a video');
    const imported = await ok('library.import', {
      kind: 'folder',
      paths: [media],
      name: 'E2E',
      probeOnScan: false,
      autoEnrich: false,
    });
    libraryId = imported.libraryId;
    assert.equal((await job(imported.jobId)).state, 'completed');
    films = (await ok('film.query', { libraryId, ignoreDefaultQuery: true, limit: 50 })).films;
    assert.equal(films.length, 2);
  });
  await step('film details and errors use the shared contracts', async () => {
    const detail = await ok('film.get', { id: films[0].id });
    assert.equal(detail.film.id, films[0].id);
    const missing = await api('film.get', { id: 'missing-film' });
    assert.equal(missing.ok, false);
    assert.match(missing.error, /^(host\.|error\.)/);
  });
  await step('rescanning an unchanged folder adds nothing', async () => {
    const scan = await ok('job.start', { kind: 'library.scan', payload: { id: libraryId } });
    assert.equal((await job(scan.jobId)).state, 'completed');
    assert.equal((await ok('film.query', { libraryId, ignoreDefaultQuery: true, limit: 50 })).films.length, 2);
  });
  await step('the change feed reports catalog changes', async () => {
    const changes = await ok('changes.wait', { cursor: 0, jobsVersion: -1, timeoutSeconds: 1 });
    assert(Array.isArray(changes.events) && changes.events.length > 0);
  });
  await step('removing a library archives it and leaves the files', async () => {
    const removal = await ok('library.remove', { id: libraryId });
    assert(fs.existsSync(removal.archive), 'archive file');
    assert.equal(
      (await ok('library.list')).some(l => l.id === libraryId),
      false,
    );
    assert(fs.existsSync(path.join(media, 'first.mp4')));
  });
  console.log(`${steps.length} end-to-end steps passed`);
} catch (error) {
  console.error(error);
  console.error(log.split('\n').slice(-40).join('\n'));
  process.exitCode = 1;
} finally {
  host.kill();
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 10_000))]);
  // The temporary catalog and media were created by this script.
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
