// Native-window regression using the synthetic playback catalog only. Never resets a workspace/catalog.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const [endpoint, modulePath] = process.argv.slice(2);
assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint));
const { chromium } = await import(pathToFileURL(modulePath).href);
let browser, root;
const errors = [],
  checks = [];
const attach = async () => {
  await browser?.close();
  browser = await chromium.connectOverCDP(endpoint);
  const pages = browser.contexts().flatMap(c => c.pages());
  for (const p of pages) p.on('pageerror', e => errors.push(e.message));
  root = pages.find(p => p.url().endsWith('/index.html'));
  assert(root);
  return pages;
};
const wait = async (test, message) => {
  for (let i = 0; i < 100; i++) {
    if (await test()) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw Error(message);
};
const install = () => {
  window.dialogTestPending = new Map();
  window.dialogTestSessions = [];
  window.chrome.webview.addEventListener('message', e => {
    try {
      const m = JSON.parse(decodeURIComponent(e.data)),
        r = JSON.parse(m.response);
      if (r.ok && r.data?.sessionId && r.data?.embedded !== undefined) window.dialogTestSessions.push(r.data);
      const entry = window.dialogTestPending.get(m.id);
      if (entry) {
        window.dialogTestPending.delete(m.id);
        clearTimeout(entry.timer);
        r.ok ? entry.resolve(r.data) : entry.reject(Error(r.error));
      }
    } catch {}
  });
  window.dialogTestApi = (method, args = {}) =>
    new Promise((resolve, reject) => {
      const id = crypto.randomUUID(),
        timer = setTimeout(() => {
          window.dialogTestPending.delete(id);
          reject(Error('RPC timeout'));
        }, 10000);
      window.dialogTestPending.set(id, { resolve, reject, timer });
      window.chrome.webview.postMessage(
        encodeURIComponent('__RawMessage|' + JSON.stringify({ id, request: { method, args } })),
      );
    });
};
const api = (method, args = {}) => root.evaluate(([m, a]) => window.dialogTestApi(m, a), [method, args]);
const dialogs = async () =>
  (await (await fetch(endpoint + '/json/list')).json()).filter(t => t.url.includes('/dialog.html?'));
const popup = async (mode, except) => {
  await wait(
    async () => (await dialogs()).some(d => d.url.includes('mode=' + mode) && d.url !== except),
    'Native dialog target missing',
  );
  const p = (await attach()).find(p => p.url().includes('mode=' + mode) && p.url() !== except);
  assert(p);
  await p.getByRole('dialog').waitFor();
  return p;
};
const settings = async () => {
  await root.getByRole('button', { name: /^(字幕与播放设置|Subtitles and playback settings)$/ }).click();
  return popup('modeless');
};
try {
  await attach();
  await root.evaluate(install);
  const boot = await api('bootstrap');
  assert(
    boot.libraries.length && boot.libraries.every(l => l.name === 'Playback stability fixture'),
    'Not an isolated fixture',
  );
  await root.addInitScript(install);
  await root.reload();
  await root.locator('[role=tab][id$="-tab-native-one"]').click();
  await root.waitForFunction(() => window.dialogTestSessions.length > 0);
  assert(await root.evaluate(() => window.__vroomWindows));
  const session = (await root.evaluate(() => window.dialogTestSessions))[0].sessionId;
  const status = () => api('native.status', { sessionId: session });
  let p = await settings();
  const originalUrl = p.url(),
    originalTitle = await p.title();
  assert.equal(originalTitle, await p.locator('#window-title').textContent());
  assert.equal(await root.getByRole('dialog').count(), 0);
  assert.equal(await p.getByRole('dialog').getAttribute('aria-modal'), 'false');
  assert(await p.evaluate(() => !!opener && opener.document !== document));
  checks.push('separate-owned-document');
  await p.getByRole('button', { name: /^(单个影片循环 循环播放|Repeat current Repeat)$/ }).click();
  await p.getByRole('listbox').waitFor();
  assert.equal(await root.getByRole('listbox').count(), 0);
  await p.getByRole('option', { name: /^(单个影片循环|Repeat current)$/ }).click();
  checks.push('picker-stays-in-dialog');
  const speed = p.getByRole('textbox', { name: /^(播放速度|Playback speed)$/ });
  const originalSpeed = (await status()).speed;
  const targetSpeed = originalSpeed === 1.25 ? 1.5 : 1.25;
  await speed.fill(String(targetSpeed));
  await speed.press('Enter');
  await wait(async () => (await status()).speed === targetSpeed, 'Playback setting did not reach mpv');
  await wait(async () => (await speed.inputValue()) === String(targetSpeed), 'Live state did not reach the dialog');
  await speed.fill(String(originalSpeed));
  await speed.press('Enter');
  await wait(async () => (await status()).speed === originalSpeed, 'Speed restore failed');
  checks.push('live-player-setting');
  const paused = (await status()).pause;
  await root.getByRole('button', { name: paused ? /^(播放|Play)$/ : /^(暂停|Pause)$/ }).click();
  await wait(
    async () => (await status()).pause !== paused,
    'Main window did not respond while modeless window was open',
  );
  assert.equal(p.url(), originalUrl);
  assert.equal((await status()).exited, false);
  checks.push('modeless-main-interaction');
  const language = await root.evaluate(() => document.documentElement.lang);
  await root.locator('[role=tab][id$="-tab-fixture-settings"]').click();
  await root.getByRole('button', { name: /界面语言|Interface language/ }).click();
  await root.getByRole('option', { name: language === 'en' ? '简体中文' : 'English', exact: true }).click();
  await wait(
    async () =>
      (await p.title()) !== originalTitle && (await p.title()) === (await p.locator('#window-title').textContent()),
    'Dialog title did not follow locale',
  );
  assert.equal(p.url(), originalUrl);
  await root.getByRole('button', { name: /界面语言|Interface language/ }).click();
  await root.getByRole('option', { name: language === 'en' ? 'English' : '简体中文', exact: true }).click();
  await root.locator('[role=tab][id$="-tab-native-one"]').click();
  assert.equal(await root.evaluate(() => window.dialogTestSessions.length), 1);
  checks.push('locale-change-preserves-window-and-decoder');
  await p.getByRole('dialog').click({ button: 'right', position: { x: 12, y: 12 } });
  assert.equal(await root.locator('.context-menu').count(), 0);
  assert(await p.locator('.context-menu').count());
  const box = await p.locator('.context-menu').boundingBox(),
    view = await p.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert(box.x >= 0 && box.y >= 0 && box.x + box.width <= view.width && box.y + box.height <= view.height);
  checks.push('context-menu-in-own-viewport');
  await p.getByRole('textbox', { name: /^(快进步长（秒）|Seek step \(seconds\))$/ }).click();
  await p.getByRole('button', { name: /^(完成|Done)$/ }).click();
  await wait(async () => (await dialogs()).length === 0, 'Done did not destroy native window');
  checks.push('close-destroys-window');
  p = await settings();
  assert.notEqual(p.url(), originalUrl);
  await p.evaluate(() => dispatchEvent(new Event('vroom-window-close')));
  await wait(async () => (await dialogs()).length === 0, 'Native close request did not cancel');
  checks.push('native-close-cancels');
  await attach();
  await root.locator('[role=tab][id$="-tab-home"]').click();
  await root.getByRole('button', { name: /^(保存为智能列表|Save as smart list)$/ }).click();
  p = await popup('exclusive');
  assert.equal(await p.title(), await p.locator('#window-title').textContent());
  assert.equal(await p.getByRole('dialog').getAttribute('aria-modal'), 'true');
  await wait(() => p.evaluate(() => innerHeight < 400), 'Short dialog did not fit content');
  const name = p.getByRole('textbox', { name: /^(名称|Name)$/ });
  await name.fill('Window regression draft');
  await p.getByRole('button', { name: /^(取消|Cancel)$/ }).click();
  await wait(async () => (await dialogs()).length === 0, 'Exclusive cancel did not close');
  assert.equal((await api('bootstrap')).views.length, boot.views.length);
  checks.push('exclusive-cancel-without-save');
  await root.getByRole('button', { name: /^(整理|Organize)$/ }).click();
  await root.getByRole('button', { name: /^(标签|Tags)$/ }).click();
  await root.getByRole('radio', { name: /^(选项资料|Value profiles)$/ }).click();
  await root.getByRole('button', { name: /^(新增值|New value)$/ }).click();
  const parent = await popup('exclusive'),
    parentUrl = parent.url();
  const parentName = parent.getByRole('textbox', { name: /^(名称|Name)$/ });
  await parentName.fill('Parent draft');
  await parent.getByRole('button', { name: /编辑 名称 的多语言文案|Edit translations for Name/ }).click();
  const child = await popup('exclusive', parentUrl);
  assert.equal(await child.evaluate(() => opener.location.href), parentUrl);
  const nestedInput = child.getByRole('textbox').first();
  await nestedInput.fill('Child draft');
  await child.getByRole('button', { name: /^(取消|Cancel)$/ }).click();
  await wait(async () => (await dialogs()).length === 1, 'Nested cancel closed the wrong window');
  const parentAgain = (await attach()).find(p => p.url() === parentUrl);
  assert(parentAgain);
  assert.equal(await parentAgain.getByRole('textbox', { name: /^(名称|Name)$/ }).inputValue(), 'Parent draft');
  await parentAgain.getByRole('button', { name: /^(取消|Cancel)$/ }).click();
  await wait(async () => (await dialogs()).length === 0, 'Parent did not close');
  checks.push('nested-ownership-and-draft-cancellation');
  await attach();
  await root.locator('[role=tab][id$="-tab-native-one"]').click();
  p = await settings();
  await root.reload();
  await wait(async () => (await dialogs()).length === 0, 'Owner reload left an orphaned window');
  checks.push('owner-reload-cleans-windows');
  // Simulate a document that never mounts. The native timeout must release the hidden modal owner.
  await root.evaluate(() => {
    window.open(`dialog.html?id=${crypto.randomUUID()}&mode=exclusive&width=640&height=480`, '_blank', 'popup');
  });
  await wait(async () => (await dialogs()).length === 1, 'Timeout fixture did not open');
  const deadline = Date.now() + 18000;
  while ((await dialogs()).length && Date.now() < deadline) await new Promise(r => setTimeout(r, 200));
  assert.equal((await dialogs()).length, 0, 'Unready exclusive window left its owner blocked');
  checks.push('unready-window-timeout-cleanup');
  assert.deepEqual(errors, []);
  await fs.mkdir(new URL('../.artifacts/dialog-windows/', import.meta.url), { recursive: true });
  await fs.writeFile(
    new URL('../.artifacts/dialog-windows/result.json', import.meta.url),
    JSON.stringify(
      {
        passed: true,
        checks,
        limitations: [
          'OS input blocking and title-bar buttons require native UI verification.',
          'macOS native windows are not implemented.',
        ],
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: true, checks }));
} finally {
  await browser?.close();
}
