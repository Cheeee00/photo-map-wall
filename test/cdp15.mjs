// 用 15 张竖图跑全流程：上传 → 自检 → 截图 → 导出
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, PAGE_FILE, PAGE_URL, SHOTS_DIR, TEST_IMGS, IMGS15, EXIFCASES, PROV_FILE, chromePath, userDataDir } from './_env.mjs';

const TARGET = PAGE_FILE;
const IMGS = fs.readdirSync(IMGS15)
  .filter(f => f.endsWith('.png')).sort().map(f => IMGS15 + '/' + f);
const SHOTS = SHOTS_DIR;
fs.mkdirSync(SHOTS, { recursive: true });

const CHROME = chromePath();
const PORT = 9333;
const TMP = userDataDir('mwall15');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars',
  '--window-size=1600,1000', `--remote-debugging-port=${PORT}`,
  '--no-first-run', '--no-default-browser-check',
  '--user-data-dir=' + path.join(TMP, 'prof'),
  'about:blank'
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
    } catch (e) { /* 还没起来 */ }
    await sleep(300);
  }
  if (!ws) throw new Error('Chrome CDP 起不来');
  await new Promise((res, rej) => {
    ws.onopen = res; ws.onerror = rej;
  });
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + JSON.stringify(m.params.exceptionDetails.text || m.params.exceptionDetails.exception?.description || ''));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') logs.push('CONSOLE ' + JSON.stringify(m.params.args.map(a => a.value || a.description).join(' ')));
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
  if (m.result && m.result.exceptionDetails) {
    throw new Error('EVAL: ' + JSON.stringify(m.result.exceptionDetails.exception?.description || m.result.exceptionDetails.text));
  }
  return m.result?.result?.value;
}

async function main() {
  await connect();
  await send('Page.navigate', { url: 'file:///' + TARGET.replace(/\\/g, '/') });
  await sleep(2500);

  const demo = await evaluate('JSON.stringify(window.__selfTest())');
  console.log('--- DEMO (3 张示例) ---');
  console.log(demo);

  // 真实转账 GND酒店 restrictions
  const m0 = await send('DOM.getDocument', { depth: -1 });
  const root = m0.result.root;
  const m1 = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#file' });
  const nodeId = m1.result.nodeId;
  await send('DOM.setFileInputFiles', { files: IMGS, nodeId });
  await sleep(4000);

  const after = await evaluate('JSON.stringify(window.__selfTest())');
  console.log('--- 15 张上传后 ---');
  console.log(after);

  const lola = await evaluate(`JSON.stringify({
    scale: window.__dbg && window.__dbg.photos ? window.__dbg.photos.length : -1
  })`);
  console.log('photos=', lola);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(shot.result.data, 'base64');
  fs.writeFileSync(path.join(SHOTS, 'R1-15photos.png'), buf);
  console.log('截图 ->', path.join(SHOTS, 'R1-15photos.png'), buf.length, 'B');

  // 导出
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: TMP, eventsEnabled: true });
  await sleep(300);
  const m3 = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#btnExport' });
  const m4 = await send('DOM.getBoxModel', { nodeId: m3.result.nodeId });
  const [x1, y1, x2, y2] = m4.result.model.content;
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: (x1 + x2) / 2, y: (y1 + y2) / 2, button: 'left', clickCount: 1 });
  }
  await sleep(3000);
  const dl = fs.readdirSync(TMP).filter(f => f.endsWith('.png'));
  console.log('下载目录:', TMP, 'files=', JSON.stringify(dl));

  console.log('--- 异常/错误日志 ---');
  console.log(logs.length ? logs.join('\n') : '(无)');
}

main().catch(e => { console.error('FATAL', e.message); process.exitCode = 1; })
  .finally(() => { try { chrome.kill(); } catch {} setTimeout(() => process.exit(0), 300); });
