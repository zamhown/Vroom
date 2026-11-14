// Run only against a separately launched MAUI host with an isolated catalog/profile.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [endpoint, playwrightModule] = process.argv.slice(2);
assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint));
const { chromium } = await import(pathToFileURL(playwrightModule).href);
const startupDeadline = Date.now() + 30000;
while (true) {
  try {
    if ((await (await fetch(endpoint + '/json/list')).json()).some(p => p.url.startsWith('https://0.0.0.1'))) break;
  } catch {}
  assert(Date.now() < startupDeadline, 'Isolated WebView did not become ready');
  await new Promise(resolve => setTimeout(resolve, 100));
}
const browser = await chromium.connectOverCDP(endpoint);
const page = browser
  .contexts()[0]
  .pages()
  .find(p => p.url().startsWith('https://0.0.0.1'));
assert(page, 'Isolated WebView not found');
const root = path.resolve(import.meta.dirname, '..'),
  output = path.join(root, '.artifacts', 'player-experience');
const checks = [],
  errors = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (test, message, timeout = 20000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await test()) return;
    await delay(80);
  }
  throw Error(message);
};
await page.addInitScript(() => {
  window.playerRequests = [];
  window.playerSessions = [];
  window.playerPending = new Map();
  const send = chrome.webview.postMessage.bind(chrome.webview);
  chrome.webview.postMessage = raw => {
    try {
      const { request } = JSON.parse(decodeURIComponent(raw).slice('__RawMessage|'.length));
      window.playerRequests.push(request);
    } catch {}
    send(raw);
  };
  chrome.webview.addEventListener('message', event => {
    try {
      const message = JSON.parse(decodeURIComponent(event.data)),
        result = JSON.parse(message.response);
      if (result.ok && result.data?.sessionId && result.data.embedded !== undefined)
        window.playerSessions.push(result.data.sessionId);
      const finish = window.playerPending.get(message.id);
      if (finish) {
        window.playerPending.delete(message.id);
        finish(result);
      }
    } catch {}
  });
  window.playerApi = (method, args = {}) =>
    new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      window.playerPending.set(id, result =>
        result.ok ? resolve(result.data) : reject(Error(JSON.stringify(result))),
      );
      chrome.webview.postMessage(
        encodeURIComponent('__RawMessage|' + JSON.stringify({ id, request: { method, args } })),
      );
    });
  localStorage.setItem('vroom.locale', 'zh-CN');
});
const api = (method, args = {}) => page.evaluate(([method, args]) => window.playerApi(method, args), [method, args]);
const requests = method => page.evaluate(method => window.playerRequests.filter(r => r.method === method), method);
const active = page.locator('[role=tabpanel]:not([hidden])');
const stage = () => active.locator('.video-stage');
const video = () => active.locator('video');
const tab = async id => {
  await page.locator(`[role=tab][data-tab-id="${id}"]`).click();
  await wait(
    () =>
      page
        .locator(`[data-tab-id="${id}"]`)
        .getAttribute('aria-selected')
        .then(s => s === 'true'),
    'Tab did not activate',
  );
};
async function dragStart(fraction) {
  const box = await active.locator('.seek-slider').boundingBox();
  assert(box);
  await page.mouse.move(box.x + 8 + (box.width - 16) * fraction, box.y + box.height / 2);
  await page.mouse.down();
  return box;
}
async function dragMove(box, fraction) {
  await page.mouse.move(box.x + 8 + (box.width - 16) * fraction, box.y + box.height / 2, { steps: 8 });
}
page.on('pageerror', error => errors.push(error.message));
try {
  await page.reload();
  await page.waitForFunction(() => window.playerApi);
  const boot = await api('bootstrap');
  assert(
    boot.libraries.every(l => l.name === 'Player experience fixture'),
    'Refusing a non-test catalog',
  );
  if (!boot.libraries.length) {
    const job = await api('library.import', {
      kind: 'files',
      paths: [path.join(output, 'scrub-fixture.mp4')],
      name: 'Player experience fixture',
      autoEnrich: false,
      probeOnScan: false,
    });
    await wait(async () => {
      const state = await api('job.get', { id: job.jobId });
      assert(!['cancelled', 'failed', 'interrupted'].includes(state.state), JSON.stringify(state));
      return state.state === 'completed';
    }, 'Import failed');
  }
  const film = (await api('films.query', {})).films[0];
  assert(film);
  if (!boot.libraries.length) assert.equal(film.duration, 0, 'Fresh fixture must be unprobed');
  await api('workspace.save', {
    version: 3,
    activeId: 'native',
    tabs: [
      { id: 'home', kind: 'library', title: 'Home', state: {} },
      ...['native', 'direct', 'compatible'].map(id => ({
        id,
        kind: 'player',
        title: id,
        params: { filmId: film.id },
        state: {
          engine: id === 'native' ? 'mpv' : 'browser',
          mode: id === 'native' ? 'auto' : id,
          muted: true,
          volume: 1.8,
          seekStep: 5,
        },
      })),
    ],
  });
  await page.evaluate(() => {
    const send = chrome.webview.postMessage.bind(chrome.webview);
    chrome.webview.postMessage = raw => {
      try {
        if (JSON.parse(decodeURIComponent(raw).slice('__RawMessage|'.length)).request.method === 'workspace.save')
          return;
      } catch {}
      send(raw);
    };
  });
  await page.reload();
  await wait(() => page.evaluate(() => window.playerSessions.length > 0), 'Native open failed');
  const sessionId = await page.evaluate(() => window.playerSessions[0]);
  const status = () => api('native.status', { sessionId });
  await wait(async () => (await status()).duration > 29, 'Native duration missing');
  await wait(
    () =>
      active
        .locator('.seek-slider input')
        .getAttribute('max')
        .then(v => Number(v) > 29),
    'Seek bar must use decoder duration',
  );
  await api('native.pause', { sessionId, paused: true });
  await delay(350);
  let box = await dragStart(0.2);
  await delay(300);
  const firstFrame = await api('native.screenshot', { sessionId, subtitles: false });
  await dragMove(box, 0.6);
  await delay(350);
  const secondFrame = await api('native.screenshot', { sessionId, subtitles: false });
  assert.notEqual(firstFrame, secondFrame, 'Native picture must change before mouse release');
  assert.equal((await status()).pause, true);
  assert((await requests('native.seek')).some(r => r.args.precision === 'keyframe'));
  await page.mouse.up();
  await wait(
    () =>
      active
        .locator('.seek-feedback')
        .count()
        .then(n => n === 0),
    'Native commit did not finish',
  );
  let final = (await requests('native.seek')).at(-1);
  assert.equal(final.args.precision, 'exact');
  assert(Math.abs((await status())['time-pos'] - final.args.position) < 0.15);
  assert.equal((await status()).pause, true);
  checks.push(
    'native-frames-change-while-held',
    'native-release-exact-and-preserves-pause',
    film.duration === 0 ? 'decoder-duration-with-unprobed-catalog' : 'decoder-duration',
  );
  console.log(checks.at(-1));
  await api('native.pause', { sessionId, paused: false });
  await delay(350);
  box = await dragStart(0.1);
  await dragMove(box, 0.3);
  await page.mouse.up();
  await wait(
    async () => (await status()).pause === false && (await active.locator('.seek-feedback').count()) === 0,
    'Playing scrub did not resume',
  );
  checks.push('native-release-preserves-playing');
  await active.getByRole('button', { name: '全屏', exact: true }).click();
  await wait(
    () => page.evaluate(() => document.documentElement.dataset.playerPresentation === 'fullscreen'),
    'Full-screen layout missing',
  );
  assert.equal(await page.locator('.sidebar').isVisible(), false);
  assert.equal(await page.locator('.tab-strip').isVisible(), false);
  await active.getByRole('button', { name: '退出全屏', exact: true }).focus();
  await page.keyboard.press('Escape');
  await wait(async () => !(await status()).fullscreen, 'Escape failed with a focused button');
  assert.equal(await page.locator('.sidebar').isVisible(), true);
  await stage().focus();
  await page.keyboard.press('t');
  await wait(
    () =>
      page
        .locator('.sidebar')
        .isVisible()
        .then(v => !v),
    'Focus mode did not hide navigation',
  );
  await page.keyboard.press('Escape');
  await wait(() => page.locator('.sidebar').isVisible(), 'Focus mode did not exit');
  const bounds = await stage().boundingBox();
  await page.mouse.move(bounds.x + 100, bounds.y + 100);
  await stage().focus();
  await wait(
    () =>
      stage()
        .getAttribute('class')
        .then(v => v.includes('controls-hidden')),
    'Playing controls did not hide',
  );
  await page.mouse.move(bounds.x + 120, bounds.y + 120);
  assert(!(await stage().getAttribute('class')).includes('controls-hidden'));
  await api('native.pause', { sessionId, paused: true });
  await delay(3000);
  assert(!(await stage().getAttribute('class')).includes('controls-hidden'));
  checks.push('fullscreen-layout-and-focused-escape', 'focus-mode', 'idle-controls-reveal-and-paused-controls');
  console.log(checks.at(-1));
  const beforeJump = (await status())['time-pos'];
  await stage().focus();
  await page.keyboard.press('ArrowRight');
  await delay(300);
  assert(
    Math.abs((await status())['time-pos'] - beforeJump - 5) < 0.15,
    'Keyboard must use the configured five-second step',
  );
  assert.equal(await active.locator('.control-row button').first().locator('svg text').textContent(), '5');
  await active.getByRole('button', { name: '跳转时间', exact: true }).click();
  await wait(
    async () => (await (await fetch(endpoint + '/json/list')).json()).some(p => p.url.includes('/dialog.html?')),
    'Time dialog did not open',
  );
  const dialogBrowser = await chromium.connectOverCDP(endpoint);
  try {
    const dialog = dialogBrowser
      .contexts()
      .flatMap(c => c.pages())
      .find(p => p.url().includes('/dialog.html?'));
    assert(dialog);
    const input = dialog.getByRole('textbox', { name: '跳转时间', exact: true });
    await input.fill('1:61');
    assert.equal(await dialog.getByRole('button', { name: '跳转时间', exact: true }).isEnabled(), false);
    await input.fill('00:04.125');
    await input.press('Enter');
    await wait(async () => Math.abs((await status())['time-pos'] - 4.125) < 0.15, 'Time input did not seek precisely');
  } finally {
    await dialogBrowser.close();
  }
  checks.push('configured-seek-step-icon-and-keyboard', 'validated-timecode-dialog');
  await tab('direct');
  await wait(() => video().evaluate(v => v.readyState >= 2 && v.duration > 29), 'Direct decoder not ready');
  assert.equal(await video().evaluate(v => v.volume), 1);
  await video().evaluate(v => v.pause());
  await delay(150);
  await stage().focus();
  await page.keyboard.press('ArrowDown');
  await wait(
    () => video().evaluate(v => Math.abs(v.volume - 0.95) < 0.001),
    'Volume key must start from the effective browser volume',
  );
  assert(await active.locator('.player-feedback').textContent());
  const frame = () =>
    video().evaluate(v => {
      const c = document.createElement('canvas');
      c.width = 160;
      c.height = 90;
      c.getContext('2d').drawImage(v, 0, 0, 160, 90);
      return c.toDataURL();
    });
  const seekEvents = async () => (await requests('film.event')).filter(r => r.args.type === 'playback.seeked').length;
  const beforeSeekEvents = await seekEvents();
  box = await dragStart(0.15);
  await wait(() => video().evaluate(v => !v.seeking && v.currentTime > 3), 'Direct preview did not seek');
  const before = await frame();
  await dragMove(box, 0.65);
  await wait(
    () => video().evaluate(v => !v.seeking && v.currentTime > 18),
    'Direct drag did not update before release',
  );
  assert.notEqual(await frame(), before);
  assert.equal(await seekEvents(), beforeSeekEvents, 'Intermediate preview frames must not execute seek automation');
  await page.mouse.up();
  await wait(
    () =>
      active
        .locator('.seek-feedback')
        .count()
        .then(n => n === 0),
    'Direct commit did not settle',
  );
  assert.equal(await video().evaluate(v => v.paused), true);
  assert.equal(await seekEvents(), beforeSeekEvents + 1, 'Release must produce one committed seek event');
  checks.push(
    'direct-frames-change-while-held',
    'direct-preserves-pause',
    'one-seek-event-per-gesture',
    'browser-volume-clamped',
  );
  console.log(checks.at(-1));
  await tab('compatible');
  await wait(() => video().evaluate(v => v.readyState >= 2), 'Transcoded video not ready', 90000);
  await wait(
    () =>
      active
        .locator('.seek-slider input')
        .getAttribute('max')
        .then(v => Number(v) > 29),
    'Transcode duration missing',
    90000,
  );
  await video().evaluate(v => v.pause());
  await delay(150);
  const opened = (await requests('playback.open')).length;
  box = await dragStart(0.1);
  await wait(
    () =>
      active
        .locator('.scrub-preview')
        .count()
        .then(n => n === 1),
    'Transcode frame preview missing',
  );
  const image = await active.locator('.scrub-preview').getAttribute('src');
  await dragMove(box, 0.7);
  await wait(
    () =>
      active
        .locator('.scrub-preview')
        .getAttribute('src')
        .then(src => src !== image),
    'Transcode frame did not update while held',
  );
  assert.equal((await requests('playback.open')).length, opened, 'Dragging must not restart transcode jobs');
  await page.mouse.up();
  await wait(
    () =>
      active
        .locator('.seek-feedback')
        .count()
        .then(n => n === 0),
    'Transcode final seek did not finish',
    90000,
  );
  assert.equal(await video().evaluate(v => v.paused), true);
  assert(await video().evaluate(v => v.readyState >= 2));
  checks.push('transcode-live-preview-without-repeated-restarts', 'transcode-release-preserves-pause');
  await tab('native');
  await api('native.pause', { sessionId, paused: true });
  await api('native.fullscreen', { sessionId, enabled: true });
  const background = await api('native.open', { filmId: film.id, position: 0, settings: { volume: 0 } });
  await api('native.stop', { sessionId: background.sessionId });
  assert.equal(
    (await status()).fullscreen,
    true,
    'Closing background playback must preserve the active full-screen player',
  );
  const observer = await api('native.open', { filmId: film.id, position: 0, settings: { volume: 0 } });
  try {
    await api('native.stop', { sessionId });
    assert.equal(
      (await api('native.status', { sessionId: observer.sessionId })).fullscreen,
      false,
      'Closing the full-screen owner must restore the host window',
    );
  } finally {
    await api('native.stop', { sessionId: observer.sessionId });
  }
  checks.push('fullscreen-ownership-and-session-close');
  await tab('home');
  assert.deepEqual(errors, []);
  const result = { passed: true, unprobedAtStart: film.duration === 0, checks, errors };
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await page.mouse.up().catch(() => {});
  await browser.close();
}
