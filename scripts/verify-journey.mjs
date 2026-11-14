// Run only against an isolated review catalog, never a user's running catalog.
// node scripts/verify-journey.mjs http://127.0.0.1:5262
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const base = process.argv[2];
assert(base && /^http:\/\/127\.0\.0\.1:\d+$/.test(base), 'Pass an isolated loopback review host');
const run = promisify(execFile),
  root = path.resolve(import.meta.dirname, '..');
const stamp = Date.now().toString(),
  dir = path.join(root, '.artifacts', 'journey-check', stamp);
const evidence = { host: base, completed: [], directory: dir };
const context = { tabId: 'home', title: 'Journey verification' };
async function api(method, args = {}) {
  const response = await fetch(base + '/api/dispatch', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Vroom-Client': 'react',
      Cookie: 'vroom-session=' + (process.env.VROOM_WEB_TOKEN ?? ''),
    },
    body: JSON.stringify({ method, args, context }),
    signal: AbortSignal.timeout(120000),
  });
  assert.equal(response.status, 200);
  const envelope = await response.json();
  assert(envelope.ok, method + ': ' + JSON.stringify(envelope));
  return envelope.data;
}
async function wait(id) {
  const until = Date.now() + 120000;
  while (Date.now() < until) {
    const job = await api('job.get', { id });
    if (['completed', 'cancelled', 'failed', 'interrupted'].includes(job.state)) {
      assert.equal(job.state, 'completed', JSON.stringify(job));
      return job;
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw Error('Task did not complete: ' + id);
}
async function probed(id) {
  const jobs = await api('job.list', { limit: 200 });
  const job = jobs.items.find(j => j.kind === 'media.probe' && JSON.parse(j.payload).id === id);
  assert(job, 'Import scheduled independent probing');
  assert.deepEqual(job.origin, context);
  await wait(job.id);
}
const text = value => ({ defaultLocale: 'en', values: { en: value } });
await fs.mkdir(dir, { recursive: true });
try {
  const bootstrap = await api('bootstrap');
  assert.equal(bootstrap.apiVersion, 8);
  assert(
    bootstrap.libraries.every(l => l.name.startsWith('Journey verification')),
    'Refusing to mutate a non-review catalog',
  );
  assert(Array.isArray((await api('language.state')).installed)); // Built-ins ship with the client; this API lists user packs.
  evidence.completed.push('Bootstrap protocol and language APIs agree');
  const source = path.join(dir, 'selected.mp4'),
    secondSource = path.join(dir, 'later.mp4');
  await run(path.join(root, 'runtime', 'ffmpeg', 'ffmpeg.exe'), [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=640x360:rate=24',
    '-t',
    '12',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-an',
    source,
  ]);
  await fs.copyFile(source, path.join(dir, 'unselected.mp4'));
  const imported = await api('library.import', {
    kind: 'files',
    paths: [source],
    name: 'Journey verification ' + stamp,
  });
  await wait(imported.jobId);
  const films = await api('films.query', { libraryId: imported.libraryId });
  assert.equal(films.total, 1);
  assert.equal(films.films[0].path, source);
  const film = films.films[0];
  await probed(film.id);
  const playable = await api('playback.open', { id: film.id });
  const stream = await fetch(playable.url, { headers: { Range: 'bytes=0-1023' } });
  assert.equal(stream.status, 206);
  assert.equal((await stream.arrayBuffer()).byteLength, 1024);
  assert.equal((await api('film.availability', { id: film.id })).available, true);
  evidence.completed.push('Exact file selection, independent probe with task origin, playable HTTP byte ranges');
  const key = 'user.verify.scale' + stamp,
    vocabulary = 'user.verify.options' + stamp;
  const terms = ['short', 'medium', 'long'].map(id => ({
    id: 'verify-' + stamp + '-' + id,
    label: text(id),
    revision: 1,
    enabled: true,
    vocabularyIds: [vocabulary],
  }));
  const ref = i => ({ term: terms[i].id });
  const compare = (op, n) => ({ op, args: [{ fact: 'probe.duration' }, { literal: n }] });
  const definition = {
    key,
    revision: 1,
    enabled: true,
    label: text('Video size'),
    parents: [],
    targets: ['film-whole'],
    value: {
      cardinality: 'one',
      semanticVersion: 1,
      schema: {
        type: 'object',
        properties: { term: { type: 'string' } },
        required: ['term'],
        additionalProperties: false,
      },
    },
    options: { vocabulary },
    input: { component: 'select@1' },
    placements: [{ id: 'details', slot: 'film.details.fields', view: 'input', mode: 'edit', order: 100 }],
    query: { filter: true, sort: true, groupBy: ['value'] },
    initialization: [
      {
        id: 'duration-bands',
        event: 'film.discovered',
        executor: 'value.match@1',
        apply: 'if-unset',
        args: {
          cases: [
            { id: 'a', when: compare('lt', 600), value: ref(0) },
            { id: 'b', when: { op: 'and', args: [compare('gte', 600), compare('lt', 1800)] }, value: ref(1) },
            { id: 'c', when: compare('gte', 1800), value: ref(2) },
          ],
        },
      },
    ],
  };
  const changes = [
    { kind: 'vocabularies', key: vocabulary, value: { enabled: true, label: text('Video size'), items: terms } },
    { kind: 'definition', key, value: definition },
  ];
  const trial = await api('automation.preview', {
    tagKey: key,
    changes,
    samples: [599, 600, 1799, 1800, null].map(duration => ({ facts: { probe: { duration } } })),
  });
  assert.equal(trial.committable, false);
  assert.equal(trial.previewToken, null);
  assert.deepEqual(
    trial.samples.map(s => s.after?.term ?? s.state),
    [ref(0).term, ref(1).term, ref(1).term, ref(2).term, 'waiting'],
  );
  const config = await api('config.preview', { changes });
  await wait(
    (await api('config.apply', { previewToken: config.previewToken, expectedGeneration: config.generation })).jobId,
  );
  const calculation = await api('automation.preview', { tagKey: key, subjectIds: [film.id] });
  assert.equal(calculation.changedCount, 1);
  await wait((await api('automation.commit', { previewToken: calculation.previewToken })).jobId);
  assert.deepEqual((await api('film.get', { id: film.id })).film.values[key].value, ref(0));
  await fs.copyFile(source, secondSource);
  await wait(
    (await api('library.import', { kind: 'files', paths: [secondSource], libraryId: imported.libraryId })).jobId,
  );
  const second = (await api('films.query', { libraryId: imported.libraryId })).films.find(f => f.id !== film.id);
  await probed(second.id);
  assert.deepEqual((await api('film.get', { id: second.id })).film.values[key].value, ref(0));
  evidence.completed.push(
    'Draft trial, unit boundaries and unknown values, publish, frozen recalculation and new-import automatic classification',
  );
  const query = {
    libraryId: imported.libraryId,
    where: {
      op: 'and',
      args: [
        {
          op: 'or',
          args: [
            { op: 'eq', tag: key, value: ref(0) },
            { op: 'eq', tag: key, value: ref(1) },
          ],
        },
        { op: 'not', arg: { op: 'missing', tag: key } },
      ],
    },
    orderBy: [{ tag: key, direction: 'asc', mode: 'label', nulls: 'last' }],
    groupBy: [{ tag: key, mode: 'value' }],
    offset: 1,
    limit: 1,
  };
  const ids = await api('films.ids', query);
  assert.equal(ids.ids.length, 2);
  assert.equal((await api('films.query', query)).films.length, 1);
  await api('view.save', { id: 'verify-view-' + stamp, name: 'Journey verification ' + stamp, query });
  assert.deepEqual((await api('view.list')).find(v => v.id === 'verify-view-' + stamp).query.where, query.where);
  evidence.completed.push('Nested canonical query, named smart list, full result selection beyond current page');
  const capabilities = await api('export.capabilities');
  const profile = capabilities.contract.profiles.find(p => p.id === 'balanced');
  const output = ids.ids.map((id, i) => ({ filmId: id, outputPath: path.join(dir, 'compressed-' + i + '.mp4') }));
  const compression = await api('export.preview', {
    targets: output,
    presetName: capabilities.contract.defaults.preset,
    options: {
      ...profile.options,
      format: capabilities.contract.defaults.format,
      audio: 'none',
      'start-at': 'duration:0',
      'stop-at': 'duration:2',
    },
  });
  const committed = await api('export.commit', { previewToken: compression.previewToken });
  assert.equal(committed.conflicts.length, 0);
  assert.equal(committed.jobIds.length, 2);
  const results = await Promise.all(committed.jobIds.map(wait));
  for (const result of results) {
    const receipt = JSON.parse(result.resultJson);
    assert(receipt.bytes > 0);
    assert.deepEqual(result.origin, context);
  }
  assert.deepEqual((await api('export.commit', { previewToken: compression.previewToken })).jobIds, committed.jobIds);
  assert.equal((await fs.stat(source)).size, (await fs.stat(secondSource)).size);
  evidence.completed.push('Two real compressed samples, independent outputs, persistent results and idempotent commit');
  evidence.passed = true;
} catch (error) {
  evidence.error = String(error.stack ?? error);
  process.exitCode = 1;
}
await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
