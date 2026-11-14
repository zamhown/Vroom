// Exercise the real native window against the synthetic catalog; no catalog or workspace reset.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const [endpoint, modulePath] = process.argv.slice(2);
assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint));
const { chromium } = await import(pathToFileURL(modulePath).href);
let browser = await chromium.connectOverCDP(endpoint);
let root = browser
  .contexts()
  .flatMap(c => c.pages())
  .find(p => p.url().endsWith('/index.html'));
assert(root);
const checks = [],
  errors = [];
const targets = async () =>
  (await (await fetch(endpoint + '/json/list')).json()).filter(t => t.url.includes('/dialog.html?'));
const wait = async (fn, message) => {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw Error(message);
};
const boot = await root.evaluate(
  () =>
    new Promise((resolve, reject) => {
      const id = crypto.randomUUID(),
        web = window.chrome.webview;
      const timer = setTimeout(() => {
        web.removeEventListener('message', receive);
        reject(Error('RPC timeout'));
      }, 10000);
      function receive(e) {
        try {
          const m = JSON.parse(decodeURIComponent(e.data));
          if (m.id !== id) return;
          clearTimeout(timer);
          web.removeEventListener('message', receive);
          const r = JSON.parse(m.response);
          r.ok ? resolve(r.data) : reject(Error(r.error));
        } catch {}
      }
      web.addEventListener('message', receive);
      web.postMessage(
        encodeURIComponent('__RawMessage|' + JSON.stringify({ id, request: { method: 'bootstrap', args: {} } })),
      );
    }),
);
assert(boot.libraries.length && boot.libraries.every(l => l.name === 'Playback stability fixture'));
assert.equal((await targets()).length, 0, 'Close existing fixture dialogs before this test');
const active = await root.getByRole('tab', { selected: true }).getAttribute('id');
let p;
const metrics = () =>
  p.evaluate(() => {
    const content = document.querySelector('.dialog-window-content'),
      body = document.querySelector('.dialog-window-body'),
      footer = document.querySelector('.dialog-window-actions');
    const style = getComputedStyle(content);
    return {
      height: innerHeight,
      width: innerWidth,
      outerHeight,
      screenY,
      screenX,
      available: screen.availHeight,
      availableTop: screen.availTop,
      natural: Math.ceil(
        body.scrollHeight +
          parseFloat(style.paddingTop) +
          parseFloat(style.paddingBottom) +
          footer.getBoundingClientRect().height,
      ),
      scrolling: content.scrollHeight > content.clientHeight + 1,
      footerBottom: footer.getBoundingClientRect().bottom,
      focus: document.activeElement?.id,
    };
  });
try {
  await root.locator('[role=tab][id$="-tab-native-one"]').click();
  await root.getByRole('button', { name: /^(字幕与播放设置|Subtitles and playback settings)$/ }).click();
  await wait(async () => (await targets()).length === 1, 'Settings did not open');
  await browser.close();
  browser = await chromium.connectOverCDP(endpoint);
  const pages = browser.contexts().flatMap(c => c.pages());
  root = pages.find(p => p.url().endsWith('/index.html'));
  p = pages.find(p => p.url().includes('/dialog.html?'));
  for (const page of pages) page.on('pageerror', e => errors.push(e.message));
  await p.getByRole('dialog').waitFor();
  await wait(async () => {
    const m = await metrics();
    return m.height >= m.natural && !m.scrolling;
  }, 'Initial content did not fit');
  const initial = await metrics();
  console.log('initial', JSON.stringify(initial));
  await p.getByRole('radio', { name: /^(画面|Image)$/ }).click();
  await wait(async () => {
    const m = await metrics();
    return m.height > initial.height + 20;
  }, 'Window did not grow after switching settings group');
  const expanded = await metrics();
  await p.getByRole('radio', { name: /^(播放|Playback)$/ }).click();
  await wait(async () => {
    const m = await metrics();
    return Math.abs(m.height - initial.height) <= 2 && !m.scrolling;
  }, 'Window did not shrink back');
  checks.push('settings-group-growth-and-shrinkage');
  await p.getByRole('textbox', { name: /^(快进步长（秒）|Seek step \(seconds\))$/ }).focus();
  const focus = (await metrics()).focus;
  // A bounded fixture node stresses long asynchronous content without changing application data.
  await p.evaluate(() => {
    const block = document.createElement('div');
    block.id = 'autosize-fixture';
    block.style.height = '5000px';
    document.querySelector('.dialog-window-body').append(block);
  });
  await wait(async () => {
    const m = await metrics();
    return m.height > initial.height && m.scrolling;
  }, 'Long content did not reach the scrolling limit');
  const capped = await metrics();
  assert(
    capped.height <= capped.available && capped.height >= capped.available - 100,
    'Window must use the monitor work area before scrolling',
  );
  assert(capped.footerBottom <= capped.height + 1, 'Actions must remain visible');
  assert.equal(capped.focus, focus);
  const sizes = [];
  for (let i = 0; i < 8; i++) {
    sizes.push((await metrics()).height);
    await new Promise(r => setTimeout(r, 100));
  }
  assert(
    sizes.every(h => h === capped.height),
    'Content/scrollbar feedback caused oscillation',
  );
  checks.push('screen-height-cap-with-fixed-actions', 'stable-size-without-focus-loss');
  await p.evaluate(() => document.querySelector('#autosize-fixture').remove());
  await wait(async () => {
    const m = await metrics();
    return Math.abs(m.height - initial.height) <= 2 && !m.scrolling;
  }, 'Removing content did not shrink and remove scrollbar');
  const shrunk = await metrics();
  assert.equal(shrunk.focus, focus);
  assert.equal(shrunk.width, initial.width);
  checks.push('shrink-after-overflow-removes-scrollbar');
  await p.evaluate(() => {
    const block = document.createElement('div');
    block.id = 'autosize-footer';
    block.style.cssText = 'flex-basis:100%;height:80px';
    document.querySelector('.dialog-window-actions').append(block);
  });
  await wait(async () => {
    const m = await metrics();
    return m.height >= initial.height + 80 && !m.scrolling;
  }, 'Wrapped actions did not grow the window');
  await p.evaluate(() => document.querySelector('#autosize-footer').remove());
  await wait(
    async () => Math.abs((await metrics()).height - initial.height) <= 2,
    'Actions shrink did not resize window',
  );
  checks.push('footer-height-tracking');
  await p.getByRole('button', { name: /^(完成|Done)$/ }).click();
  await wait(async () => (await targets()).length === 0, 'Window did not close');
  await root.locator(`[role=tab][id=${JSON.stringify(active)}]`).click();
  assert.deepEqual(errors, []);
  const result = {
    passed: true,
    checks,
    initial,
    expanded,
    capped,
    shrunk,
    limitations: ['Physical multi-monitor/DPI dragging and macOS are not verified.'],
  };
  await fs.mkdir(new URL('../.artifacts/dialog-sizing/', import.meta.url), { recursive: true });
  await fs.writeFile(
    new URL('../.artifacts/dialog-sizing/result.json', import.meta.url),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify({ passed: true, checks }));
} finally {
  if (p && !p.isClosed())
    await p
      .evaluate(() => {
        document.querySelector('#autosize-fixture')?.remove();
        document.querySelector('#autosize-footer')?.remove();
      })
      .catch(() => {});
  await browser.close();
}
