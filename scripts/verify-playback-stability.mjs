// Run against a new isolated review catalog. Never point this at a user's catalog.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
const [base, playwrightModule] = process.argv.slice(2);
assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(base), 'Isolated loopback host required');
const { chromium } = await import(pathToFileURL(playwrightModule).href);
const root = path.resolve(import.meta.dirname, '..'),
  dir = path.join(root, '.artifacts', 'playback-stability');
await fs.mkdir(dir, { recursive: true });
async function api(method, args = {}) {
  const r = await fetch(base + '/api/dispatch', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Vroom-Client': 'react',
      Cookie: 'vroom-session=' + (process.env.VROOM_WEB_TOKEN ?? ''),
    },
    body: JSON.stringify({ method, args }),
  });
  const e = await r.json();
  assert(e.ok, method + ': ' + JSON.stringify(e));
  return e.data;
}
async function wait(jobId, early = false) {
  for (let i = 0; i < 240; i++) {
    const j = await api('job.get', { id: jobId });
    if (['cancelled', 'failed', 'interrupted'].includes(j.state)) throw Error(JSON.stringify(j));
    if ((early || j.state === 'completed') && j.resultJson) return JSON.parse(j.resultJson);
    await new Promise(r => setTimeout(r, 250));
  }
  throw Error('Job timed out');
}
const bootstrap = await api('bootstrap');
assert(
  bootstrap.libraries.every(l => l.name === 'Playback stability fixture'),
  'Refusing non-review catalog',
);
for (const job of (await api('job.list', { limit: 200 })).items.filter(
  j => j.kind === 'media.transcode' && j.resultJson,
)) {
  const session = JSON.parse(job.resultJson).sessionId;
  if (session) await api('playback.stop', { sessionId: session });
}
const video = path.join(dir, 'two-tracks.mkv');
await promisify(execFile)(path.join(root, 'runtime/ffmpeg/ffmpeg.exe'), [
  '-v',
  'error',
  '-y',
  '-f',
  'lavfi',
  '-i',
  'testsrc2=s=640x360:r=24',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=880',
  '-map',
  '0:v',
  '-map',
  '1:a',
  '-map',
  '2:a',
  '-metadata:s:a:0',
  'language=eng',
  '-metadata:s:a:1',
  'language=fra',
  '-t',
  '20',
  '-c:v',
  'libx264',
  '-preset',
  'ultrafast',
  '-c:a',
  'aac',
  video,
]);
await wait((await api('library.import', { kind: 'files', paths: [video], name: 'Playback stability fixture' })).jobId);
const film = (await api('films.query', {})).films.find(f => f.path === video);
assert(film);
const probeJobs = await api('job.list', { limit: 100 });
for (const job of probeJobs.items.filter(j => j.kind === 'media.probe')) await wait(job.id);
const info = await api('playback.info', { id: film.id });
assert.equal(info.tracks.filter(t => t.kind === 'audio').length, 2);
const source = await wait(
  (
    await api('playback.open', {
      id: film.id,
      transcode: true,
      start: 4,
      options: { audioStream: 2, audioDelay: 0.25, channels: 'mono', deinterlace: true },
    })
  ).jobId,
  true,
);
assert(source.transcoded);
assert.equal(source.offset, 4);
const playlist = await (await fetch(source.url)).text();
assert(playlist.includes('#EXTINF'));
await api('playback.stop', { sessionId: source.sessionId });
await api('workspace.save', {
  version: 3,
  activeId: 'home',
  tabs: [
    { id: 'home', kind: 'library', title: 'Home', state: {} },
    { id: 'fixture-player', kind: 'player', title: 'Fixture playback', params: { filmId: film.id }, state: {} },
    { id: 'fixture-settings', kind: 'settings', title: 'Fixture settings', state: {} },
  ],
});
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
try {
  await page.goto(base);
  await page.locator('.film-card').first().waitFor();
  await page.locator('.film-card').first().click({ button: 'right' });
  assert.equal(await page.locator('.context-menu [role=menuitem]').count(), 4);
  await page.screenshot({ animations: 'disabled', path: path.join(dir, 'film-menu.png') });
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.context-menu').count(), 0);
  const prevented = await page
    .locator('input')
    .first()
    .evaluate(el => {
      const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      el.dispatchEvent(e);
      return e.defaultPrevented;
    });
  assert.equal(prevented, false);
  await page.locator('[data-tab-id="fixture-player"]').click();
  await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2, null, { timeout: 90000 });
  await page.locator('video').evaluate(v => {
    window.fixtureVideo = v;
    v.pause();
  });
  await page.locator('.video-stage').click({ button: 'right', position: { x: 100, y: 100 } });
  await page
    .locator('.context-menu [role=menuitem]')
    .filter({ hasText: /播放设置|Playback settings/ })
    .click();
  await page.getByRole('dialog').waitFor();
  await page
    .getByRole('dialog')
    .locator('summary')
    .filter({ hasText: /^画面$/ })
    .click();
  await page.getByRole('textbox', { name: '亮度', exact: true }).fill('1.25');
  await page.getByRole('textbox', { name: '亮度', exact: true }).press('Tab');
  assert(await page.evaluate(() => document.querySelector('video').style.filter.includes('brightness(1.25)')));
  assert(await page.evaluate(() => document.querySelector('video') === window.fixtureVideo));
  await page.screenshot({ animations: 'disabled', path: path.join(dir, 'playback-settings.png') });
  await page
    .getByRole('dialog')
    .locator('summary')
    .filter({ hasText: /^画面$/ })
    .click();
  await page
    .getByRole('dialog')
    .locator('summary')
    .filter({ hasText: /^音轨与解码$/ })
    .click();
  const previousSource = await page.locator('video').getAttribute('src');
  await page.getByRole('textbox', { name: '音频延迟（秒）', exact: true }).fill('0.3');
  await page.getByRole('textbox', { name: '音频延迟（秒）', exact: true }).press('Tab');
  await page.waitForFunction(
    previous => {
      const v = document.querySelector('video');
      return v?.readyState >= 2 && v.getAttribute('src') !== previous;
    },
    previousSource,
    { timeout: 90000 },
  );
  assert(await page.evaluate(() => document.querySelector('video') === window.fixtureVideo));
  assert(await page.locator('video').evaluate(v => v.paused));
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /完成|Done/, exact: true })
    .click();
  await page.locator('[data-tab-id="fixture-settings"]').click();
  await page.locator('[data-tab-id="fixture-player"]').click();
  assert(
    await page.evaluate(() => document.querySelector('video') === window.fixtureVideo),
    'Tab switching must preserve the player',
  );
  await page.locator('[data-tab-id="fixture-settings"]').click();
  // Corrupt only the player's response: a real React render exception must not destroy the shell or sibling tabs.
  await page.route('**/api/dispatch', async route => {
    const request = route.request().postDataJSON();
    if (request.method !== 'film.get') return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    body.data.annotations = {};
    await route.fulfill({ response, json: body });
  });
  await page.reload();
  await page.locator('[data-tab-id="fixture-player"]').click();
  await page.getByRole('button', { name: /重试此页面|Retry this page/, exact: true }).waitFor({ timeout: 90000 });
  assert.equal(await page.locator('[data-tab-id]').count(), 3);
  await page.locator('[data-tab-id="fixture-settings"]').click();
  assert(await page.locator('.settings-grid').isVisible());
  await page.locator('[data-tab-id="fixture-player"]').click();
  await page.unroute('**/api/dispatch');
  await page.getByRole('button', { name: /重试此页面|Retry this page/, exact: true }).click();
  await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2, null, { timeout: 90000 });
  const log = await fs.readFile(await api('diagnostics.path'), 'utf8');
  assert(log.includes('client.render'));
  assert(log.includes('fixture-player'));
  await page.setViewportSize({ width: 820, height: 700 });
  await page.locator('.video-stage').click({ button: 'right', position: { x: 100, y: 100 } });
  await page.screenshot({ animations: 'disabled', path: path.join(dir, 'player-menu-narrow.png') });
  await fs.writeFile(
    path.join(dir, 'result.json'),
    JSON.stringify(
      {
        passed: [
          'real FFmpeg multi-track filtered HLS',
          'resource menus',
          'native input exemption',
          'live picture adjustment and audio restart preserve player and pause state',
          'player preserved across tabs',
          'tab render failure isolated and retried',
          'local crash log with tab identity',
        ],
        errors,
      },
      null,
      2,
    ),
  );
  console.log('Playback and stability verification passed:', dir);
} finally {
  await page.goto('about:blank').catch(() => {});
  await browser.close();
  for (const job of (await api('job.list', { limit: 200 })).items.filter(
    j => j.kind === 'media.transcode' && j.resultJson,
  )) {
    const session = JSON.parse(job.resultJson).sessionId;
    if (session) await api('playback.stop', { sessionId: session });
  }
}
