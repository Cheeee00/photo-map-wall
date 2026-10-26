// 真实上传 9 张带 EXIF 的 JPEG，验证「读定位」是否生效
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, PAGE_FILE, PAGE_URL, SHOTS_DIR, TEST_IMGS, IMGS15, EXIFCASES, PROV_FILE, chromePath, userDataDir } from './_env.mjs';

const TARGET = PAGE_FILE;
const DIR = EXIFCASES;
const IMGS = fs.readdirSync(DIR).filter(f => f.endsWith('.jpg')).sort().map(f => DIR + '\\' + f);

const CHROME = chromePath();
const PORT = 9334;
const TMP = userDataDir('mwallel');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars',
  '--window-size=1600,1000', `--remote-debugging-port=${PORT}`,
  '--no-first-run', '--no-default-browser-check',
  '--user-data-dir=' + path.join(TMP, 'prof'), 'about:blank'
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws = null, id = 0;
const waiters = new Map();
const logs = [];

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find(t => t.type === 'page');
      if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); break; }
    } catch (e) { }
    await sleep(300);
  }
  if (!ws) throw new Error('Chrome CDP 起不来');
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + (m.params.exceptionDetails.text || m.params.exceptionDetails.exception?.description || ''));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') logs.push('CONSOLE ' + m.params.args.map(a => a.value || a.description).join(' '));
  };
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable'); await send('DOM.enable');
}
function send(method, params = {}) {
  const mid = ++id;
  return new Promise((res, rej) => {
    waiters.set(mid, m => res(m));
    ws.send(JSON.stringify({ id: mid, method, params }));
    setTimeout(() => { if (waiters.has(mid)) { waiters.delete(mid); rej(new Error(method + ' timeout')); } }, 60000);
  });
}
async function evaluate(expr) {
  const m = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (m.result && m.result.exceptionDetails) throw new Error('EVAL: ' + (m.result.exceptionDetails.exception?.description || m.result.exceptionDetails.text));
  return m.result?.result?.value;
}

async function main() {
  await connect();
  await send('Page.navigate', { url: 'file:///' + TARGET.replace(/\\/g, '/') });
  await sleep(2500);

  const m0 = await send('DOM.getDocument', { depth: -1 });
  const root = m0.result.root;
  const m1 = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#file' });
  await send('DOM.setFileInputFiles', { files: IMGS, nodeId: m1.result.nodeId });
  await sleep(4000);

  const got = await evaluate(`JSON.stringify((function(){
    var ps = window.__dbg.photos();
    return ps.map(function(p){ return {city:p.city, lon:+p.lon.toFixed(3), lat:+p.lat.toFixed(3), gps:!!p.gps}; });
  })())`);
  console.log('--- 解析结果 ---');
  console.log(got);

  const st = await evaluate('JSON.stringify(window.__selfTest())');
  const o = JSON.parse(st);
  console.log('photos=' + o.photos + ' crossings=' + o.crossings + ' issues=' + JSON.stringify(o.issues));
  console.log('--- 异常 ---');
  console.log(logs.length ? logs.join('\n') : '(无)');
}
main().catch(e => { console.error('FATAL', e.message); process.exitCode = 1; })
  .finally(() => { try { chrome.kill(); } catch {} setTimeout(() => process.exit(0), 300); });
