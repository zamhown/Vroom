// Geometry and keyboard regression checks against the isolated native playback review host.
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
const output = path.resolve(import.meta.dirname, '../.artifacts/context-menu');
await fs.mkdir(output, { recursive: true });
const errors = [],
  checks = [];
page.on('pageerror', error => errors.push(error.message));
const cdp = await page.context().newCDPSession(page);
const snapshot = () =>
  page.locator('.context-menu').evaluate(el => {
    const r = el.getBoundingClientRect(),
      v = visualViewport;
    return {
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
      viewport: { left: v.offsetLeft, top: v.offsetTop, width: v.width, height: v.height },
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    };
  });
const contained = async name => {
  await page
    .waitForFunction(
      () => {
        const el = document.querySelector('.context-menu'),
          v = visualViewport;
        if (!el || !el.querySelector('[role=menuitem]')) return false;
        const r = el.getBoundingClientRect();
        return (
          r.left >= v.offsetLeft + 7 &&
          r.top >= v.offsetTop + 7 &&
          r.right <= v.offsetLeft + v.width - 7 &&
          r.bottom <= v.offsetTop + v.height - 7
        );
      },
      null,
      { timeout: 4000 },
    )
    .catch(async error => {
      console.error(name, await snapshot());
      throw error;
    });
  const result = await snapshot();
  assert(result.scrollWidth <= result.clientWidth + 1, 'Menu must not require horizontal scrolling');
  checks.push({ name, ...result });
  return result;
};
const open = async (x, y) => {
  // Use the same contextmenu event the native mouse bridge forwards, including points at client edges.
  await page
    .locator('.video-stage:visible')
    .evaluate(
      (el, { x, y }) =>
        el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y })),
      { x, y },
    );
  await page.locator('.context-menu [role=menuitem]').last().waitFor();
};
try {
  const bootstrap = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        const handler = e => {
          try {
            const m = JSON.parse(decodeURIComponent(e.data));
            if (m.id !== id) return;
            clearTimeout(timer);
            window.chrome.webview.removeEventListener('message', handler);
            const r = JSON.parse(m.response);
            r.ok ? resolve(r.data) : reject(Error(r.error));
          } catch {}
        };
        const timer = setTimeout(() => {
          window.chrome.webview.removeEventListener('message', handler);
          reject(Error('bootstrap timeout'));
        }, 10000);
        window.chrome.webview.addEventListener('message', handler);
        window.chrome.webview.postMessage(
          encodeURIComponent('__RawMessage|' + JSON.stringify({ id, request: { method: 'bootstrap', args: {} } })),
        );
      }),
  );
  assert(
    bootstrap.libraries.length && bootstrap.libraries.every(l => l.name === 'Playback stability fixture'),
    'Not an isolated review catalog',
  );
  await page.reload();
  await page.locator('[role=tab][id$="-tab-native-one"]').click();
  await page.locator('.native-video-surface:visible').waitFor();
  const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  for (const [name, x, y] of [
    ['bottom-right', size.width - 2, size.height - 2],
    ['top-right', size.width - 2, 2],
    ['bottom-left', 2, size.height - 2],
    ['top-left', 2, 2],
  ]) {
    await open(x, y);
    const result = await contained(name);
    if (name.includes('right')) assert(result.right <= x + 0.5, 'Should flip to the left');
    if (name.includes('bottom')) assert(result.bottom <= y + 0.5, 'Should flip upwards');
  }
  await open(size.width - 2, size.height - 2);
  await contained('before-label-growth');
  const originalLabel = await page.locator('.context-menu [role=menuitem]').first().textContent();
  await page
    .locator('.context-menu [role=menuitem]')
    .first()
    .evaluate(el => {
      el.textContent = 'Long localized action '.repeat(30);
    });
  await contained('after-label-growth');
  await page
    .locator('.context-menu [role=menuitem]')
    .first()
    .evaluate((el, label) => {
      el.textContent = label;
    }, originalLabel);
  await open(size.width - 2, size.height - 2);
  for (const [width, height] of [
    [320, 240],
    [160, 180],
  ]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    const result = await contained(`resize-${width}x${height}`);
    assert(result.scrollHeight > result.clientHeight, 'Long menus must scroll in a short window');
    await page.keyboard.press('End');
    await page.waitForFunction(() => {
      const menu = document.querySelector('.context-menu'),
        last = menu.querySelector('[role=menuitem]:last-child');
      const m = menu.getBoundingClientRect(),
        r = last.getBoundingClientRect();
      return last === document.activeElement && r.top >= m.top && r.bottom <= m.bottom;
    });
    checks.push({ name: `keyboard-last-item-${width}x${height}`, passed: true });
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await page.waitForFunction(
    () =>
      Math.abs(
        Number.parseFloat(getComputedStyle(document.querySelector('.context-menu')).maxHeight) -
          (visualViewport.height - 16),
      ) < 1,
  );
  await contained('restored-window');
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, checks }, null, 2));
  console.log(JSON.stringify({ passed: true, checks: checks.map(c => c.name) }));
} finally {
  await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
  await browser.close();
}
