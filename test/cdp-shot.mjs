// 截取「初始示例状态」的图（不带上传）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, PAGE_FILE, PAGE_URL, SHOTS_DIR, TEST_IMGS, IMGS15, EXIFCASES, PROV_FILE, chromePath, userDataDir } from './_env.mjs';

const CHROME = chromePath();
const PORT = 9361;
const TMP = userDataDir('mwallshot');
fs.mkdirSync(TMP, { recursive: true });
const SHOTS = SHOTS_DIR;
fs.mkdirSync(SHOTS, { recursive: true });

const W = Number(process.argv[2] || 1600);
const H = Number(process.argv[3] || 1000);
const OUT = process.argv[4] || 'R0-demo.png';

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${TMP}`,
  `--window-size=${W},${H}`, '--hide-scrollbars', '--no-first-run',
  '--allow-file-access-from-files', 'about:blank'
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, id = 0;
const waiters = new Map();
const logs = [];

function send(method, params = {}) {
  const mid = ++id;
  return new Promise((res, rej) => {
    waiters.set(mid, res);
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
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`); if (r.ok) break; } catch (e) { }
    await sleep(200);
  }
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find(t => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => { ws.onopen = r; });
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && waiters.has(m.id)) { const w = waiters.get(m.id); waiters.delete(m.id); w(m); return; }
    if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + JSON.stringify(m.params.exceptionDetails?.text));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      logs.push('ERR ' + (m.params.args || []).map(a => a.value || a.description || '').join(' '));
    }
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: PAGE_URL });
  await sleep(2600);

  console.log('selfTest:', await evaluate('JSON.stringify(window.__selfTest())'));

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(shot.result.data, 'base64');
  const p = path.join(SHOTS, OUT);
  fs.writeFileSync(p, buf);
  console.log('截图 ->', p, buf.length, 'B');
  console.log('--- 异常 ---');
  console.log(logs.length ? logs.join('\n') : '(无)');
}

main().catch(e => { console.error('FATAL', e.message); process.exitCode = 1; })
  .finally(() => { try { chrome.kill(); } catch { } setTimeout(() => process.exit(0), 300); });
