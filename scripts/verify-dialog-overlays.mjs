// Node >= 22, raw CDP without focus emulation. Only temporary, cancelled fixture edits.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const [endpoint] = process.argv.slice(2);
assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint));
const targets = async () => await (await fetch(endpoint + '/json/list')).json();
const dialogs = async () => (await targets()).filter(t => t.url.includes('/dialog.html?'));
const pause = ms => new Promise(r => setTimeout(r, ms)),
  connections = [],
  checks = [];
async function connect(t) {
  const socket = new WebSocket(t.webSocketDebuggerUrl),
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
    `window.overlayErrors=[];addEventListener('error',e=>overlayErrors.push(e.message));addEventListener('unhandledrejection',e=>overlayErrors.push(String(e.reason)));`,
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
async function click(p, selector, index = 0, button = 'left') {
  const point = await p.eval(
    `(()=>{const e=document.querySelectorAll(${JSON.stringify(selector)})[${index}];if(!e)throw Error('Missing control');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
  );
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', button, clickCount: 1, ...point });
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button, clickCount: 1, ...point });
}
async function key(p, key, code = key, virtual = 0) {
  for (const type of ['keyDown', 'keyUp'])
    await p.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: virtual });
}
const metrics = p =>
  p.eval(
    `(()=>{const e=document.querySelector('[data-placement]'),l=document.querySelector('[role=listbox],[role=menu]');if(!e||!l)return null;const r=e.getBoundingClientRect();return {width:innerWidth,height:innerHeight,x:r.x,y:r.y,right:r.right,bottom:r.bottom,placement:e.dataset.placement,listHeight:l.clientHeight,listScroll:l.scrollHeight,scrollTop:l.scrollTop};})()`,
  );
const fits = m => m && m.x >= -1 && m.y >= -1 && m.right <= m.width + 1 && m.bottom <= m.height + 1;
let root, p;
async function popup() {
  const t = await wait(async () => (await dialogs())[0], 'Window did not open');
  const p = await connect(t);
  await wait(() => p.eval(`!!document.querySelector('.dialog-window-body')`), 'Window did not mount');
  return p;
}
async function cancel() {
  await p.eval(`document.querySelector('.dialog-window-actions button').click()`);
  await wait(async () => !(await dialogs()).length, 'Cancel did not close');
}
try {
  root = await connect((await targets()).find(t => t.url.endsWith('/index.html')));
  const boot = await root.eval(
    `new Promise((resolve,reject)=>{const id=crypto.randomUUID(),w=chrome.webview,timer=setTimeout(()=>{w.removeEventListener('message',receive);reject(Error('RPC timeout'));},10000);function receive(e){try{const m=JSON.parse(decodeURIComponent(e.data));if(m.id!==id)return;clearTimeout(timer);w.removeEventListener('message',receive);const r=JSON.parse(m.response);r.ok?resolve(r.data):reject(Error(r.error));}catch{}}w.addEventListener('message',receive);w.postMessage(encodeURIComponent('__RawMessage|'+JSON.stringify({id,request:{method:'bootstrap',args:{}}})));})`,
  );
  assert(
    boot.libraries.length
      ? boot.libraries.every(l => l.name === 'Playback stability fixture')
      : boot.tagging.generation === 1,
    'Use a development fixture',
  );
  assert.equal((await dialogs()).length, 0, 'Close existing fixture dialogs');
  assert(
    await root.eval(`!!document.querySelector('.definition-designer')`),
    'Open the fixture tag configuration first',
  );
  await root.eval(
    `[...document.querySelectorAll('[role=radio]')].find(e=>/^(自动解析与更新|Automation)$/.test(e.textContent.trim())).click()`,
  );
  await root.eval(
    `[...document.querySelectorAll('.collection-editor')].find(e=>/^(导入时解析|Parse on import)$/.test(e.getAttribute('aria-label'))).querySelector('header button').click()`,
  );
  p = await popup();
  await pause(500);
  await click(p, 'button[aria-haspopup=listbox]');
  await wait(() => metrics(p), 'Picker did not open');
  await pause(250);
  const small = await metrics(p);
  assert(fits(small), 'Picker crosses native window bounds: ' + JSON.stringify(small));
  assert(small.listScroll > small.listHeight, 'Small picker must scroll within available height');
  checks.push('small-native-picker-contained-and-scrollable');
  const point = await p.eval(
    `(()=>{const r=document.querySelector('[role=listbox]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
  );
  await p.send('Input.dispatchMouseEvent', { type: 'mouseWheel', deltaX: 0, deltaY: 300, ...point });
  await wait(async () => {
    const m = await metrics(p);
    return m && m.scrollTop > 0;
  }, 'Scrolling closed the popup or did not scroll');
  checks.push('wheel-scroll-keeps-picker-open');
  await key(p, 'End', 'End', 35);
  await pause(200);
  const last = await p.eval(
    `(()=>{const e=[...document.querySelectorAll('[role=option]')].at(-1),r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:innerHeight,focused:e.contains(document.activeElement)||e.id===document.activeElement?.getAttribute('aria-activedescendant')};})()`,
  );
  assert(last.top >= 0 && last.bottom <= last.height + 1);
  checks.push('keyboard-reaches-visible-last-option');
  await key(p, 'Escape', 'Escape', 27);
  await wait(() => p.eval(`!document.querySelector('[role=listbox]')`), 'Picker did not close');
  // Move the same control toward the bottom of a taller real native window, then restore it.
  await p.eval(
    `document.querySelector('.dialog-window-body').style.minHeight='400px';document.querySelector('.select-field').style.cssText='position:relative;top:300px';`,
  );
  await wait(() => p.eval('innerHeight>450'), 'Window did not grow for fixture');
  await click(p, 'button[aria-haspopup=listbox]');
  await wait(async () => {
    const m = await metrics(p);
    return fits(m) && m.placement === 'top';
  }, 'Picker did not flip above bottom trigger');
  const flipped = await metrics(p);
  checks.push('bottom-trigger-flips-up');
  await p.eval(
    `document.querySelector('.dialog-window-body').style.minHeight='';document.querySelector('.select-field').removeAttribute('style');`,
  );
  await wait(async () => {
    const m = await metrics(p);
    return fits(m) && m.height < 250;
  }, 'Open picker did not reposition when native window shrank');
  checks.push('open-picker-tracks-native-resize');
  await key(p, 'End', 'End', 35);
  await key(p, 'Enter', 'Enter', 13);
  await wait(
    () => p.eval(`!document.querySelector('[role=listbox]')&&!!document.querySelector('.rule-list')`),
    'Last option could not be selected',
  );
  assert.deepEqual(await p.eval('overlayErrors'), []);
  await cancel();
  await root.eval(`document.querySelector('.condition-rules header button:last-child').click()`);
  p = await popup();
  await pause(300);
  await p.eval(`document.querySelector('[role=combobox]').focus()`);
  await key(p, 'ArrowDown', 'ArrowDown', 40);
  await wait(async () => fits(await metrics(p)), 'Searchable combo crosses native window');
  checks.push('searchable-combo-contained');
  await key(p, 'Escape', 'Escape', 27);
  assert.equal((await dialogs()).length, 1, 'Closing the combo must not cancel the dialog');
  checks.push('escape-closes-overlay-without-cancelling-draft');
  await p.eval(
    `[...document.querySelectorAll('button')].find(e=>/^(更多条件|More conditions)$/.test(e.textContent.trim())).click()`,
  );
  await wait(async () => fits(await metrics(p)), 'Menu crosses native window');
  checks.push('menu-trigger-contained');
  await key(p, 'Escape', 'Escape', 27);
  assert.deepEqual(await p.eval('overlayErrors'), []);
  await cancel();
  await root.eval(
    `[...document.querySelectorAll('[role=radio]')].find(e=>/^(基本信息|Basics)$/.test(e.textContent.trim())).click()`,
  );
  await click(root, '.definition-designer button[aria-haspopup=listbox]');
  await wait(async () => fits(await metrics(root)), 'Main-window picker regression');
  await key(root, 'Escape', 'Escape', 27);
  checks.push('main-window-picker-unaffected');
  await root.eval(
    `[...document.querySelectorAll('[role=radio]')].find(e=>/^(自动解析与更新|Automation)$/.test(e.textContent.trim())).click()`,
  );
  assert.deepEqual(await root.eval('overlayErrors'), []);
  const result = {
    passed: true,
    checks,
    small,
    flipped,
    limitations: [
      'CDP input; native screenshots checked separately.',
      'macOS and physical multi-monitor dragging not verified.',
    ],
  };
  await fs.mkdir(new URL('../.artifacts/dialog-overlays/', import.meta.url), { recursive: true });
  await fs.writeFile(
    new URL('../.artifacts/dialog-overlays/result.json', import.meta.url),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  for (const c of connections) c.close();
}
