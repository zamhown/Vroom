// Use only the isolated synthetic playback catalog. No catalog/workspace reset.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [endpoint, modulePath] = process.argv.slice(2);
assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint));
const { chromium } = await import(pathToFileURL(modulePath).href);
const browser = await chromium.connectOverCDP(endpoint);
const page = browser
  .contexts()[0]
  .pages()
  .find(p => p.url().startsWith('https://0.0.0.1'));
assert(page);
const output = path.resolve(import.meta.dirname, '../.artifacts/composition');
await fs.mkdir(output, { recursive: true });
const errors = [],
  checks = [];
page.on('pageerror', error => errors.push(error.message));
const install = () => {
  window.compositionPending = new Map();
  window.compositionSessions = [];
  window.compositionSurfaces = [];
  const send = window.chrome.webview.postMessage.bind(window.chrome.webview);
  window.chrome.webview.postMessage = data => {
    try {
      const m = JSON.parse(decodeURIComponent(data).slice('__RawMessage|'.length));
      if (m.request?.method === 'native.surface') window.compositionSurfaces.push(m.request.args);
    } catch {}
    send(data);
  };
  window.chrome.webview.addEventListener('message', e => {
    try {
      const m = JSON.parse(decodeURIComponent(e.data)),
        r = JSON.parse(m.response);
      if (r.ok && r.data?.sessionId && r.data?.embedded !== undefined) window.compositionSessions.push(r.data);
      const entry = window.compositionPending.get(m.id);
      if (entry) {
        window.compositionPending.delete(m.id);
        clearTimeout(entry.timer);
        r.ok ? entry.resolve(r.data) : entry.reject(Error(r.error));
      }
    } catch {}
  });
  window.compositionApi = (method, args = {}) =>
    new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        window.compositionPending.delete(id);
        reject(Error('RPC timeout'));
      }, 15000);
      window.compositionPending.set(id, { resolve, reject, timer });
      send(encodeURIComponent('__RawMessage|' + JSON.stringify({ id, request: { method, args } })));
    });
};
const api = (method, args = {}) => page.evaluate(([m, a]) => window.compositionApi(m, a), [method, args]);
const wait = async (test, message) => {
  for (let i = 0; i < 100; i++) {
    if (await test()) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw Error(message);
};
try {
  await page.evaluate(install);
  const boot = await api('bootstrap');
  assert(
    boot.libraries.length && boot.libraries.every(l => l.name === 'Playback stability fixture'),
    'Not an isolated review catalog',
  );
  assert.equal(boot.apiVersion, 8);
  await page.addInitScript(install);
  await page.reload();
  await page.locator('[role=tab][id$="-tab-native-one"]').click();
  await page.waitForFunction(
    () => window.compositionSessions.length > 0 && document.querySelector('[data-composited-video=true]'),
  );
  assert(await page.evaluate(() => window.__vroomComposition));
  const first = (await page.evaluate(() => window.compositionSessions))[0].sessionId;
  const status = () => api('native.status', { sessionId: first });
  const paused = async value => {
    await wait(async () => (await status()).pause === value, 'Pause command did not settle');
    await page.getByRole('button', { name: value ? /^(播放|Play)$/ : /^(暂停|Pause)$/ }).waitFor();
  };
  const stage = page.locator('[data-composited-video=true]');
  const transparent = await stage.evaluate(el => {
    const result = [];
    for (let p = el; p; p = p.parentElement) result.push(getComputedStyle(p).backgroundColor);
    return result;
  });
  assert(transparent.every(color => color === 'rgba(0, 0, 0, 0)'));
  checks.push('transparent-video-ancestor-chain');
  await api('native.pause', { sessionId: first, paused: true });
  await api('native.seek', { sessionId: first, position: 3 });
  await paused(true);
  await stage.click();
  await paused(false);
  await stage.click();
  await paused(true);
  checks.push('click-toggle');
  await stage.focus();
  await page.keyboard.press('Space');
  await paused(false);
  await page.keyboard.press('Space');
  await paused(true);
  checks.push('keyboard-toggle');
  const initialSize = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  await stage.dblclick();
  await wait(() => page.evaluate(h => innerHeight !== h, initialSize.height), 'double click did not enter fullscreen');
  assert.equal((await status()).pause, true, 'Double click must not toggle pause');
  await api('native.fullscreen', { sessionId: first, enabled: false });
  await wait(() => page.evaluate(h => innerHeight === h, initialSize.height), 'fullscreen did not restore bounds');
  checks.push('fullscreen-preserves-pause');
  await stage.click({ button: 'right', position: { x: 40, y: 40 } });
  await page.locator('.context-menu').waitFor();
  await wait(
    () => page.evaluate(id => window.compositionSurfaces.some(s => s.sessionId === id && s.bounds.visible), first),
    'surface is not visible',
  );
  const overlay = await page
    .locator('.context-menu')
    .evaluate(el => ({ radius: getComputedStyle(el).borderTopLeftRadius, shadow: getComputedStyle(el).boxShadow }));
  assert.notEqual(overlay.radius, '0px');
  assert.notEqual(overlay.shadow, 'none');
  assert(await page.evaluate(() => window.compositionSurfaces.every(s => !('occlusions' in s.bounds))));
  await api('native.pause', { sessionId: first, paused: false });
  const before = (await status())['time-pos'];
  await wait(async () => (await status())['time-pos'] !== before, 'Video must continue while a menu is open');
  checks.push('menu-keeps-video-running-without-clipping');
  await page.locator('[role=tab][id$="-tab-native-two"]').click();
  await page.waitForFunction(() => window.compositionSessions.length === 2);
  const second = (await page.evaluate(() => window.compositionSessions))[1].sessionId;
  await wait(async () => (await status()).pause, 'Hidden tab did not pause');
  assert.equal((await api('native.status', { sessionId: second })).exited, false);
  await page.locator('[role=tab][id$="-tab-native-one"]').click();
  assert.equal(await page.evaluate(() => window.compositionSessions.length), 2);
  checks.push('tab-switch-preserves-decoders');
  // Modals now use owned OS windows. The remaining in-page menus still need alpha composition.
  // Leave a playing menu available for actual Windows inspection; CDP cannot capture the decoder HWND.
  await api('native.pause', { sessionId: first, paused: false });
  await stage.click({ button: 'right', position: { x: 40, y: 40 } });
  await page.locator('.context-menu').waitFor();
  assert.deepEqual(errors, []);
  const result = {
    passed: true,
    checks,
    overlay,
    decoder: await status(),
    limitations: [
      'DOM checks do not prove final HWND pixel blending; inspect the actual Windows window separately.',
      'macOS is not validated by this script.',
    ],
  };
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ passed: true, checks }));
} finally {
  await browser.close();
}
