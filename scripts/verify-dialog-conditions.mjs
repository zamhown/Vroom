// Node >= 22. Uses raw CDP: Playwright's automatic focus emulation masks opener-owned ResizeObservers.
// Only uses an empty development catalog (or the playback fixture); edits are cancelled, never applied.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const [endpoint] = process.argv.slice(2);
assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint));
assert.equal(typeof WebSocket, 'function', 'Run with Node 22 or newer');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const targets = async () => await (await fetch(endpoint + '/json/list')).json();
const dialogs = async () => (await targets()).filter(t => t.url.includes('/dialog.html?'));
const connections = [],
  checks = [];
async function connect(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl),
    pending = new Map();
  let id = 0;
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  socket.onmessage = ({ data }) => {
    const m = JSON.parse(data),
      p = pending.get(m.id);
    if (p) {
      pending.delete(m.id);
      clearTimeout(p.timer);
      m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const key = ++id,
        timer = setTimeout(() => {
          pending.delete(key);
          reject(Error(method + ' timeout'));
        }, 10000);
      pending.set(key, { resolve, reject, timer });
      socket.send(JSON.stringify({ id: key, method, params }));
    });
  const c = {
    send,
    close: () => socket.close(),
    eval: async expression => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
      return r.result.value;
    },
  };
  connections.push(c);
  await c.eval(
    `window.dialogConditionErrors=[];addEventListener('error',e=>dialogConditionErrors.push(e.message));addEventListener('unhandledrejection',e=>dialogConditionErrors.push(String(e.reason)));`,
  );
  return c;
}
async function wait(test, message) {
  for (let i = 0; i < 40; i++) {
    const result = await test();
    if (result) return result;
    await pause(100);
  }
  throw Error(message);
}
async function click(page, selector, pattern, index = 0) {
  const point = await page.eval(`(() => {
    const elements = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(e => new RegExp(${JSON.stringify(pattern)}).test(e.textContent.trim() || e.getAttribute('aria-label') || ''));
    const e = elements[${index}]; if (!e) throw Error('Control missing: ' + ${JSON.stringify(pattern)});
    e.scrollIntoView({block: 'nearest'}); const r = e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};
  })()`);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
}
const metrics = p =>
  p.eval(`(() => {
  const c=document.querySelector('.dialog-window-content'),b=document.querySelector('.dialog-window-body'),f=document.querySelector('.dialog-window-actions'),s=getComputedStyle(c);
  return {height:innerHeight,natural:Math.ceil(b.scrollHeight+parseFloat(s.paddingTop)+parseFloat(s.paddingBottom)+f.getBoundingClientRect().height),scrolling:c.scrollHeight>c.clientHeight+1,footerBottom:f.getBoundingClientRect().bottom,available:screen.availHeight};
})()`);
const noAlerts = p => p.eval(`![...document.querySelectorAll('[role=alert]')].some(e=>e.textContent.trim())`);
try {
  const root = await connect((await targets()).find(t => t.url.endsWith('/index.html')));
  const boot = await root.eval(`new Promise((resolve,reject)=>{
    const id=crypto.randomUUID(),w=chrome.webview,timer=setTimeout(()=>{w.removeEventListener('message',receive);reject(Error('RPC timeout'));},10000);
    function receive(e){try{const m=JSON.parse(decodeURIComponent(e.data));if(m.id!==id)return;w.removeEventListener('message',receive);clearTimeout(timer);const r=JSON.parse(m.response);r.ok?resolve(r.data):reject(Error(r.error));}catch{}}
    w.addEventListener('message',receive);w.postMessage(encodeURIComponent('__RawMessage|'+JSON.stringify({id,request:{method:'bootstrap',args:{}}})));
  })`);
  assert(
    boot.libraries.length
      ? boot.libraries.every(l => l.name === 'Playback stability fixture')
      : boot.tagging.generation === 1,
    'Use an empty development catalog or the playback fixture',
  );
  assert.equal((await dialogs()).length, 0, 'Close fixture dialogs first');
  assert(await noAlerts(root), 'Existing error toast; inspect it before running');
  const active = await root.eval(`document.querySelector('[role=tab][aria-selected=true]')?.id`);
  if (!(await root.eval(`!!document.querySelector('.definition-designer')`))) {
    await click(root, 'button', '^(整理|Organize)$');
    await click(root, 'button', '^(标签|Tags)$');
  }
  await wait(() => root.eval(`!!document.querySelector('.definition-designer')`), 'Definition editor did not load');
  await click(root, '[role=radio]', '^(自动解析与更新|Automation)$');
  await click(root, '.condition-rules button', '^(添加规则|Add rule)$');
  const target = await wait(async () => (await dialogs())[0], 'Condition window did not open');
  let p = await connect(target);
  await wait(() => p.eval(`!!document.querySelector('.dialog-window-body')`), 'Condition document did not mount');
  await wait(async () => {
    const m = await metrics(p);
    return !m.scrolling && Math.abs(m.height - m.natural) <= 2;
  }, 'Initial height did not fit');
  const initial = await metrics(p);
  assert(await noAlerts(p));
  checks.push('first-condition-window-without-error');
  await pause(1500);
  // Do not evaluate the opener during growth/shrink: doing so can accidentally wake its rendering loop.
  await click(p, 'button', '^(添加条件|Add condition)$');
  await wait(async () => {
    const m = await metrics(p);
    return m.height > initial.height + 50 && !m.scrolling;
  }, 'Condition did not grow without focus emulation');
  const expanded = await metrics(p);
  checks.push('exclusive-condition-growth-with-idle-opener');
  await click(p, 'button', '^(移除条件|Remove condition)$', 1);
  await wait(async () => {
    const m = await metrics(p);
    return Math.abs(m.height - initial.height) <= 2 && !m.scrolling;
  }, 'Condition did not shrink');
  checks.push('condition-removal-shrinks-window');
  await click(p, 'button', '^(添加条件组|Add condition group)$');
  await wait(async () => {
    const m = await metrics(p);
    return m.height > initial.height + 50 && !m.scrolling;
  }, 'Nested condition group did not grow');
  checks.push('nested-condition-group-growth');
  for (let i = 0; i < 9; i++) await click(p, 'button', '^(添加条件|Add condition)$');
  await wait(async () => {
    const m = await metrics(p);
    return m.scrolling && m.height >= m.available - 100 && m.footerBottom <= m.height + 1;
  }, 'Window did not use screen height before scrolling');
  const capped = await metrics(p);
  checks.push('condition-screen-limit-with-visible-actions');
  assert(await noAlerts(p));
  assert.deepEqual(await p.eval('dialogConditionErrors'), []);
  await click(p, '.dialog-window-actions button', '^(取消|Cancel)$');
  await wait(async () => !(await dialogs()).length, 'Cancel did not close');
  for (let i = 0; i < 3; i++) {
    await click(root, '.condition-rules button', '^(添加规则|Add rule)$');
    const t = await wait(async () => (await dialogs())[0], 'Reopen failed');
    p = await connect(t);
    await wait(() => p.eval(`!!document.querySelector('.dialog-window-actions')`), 'Reopened document did not mount');
    assert(await noAlerts(p));
    assert.deepEqual(await p.eval('dialogConditionErrors'), []);
    await click(p, '.dialog-window-actions button', '^(取消|Cancel)$');
    await wait(async () => !(await dialogs()).length, 'Reopen cancel failed');
  }
  checks.push('repeated-open-cancel-without-error');
  assert(await noAlerts(root));
  assert.deepEqual(await root.eval('dialogConditionErrors'), []);
  if (active) await root.eval(`document.getElementById(${JSON.stringify(active)})?.click()`);
  await fs.mkdir(new URL('../.artifacts/dialog-conditions/', import.meta.url), { recursive: true });
  const result = {
    passed: true,
    checks,
    initial,
    expanded,
    capped,
    focusEmulation: false,
    limitations: [
      'CDP input is not a physical mouse; native screenshots are checked separately.',
      'The reported first-open toast was not reproduced.',
    ],
  };
  await fs.writeFile(
    new URL('../.artifacts/dialog-conditions/result.json', import.meta.url),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  for (const c of connections) c.close();
}
