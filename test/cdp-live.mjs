// 线上部署冒烟：直接访问公网 URL，验证「加载、零异常、自检、工具栏不溢出、地图与照片都在」
// 用法：node test/cdp-live.mjs [url]
// 默认打 https://wall.orange0323.dpdns.org/
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { SHOTS_DIR, chromePath, userDataDir } from './_env.mjs';

const URL_ = process.argv[2] || 'https://wall.orange0323.dpdns.org/';
const CHROME = chromePath();
const PORT = 9411;
const TMP = userDataDir('mwalllive');
fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(SHOTS_DIR, { recursive: true });

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${TMP}`,
  '--window-size=1600,1000', '--hide-scrollbars', '--no-first-run', 'about:blank',
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, id = 0;
const waiters = new Map();
const logs = [];
const results = [];
let fatal = null;

function ok(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
  const s = (cond ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : '  ' + detail);
  try { fs.writeSync(1, s + '\n'); } catch { }
}
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

async function shoot(name) {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  const p = path.join(SHOTS_DIR, name);
  fs.writeFileSync(p, Buffer.from(s.result.data, 'base64'));
  return p;
}

async function probe(tag, W, H, mobile) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: mobile ? 3 : 1, mobile: !!mobile,
    screenWidth: W, screenHeight: H,
  });
  await sleep(700);
  const r = JSON.parse(await evaluate(`(function(){
    const b = document.getElementById('board').getBoundingClientRect();
    const st = window.__selfTest();
    const ui = document.getElementById('ui').getBoundingClientRect();
    const btns = Array.prototype.map.call(document.querySelectorAll('#ui .btn, #ui select'), function(e){
      const r = e.getBoundingClientRect(); return {id: e.id, l: r.left, rr: r.right, vis: e.offsetParent !== null};
    });
    return JSON.stringify({
      bw: b.width, bh: b.height,
      viewBox: document.getElementById('board').getAttribute('viewBox'),
      issues: st.issues, crossings: st.crossings, photos: st.photos,
      uiLeft: ui.left, uiRight: ui.right, vw: window.innerWidth,
      btns: btns
    });
  })()`));
  ok(tag + ' 自检无问题', r.issues.length === 0, JSON.stringify(r.issues));
  ok(tag + ' 红线零交叉', r.crossings === 0, 'crossings=' + r.crossings);
  ok(tag + ' 有示例照片', r.photos === 5, 'photos=' + r.photos);
  const [vbW, vbH] = r.viewBox.split(' ').slice(2).map(Number);
  const wantRatio = r.bw / r.bh, gotRatio = vbW / vbH;
  ok(tag + ' 画布比例贴合可视区', Math.abs(wantRatio - gotRatio) / wantRatio < 0.02,
    `want=${wantRatio.toFixed(3)} got=${gotRatio.toFixed(3)} vb=${r.viewBox}`);
  const over = r.btns.filter(b => b.vis && (b.l < -0.5 || b.rr > r.vw + 0.5));
  ok(tag + ' 工具栏未溢出', over.length === 0, JSON.stringify(over));
  return r;
}

async function main() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`); if (r.ok) break; } catch { }
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
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  const nav = await send('Page.navigate', { url: URL_ });
  await sleep(4000);
  ok('页面加载成功', !nav.result.errorText, nav.result.errorText || '');

  const has = await evaluate('typeof window.__selfTest === "function"');
  ok('页面脚本已执行', has === true, 'typeof __selfTest = ' + has);

  await probe('桌面1600x1000', 1600, 1000, false);
  await shoot('L1-live-desktop.png');
  await probe('手机393x852', 393, 852, true);
  await shoot('L2-live-mobile.png');
  await probe('窄屏820x1180', 820, 1180, false);
}

main().catch(e => { fatal = e; console.error('FATAL', e.message); })
  .finally(async () => {
    const pass = results.every(r => r.pass) && !fatal && logs.length === 0;
    try { fs.writeSync(1, '\n--- 页面异常 ---\n' + (logs.length ? logs.join('\n') : '(无)') + '\n'); } catch { }
    try { fs.writeSync(1, `\n结果：${results.filter(r => r.pass).length}/${results.length} 通过${pass ? '  ALL PASS' : ''}\n`); } catch { }
    try { chrome.kill(); } catch { }
    setTimeout(() => process.exit(pass ? 0 : 1), 400);
  });
