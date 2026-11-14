// Node >= 22, a running Windows fixture host with a remote-debugging endpoint.
// Observe every child-window frame; final-height checks alone miss scrollbar flashes.
// No Runtime.enable or focus emulation, no configuration saves or catalog resets.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const [endpoint, run = 'after'] = process.argv.slice(2);
assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint));
assert(/^[a-z-]+$/.test(run));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const targets = async () => await (await fetch(endpoint + '/json/list')).json();
const dialogs = async () => (await targets()).filter(t => t.url.includes('/dialog.html?'));
const connections = [],
  checks = [],
  traces = {};
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
  return c;
}
async function wait(test, message) {
  for (let i = 0; i < 50; i++) {
    const result = await test();
    if (result) return result;
    await pause(100);
  }
  throw Error(message);
}
const click = (p, selector, pattern) =>
  p.eval(`(() => {
  const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>new RegExp(${JSON.stringify(pattern)}).test(e.textContent.trim()||e.getAttribute('aria-label')||''));
  if(!e)throw Error('Control missing: '+${JSON.stringify(pattern)});e.click();
})()`);
let root, child, active;
const sample = `() => {
  const c=document.querySelector('.dialog-window-content'),b=document.querySelector('.dialog-window-body'),f=document.querySelector('.dialog-window-actions'),s=getComputedStyle(c);
  return {height:innerHeight,natural:Math.ceil(Math.max(b.scrollHeight,b.getBoundingClientRect().height)+parseFloat(s.paddingTop)+parseFloat(s.paddingBottom)+f.getBoundingClientRect().height),
    overflow:c.scrollHeight>c.clientHeight+1,bar:/auto|scroll/.test(s.overflowY)&&c.scrollHeight>c.clientHeight+1,
    width:c.clientWidth,footer:f.getBoundingClientRect().bottom,top:c.scrollTop,available:screen.availHeight};
}`;
const metrics = () => child.eval(`(${sample})()`);
async function trace(name, action) {
  // Sample the starting state and every rendered frame after the content change.
  // ResizeObserver/rAF scheduling must not expose an intermediate scrolling viewport.
  traces[name] = await child.eval(`new Promise(resolve=>{
    const sample=${sample},frames=[sample()],start=performance.now();
    const tick=()=>{frames.push(sample());if(performance.now()-start<650)requestAnimationFrame(tick);else resolve(frames);};
    ${action};requestAnimationFrame(tick);
  })`);
  assert(traces[name].length >= 3, 'Child window did not render enough frames');
}
const check = (name, passed) => checks.push({ name, passed });
try {
  assert.equal((await dialogs()).length, 0, 'Close fixture dialogs before running');
  root = await connect((await targets()).find(t => t.url.endsWith('/index.html')));
  const boot = await root.eval(`new Promise((resolve,reject)=>{
    const id=crypto.randomUUID(),w=chrome.webview,timer=setTimeout(()=>{w.removeEventListener('message',receive);reject(Error('RPC timeout'));},10000);
    function receive(e){try{const m=JSON.parse(decodeURIComponent(e.data));if(m.id!==id)return;w.removeEventListener('message',receive);clearTimeout(timer);const r=JSON.parse(m.response);r.ok?resolve(r.data):reject(Error(r.error));}catch{}}
    w.addEventListener('message',receive);w.postMessage(encodeURIComponent('__RawMessage|'+JSON.stringify({id,request:{method:'bootstrap',args:{}}})));
  })`);
  assert(
    boot.libraries.length
      ? boot.libraries.every(l => l.name === 'Playback stability fixture')
      : boot.tagging.generation === 1,
    'Use an empty development catalog or playback fixture',
  );
  active = await root.eval(`document.querySelector('[role=tab][aria-selected=true]')?.id`);
  if (!(await root.eval(`!!document.querySelector('.definition-designer')`))) {
    await click(root, 'button', '^(整理|Organize)$');
    await click(root, 'button', '^(标签|Tags)$');
  }
  await wait(() => root.eval(`!!document.querySelector('.definition-designer')`), 'Definition editor did not load');
  await click(root, '[role=radio]', '^(自动解析与更新|Automation)$');
  await click(root, '.condition-rules button', '^(添加规则|Add rule)$');
  child = await connect(await wait(async () => (await dialogs())[0], 'Condition window did not open'));
  await wait(() => child.eval(`!!document.querySelector('.dialog-window-body')`), 'Dialog did not mount');
  await wait(async () => {
    const m = await metrics();
    return !m.overflow && Math.abs(m.height - m.natural) <= 2;
  }, 'Initial height did not fit');
  await child.eval(
    `window.scrollbarErrors=[];addEventListener('error',e=>scrollbarErrors.push(e.message));addEventListener('unhandledrejection',e=>scrollbarErrors.push(String(e.reason)));`,
  );
  const initial = await metrics();
  await pause(1500); // Leave the opener idle; do not evaluate it during the frame tests.
  await trace(
    'add-condition',
    `[...document.querySelectorAll('button')].find(e=>/^(添加条件|Add condition)$/.test(e.textContent.trim())).click()`,
  );
  let last = traces['add-condition'].at(-1);
  check(
    'condition-grows-without-any-scrollbar-frame',
    last.height > initial.height + 50 && !last.overflow && traces['add-condition'].every(f => !f.bar),
  );
  await trace(
    'shrink',
    `[...document.querySelectorAll('button')].filter(e=>/^(移除条件|Remove condition)$/.test(e.getAttribute('aria-label')||''))[1].click()`,
  );
  check(
    'condition-shrinks-without-any-scrollbar-frame',
    Math.abs(traces.shrink.at(-1).height - initial.height) <= 2 && traces.shrink.every(f => !f.bar),
  );
  await child.eval(
    `window.scrollbarFixture=document.createElement('div');scrollbarFixture.setAttribute('data-scrollbar-fixture','');document.querySelector('.dialog-window-body').append(scrollbarFixture);`,
  );
  // Several independent growth/shrink cycles catch races in the IPC/OS resize queue.
  for (let i = 0; i < 3; i++) {
    await trace('grow-' + i, `scrollbarFixture.style.height='${70 + i * 40}px'`);
    await trace('reduce-' + i, `scrollbarFixture.style.height='0px'`);
  }
  const cycles = Object.entries(traces)
    .filter(([n]) => /^(grow|reduce)-/.test(n))
    .flatMap(([, f]) => f);
  check('repeated-auto-fit-has-no-transient-scrollbars', cycles.every(f => !f.bar) && !cycles.at(-1).overflow);
  check(
    'scrollbar-gutter-keeps-content-width-stable',
    Object.values(traces)
      .flat()
      .every(f => f.width === initial.width),
  );
  await trace('screen-cap', `scrollbarFixture.style.height='5000px'`);
  last = traces['screen-cap'].at(-1);
  check(
    'screen-limit-enables-scrollbar-and-keeps-footer-visible',
    last.bar && last.height >= last.available - 100 && last.footer <= last.height + 1,
  );
  await trace('still-capped', `scrollbarFixture.style.height='5200px'`);
  check(
    'needed-scrollbar-does-not-disappear-on-content-change',
    traces['still-capped'].every(f => f.bar),
  );
  const point = await child.eval(
    `(()=>{const r=document.querySelector('.dialog-window-content').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
  );
  await child.send('Input.dispatchMouseEvent', { type: 'mouseWheel', deltaX: 0, deltaY: 250, ...point });
  await wait(async () => (await metrics()).top > 0, 'Capped content does not scroll');
  check('capped-content-accepts-wheel-scrolling', true);
  await trace('uncap', `scrollbarFixture.remove()`);
  last = traces.uncap.at(-1);
  check(
    'removing-overflow-restores-fit-without-stranded-scroll',
    !last.bar && !last.overflow && last.top === 0 && Math.abs(last.height - initial.height) <= 2,
  );
  assert.deepEqual(await child.eval('scrollbarErrors'), []);
  const result = { passed: checks.every(c => c.passed), checks, initial, traces, focusEmulation: false };
  const dir = new URL('../.artifacts/dialog-scrollbars/', import.meta.url);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(new URL(run + '.json', dir), JSON.stringify(result, null, 2));
  console.log(
    JSON.stringify({
      ...result,
      traces: Object.fromEntries(
        Object.entries(traces).map(([n, f]) => [
          n,
          { frames: f.length, scrollbarFrames: f.filter(m => m.bar).length, last: f.at(-1) },
        ]),
      ),
    }),
  );
  assert(result.passed, 'Scrollbar frame regression failed; inspect .artifacts/dialog-scrollbars/' + run + '.json');
} finally {
  if (child) await click(child, '.dialog-window-actions button', '^(取消|Cancel)$').catch(() => {});
  if (root && active) await root.eval(`document.getElementById(${JSON.stringify(active)})?.click()`).catch(() => {});
  for (const c of connections) c.close();
}
