// Attach only to an explicitly launched test MAUI host with an isolated catalog and WebView profile.
// The catalog must contain only the synthetic fixture from verify-playback-stability.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [endpoint, playwrightModule] = process.argv.slice(2);
assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint));
const { chromium } = await import(pathToFileURL(playwrightModule).href);
const browser = await chromium.connectOverCDP(endpoint);
const page = browser
  .contexts()[0]
  .pages()
  .find(p => p.url().startsWith('https://0.0.0.1'));
assert(page, 'Test HybridWebView not found');
const root = path.resolve(import.meta.dirname, '..'),
  output = path.join(root, '.artifacts', 'mpv-review');
await fs.mkdir(output, { recursive: true });
await page.addInitScript(() => {
  window.testPending = new Map();
  window.nativeOpened = [];
  window.nativeSurfaces = [];
  const originalSend = window.chrome.webview.postMessage.bind(window.chrome.webview);
  window.chrome.webview.postMessage = data => {
    try {
      const message = JSON.parse(decodeURIComponent(data).slice('__RawMessage|'.length));
      if (message.request?.method === 'native.surface') window.nativeSurfaces.push(message.request.args);
    } catch {}
    originalSend(data);
  };
  window.chrome.webview.addEventListener('message', e => {
    try {
      const message = JSON.parse(decodeURIComponent(e.data)),
        result = JSON.parse(message.response);
      if (result.ok && result.data?.sessionId && result.data.embedded !== undefined)
        window.nativeOpened.push(result.data);
      const complete = window.testPending.get(message.id);
      if (complete) {
        window.testPending.delete(message.id);
        complete(result);
      }
    } catch {}
  });
  window.testApi = (method, args = {}) =>
    new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      window.testPending.set(id, result => (result.ok ? resolve(result.data) : reject(Error(JSON.stringify(result)))));
      window.chrome.webview.postMessage(
        encodeURIComponent('__RawMessage|' + JSON.stringify({ id, request: { method, args } })),
      );
    });
  localStorage.setItem('vroom.locale', 'zh-CN');
});
const api = (method, args = {}) => page.evaluate(([method, args]) => window.testApi(method, args), [method, args]);
const wait = async (condition, message) => {
  for (let i = 0; i < 80; i++) {
    if (await condition()) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw Error(message);
};
let dialogBrowser;
const openSettings = async () => {
  await page.getByRole('button', { name: /^(字幕与播放设置|Subtitles and playback settings)$/ }).click();
  await wait(
    async () => (await (await fetch(endpoint + '/json/list')).json()).some(t => t.url.includes('/dialog.html?')),
    'Settings window did not open',
  );
  await dialogBrowser?.close();
  dialogBrowser = await chromium.connectOverCDP(endpoint);
  const settings = dialogBrowser
    .contexts()
    .flatMap(c => c.pages())
    .find(p => p.url().includes('/dialog.html?'));
  assert(settings);
  await settings.getByRole('dialog').waitFor();
  return settings;
};
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.reload();
  await page.waitForFunction(() => window.testApi);
  const bootstrap = await api('bootstrap');
  assert(
    bootstrap.libraries.length && bootstrap.libraries.every(l => l.name === 'Playback stability fixture'),
    'Non-review catalog',
  );
  const caps = await api('native.capabilities');
  assert(caps.available && caps.embedded);
  const film = (await api('films.query', {})).films[0];
  assert(film);
  await api('workspace.save', {
    version: 3,
    activeId: 'native-one',
    tabs: [
      { id: 'home', kind: 'library', title: 'Home', state: {} },
      ...['native-one', 'native-two'].map(id => ({
        id,
        kind: 'player',
        title: id,
        params: { filmId: film.id },
        state: { repeat: 'one', muted: true },
      })),
      { id: 'fixture-settings', kind: 'settings', title: 'Fixture settings', state: {} },
    ],
  });
  // Prevent the old mounted workspace's unload handler from replacing the test workspace.
  await page.evaluate(() => {
    const send = window.chrome.webview.postMessage.bind(window.chrome.webview);
    window.chrome.webview.postMessage = data => {
      try {
        if (JSON.parse(decodeURIComponent(data).slice('__RawMessage|'.length)).request.method === 'workspace.save')
          return;
      } catch {}
      send(data);
    };
  });
  await page.reload();
  await page.waitForFunction(() => window.nativeOpened?.length > 0, null, { timeout: 30000 });
  const first = (await page.evaluate(() => window.nativeOpened))[0].sessionId;
  const status = id => api('native.status', { sessionId: id });
  await wait(async () => (await status(first))['time-pos'] > 0, 'native clock did not advance');
  await api('native.pause', { sessionId: first, paused: true });
  let settings = await openSettings();
  await wait(
    () =>
      page.evaluate(
        id =>
          window.__vroomComposition &&
          window.nativeSurfaces.some(s => s.sessionId === id && s.bounds.visible && !('occlusions' in s.bounds)),
        first,
      ),
    'Dialogs must overlay composed video without clipping regions',
  );
  await settings.getByRole('radio', { name: '音频', exact: true }).click();
  await settings.getByRole('textbox', { name: '音频延迟（秒）', exact: true }).fill('0.35');
  await settings.getByRole('textbox', { name: '音频延迟（秒）', exact: true }).press('Tab');
  await wait(async () => Math.abs((await status(first))['audio-delay'] - 0.35) < 0.001, 'live audio delay failed');
  await api('native.track', { sessionId: first, kind: 'aid', track: 2 });
  await wait(async () => (await status(first)).aid === 2, 'audio track switch failed');
  await settings.screenshot({ path: path.join(output, 'audio-settings.png') });
  await settings.getByRole('radio', { name: '画面', exact: true }).click();
  await settings.getByRole('textbox', { name: '亮度', exact: true }).fill('12');
  await settings.getByRole('textbox', { name: '亮度', exact: true }).press('Tab');
  await wait(async () => (await status(first)).brightness === 12, 'live brightness failed');
  await settings.getByRole('radio', { name: '渲染', exact: true }).click();
  await settings.screenshot({ path: path.join(output, 'render-settings.png') });
  await settings.getByRole('radio', { name: '字幕', exact: true }).click();
  await api('native.subtitle', {
    sessionId: first,
    name: 'fixture.ass',
    data: Buffer.from(
      '[Script Info]\nScriptType: v4.00+\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,28,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:20.00,Default,,0,0,0,,Native subtitle fixture\n',
    ).toString('base64'),
  });
  await wait(
    async () => (await status(first))['track-list'].some(t => t.type === 'sub' && t.selected),
    'external ASS subtitle was not selected',
  );
  await settings.getByRole('button', { name: '完成', exact: true }).click();
  await api('native.seek', { sessionId: first, position: 3 });
  await wait(async () => Math.abs((await status(first))['time-pos'] - 3) < 0.1, 'exact seek failed');
  const screenshot = await api('native.screenshot', { sessionId: first, subtitles: true });
  assert(screenshot.startsWith('data:image/png;base64,'));
  await fs.writeFile(path.join(output, 'native-frame.png'), Buffer.from(screenshot.split(',')[1], 'base64'));
  await page.locator('.native-video-surface').click({ button: 'right', position: { x: 150, y: 150 } });
  await page.locator('.context-menu').waitFor();
  await page.screenshot({ path: path.join(output, 'native-menu.png') });
  await page.keyboard.press('Escape');
  await page.locator('[data-tab-id="native-two"]').click();
  await wait(async () => (await page.evaluate(() => window.nativeOpened)).length === 2, 'second tab did not open');
  const second = (await page.evaluate(() => window.nativeOpened))[1].sessionId;
  assert.equal((await status(first)).pause, true);
  assert.equal((await status(second)).brightness, 0);
  await api('native.settings', { sessionId: second, values: { speed: 1.5 } });
  assert.equal((await status(first)).speed, 1);
  await page.locator('[data-tab-id="fixture-settings"]').click();
  await page.locator('button[aria-label="界面语言"]').click();
  await page.getByRole('option', { name: 'English', exact: true }).click();
  await page.locator('[data-tab-id="native-one"]').click();
  assert.equal((await page.evaluate(() => window.nativeOpened)).length, 2, 'language change remounted native player');
  settings = await openSettings();
  await settings.getByRole('radio', { name: 'Rendering', exact: true }).click();
  await settings.screenshot({ path: path.join(output, 'english-settings.png') });
  await settings.getByRole('button', { name: 'Done', exact: true }).click();
  // Stop one session and ensure another session's settings and IPC remain live.
  await api('native.stop', { sessionId: first });
  assert.equal((await status(second)).speed, 1.5);
  assert.equal((await status(second)).exited, false);
  await api('native.stop', { sessionId: second });
  assert.deepEqual(errors, []);
  const result = {
    passed: true,
    engine: (await api('native.capabilities')).engine,
    checks: [
      'embedded-native-clock',
      'overlay-keeps-video-visible',
      'live-audio-delay',
      'audio-track',
      'picture-adjustment',
      'ASS-subtitles',
      'native-screenshot',
      'custom-menu',
      'two-tabs',
      'locale-preserves-sessions',
      'independent-stop',
    ],
    screenshots: output,
  };
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await dialogBrowser?.close();
  await browser.close();
}
