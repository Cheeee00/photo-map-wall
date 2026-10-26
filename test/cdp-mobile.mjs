// 手机竖屏（iPhone Safari 尺寸）验收：
//   1 画布铺满可视区、不留黑边      2 工具条每个按钮都在屏幕内      3 缩放按钮可见
//   4 单张照片不会把地图放大成区域级  5 5 张 / 15 张仍然 issues=[] crossings=0
//   6 照片屏幕包围盒全部落在可视区内（不被裁）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PAGE_URL, SHOTS_DIR, DEMO5, IMGS15, chromePath, userDataDir } from './_env.mjs';

const CHROME = chromePath();
const PORT = 9401;
const TMP = userDataDir('mwallmobile');
const SHOTS = SHOTS_DIR;
fs.mkdirSync(SHOTS, { recursive: true });

// iPhone 14 Pro 逻辑尺寸；真实 DPR 靠 Emulation.setDeviceMetricsOverride 覆盖
const VW = Number(process.argv[2] || 393);
const VH = Number(process.argv[3] || 852);

// R13 之后照片存在 IndexedDB 里 —— 不清 profile 的话，上一轮传的 1 张会被复原，
// 这一轮「只有 1 张照片」的断言就会凭空多出照片。
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

// 上一次跑如果被中断，Chrome 还占着端口，新起的那只绑不上、我们会连到旧的那只然后 evaluate 卡死。
try {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(800) });
  if (r.ok) {
    const v = await r.json();
    const bws = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise((ok) => { bws.onopen = ok; bws.onerror = ok; });
    try { bws.send(JSON.stringify({ id: 1, method: 'Browser.close' })); } catch (e) { }
    await sleep(600);
  }
} catch (e) { /* 端口没人听，正常 */ }

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${TMP}`,
  `--window-size=${VW},${VH}`, '--hide-scrollbars', '--no-first-run',
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
async function shot(name) {
  const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const buf = Buffer.from(s.result.data, 'base64');
  fs.writeFileSync(path.join(SHOTS, name), buf);
  return buf.length;
}
async function pickFiles(list) {
  const doc = await send('DOM.getDocument', { depth: -1 });
  const q = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#file' });
  await send('DOM.setFileInputFiles', { nodeId: q.result.nodeId, files: list });
}

const fail = [];
function check(ok, msg) { console.log((ok ? 'PASS  ' : 'FAIL  ') + msg); if (!ok) fail.push(msg); }

// 工具条 / 缩放按钮 / 照片的屏幕几何
const GEO = `(() => {
  const vw = innerWidth, vh = innerHeight;
  const r = n => { const b = n.getBoundingClientRect(); return { l:+b.left.toFixed(1), t:+b.top.toFixed(1), r:+b.right.toFixed(1), b:+b.bottom.toFixed(1) }; };
  const ui = document.getElementById('ui');
  const items = Array.from(ui.querySelectorAll('.btn, .gsel')).map(n => ({ id: n.id || n.className, ...r(n) }));
  const z = getComputedStyle(document.getElementById('zoomer')).display;
  const board = document.getElementById('board').getBoundingClientRect();
  const ph = Array.from(document.querySelectorAll('#gPhotos .polaroid')).map(n => r(n));
  const c = window.__dbg.canvas();
  return { vw: vw, vh: vh, ui: r(ui), items: items, zoomer: z,
           board: { l:+board.left.toFixed(1), t:+board.top.toFixed(1), r:+board.right.toFixed(1), b:+board.bottom.toFixed(1) },
           photos: ph, canvas: c, vwv: window.__dbg.vw(), baseS: window.__dbg.baseS(),
           vb: document.getElementById('board').getAttribute('viewBox') };
})()`;

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
    if (m.id && waiters.has(m.id)) { const cb = waiters.get(m.id); waiters.delete(m.id); cb(m); return; }
    if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + JSON.stringify(m.params.exceptionDetails?.text));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      logs.push('ERR ' + (m.params.args || []).map(a => a.value || a.description || '').join(' '));
    }
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('DOM.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: VW, height: VH, deviceScaleFactor: 3, mobile: true,
    screenWidth: VW, screenHeight: VH
  });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.navigate', { url: PAGE_URL });
  await sleep(2800);

  // ---------- 示例状态 ----------
  console.log('=== 示例状态 ===');
  let g = await evaluate(GEO);
  console.log('viewBox =', g.vb, '| canvas =', JSON.stringify(g.canvas));
  check(Math.abs(g.board.l) < 1.5 && Math.abs(g.board.t) < 1.5, 'board 左上贴边 ' + JSON.stringify(g.board));
  check(Math.abs(g.board.r - g.vw) < 1.5, 'board 右边界贴屏幕 ' + g.board.r + ' vs ' + g.vw);
  check(g.board.b <= g.vh + 0.5, 'board 底部不超出屏幕 ' + g.board.b + ' vs ' + g.vh);
  const vbParts = g.vb.split(' ').map(Number);
  const vbRatio = vbParts[2] / vbParts[3];
  const boxRatio = (g.board.r - g.board.l) / (g.board.b - g.board.t);
  check(Math.abs(vbRatio - boxRatio) < 0.02, 'viewBox 比例 = 可视区比例（无 letterbox）' + vbRatio.toFixed(3) + ' / ' + boxRatio.toFixed(3));
  check(g.zoomer !== 'none', '触屏缩放按钮可见 display=' + g.zoomer);
  const bad = g.items.filter(i => i.l < -0.5 || i.r > g.vw + 0.5);
  check(bad.length === 0, '工具条全部按钮在屏幕内' + (bad.length ? ' 溢出: ' + JSON.stringify(bad) : ''));
  check(g.ui.b <= g.vh + 0.5, '工具条底部不压出屏幕 ' + g.ui.b);
  check(g.canvas.card.w / g.canvas.bw > 0.6, '地图占画布宽度 ' + (g.canvas.card.w / g.canvas.bw * 100).toFixed(0) + '%');
  const clipped = g.photos.filter(p => p.l < -0.5 || p.t < -0.5 || p.r > g.vw + 0.5 || p.b > g.vh + 0.5);
  check(clipped.length === 0, '示例照片都没被裁' + (clipped.length ? ' 出界: ' + JSON.stringify(clipped) : ''));
  console.log('selfTest:', await evaluate('JSON.stringify(window.__selfTest())'));
  console.log('screenshot', await shot('M0-demo.png'), 'B');

  // ---------- 上传 1 张（应保持中国全览） ----------
  console.log('\n=== 上传 1 张 ===');
  const demoFiles = fs.readdirSync(DEMO5).filter(f => /\.jpe?g$/i.test(f)).sort();
  await pickFiles([path.join(DEMO5, demoFiles[0])]);
  await sleep(2200);
  g = await evaluate(GEO);
  const r1 = g.vwv.s / g.baseS;
  console.log('照片数 =', g.photos.length, '| viewScale/baseScale =', r1.toFixed(2));
  check(g.photos.length === 1, '只有 1 张照片');
  check(r1 <= 1.6 && r1 >= 0.99, '单张照片保持中国全览（0.99~1.6 倍，实测 ' + r1.toFixed(2) + '）');
  check(g.photos.every(p => p.l > -0.5 && p.t > -0.5 && p.r < g.vw + 0.5 && p.b < g.vh + 0.5), '单张照片在屏幕内');
  console.log('selfTest:', await evaluate('JSON.stringify(window.__selfTest())'));
  console.log('screenshot', await shot('M1-one.png'), 'B');

  // ---------- 5 张 ----------
  console.log('\n=== 上传 5 张 ===');
  await pickFiles(demoFiles.slice(0, 5).map(f => path.join(DEMO5, f)));
  await sleep(2600);
  g = await evaluate(GEO);
  const st = JSON.parse(await evaluate('JSON.stringify(window.__selfTest())'));
  console.log('selfTest:', JSON.stringify({ n: st.photos, issues: st.issues, crossings: st.crossings }));
  check(st.issues.length === 0, '5 张：issues 为空');
  check(st.crossings === 0, '5 张：红线零交叉');
  const clipped2 = g.photos.filter(p => p.l < -0.5 || p.t < -0.5 || p.r > g.vw + 0.5 || p.b > g.vh + 0.5);
  check(clipped2.length === 0, '5 张：照片都在屏幕内');
  console.log('screenshot', await shot('M2-five.png'), 'B');

  // ---------- 15 张（手机竖屏压力） ----------
  if (fs.existsSync(IMGS15)) {
    const many = fs.readdirSync(IMGS15).filter(f => /\.png$/i.test(f)).sort();
    if (many.length >= 15) {
      console.log('\n=== 上传 15 张 ===');
      await pickFiles(many.slice(0, 15).map(f => path.join(IMGS15, f)));
      await sleep(3200);
      g = await evaluate(GEO);
      const st15 = JSON.parse(await evaluate('JSON.stringify(window.__selfTest())'));
      console.log('selfTest:', JSON.stringify({ n: st15.photos, issues: st15.issues.length, crossings: st15.crossings }));
      check(st15.issues.length === 0, '15 张：issues 为空');
      check(st15.crossings === 0, '15 张：红线零交叉');
      const clipped3 = g.photos.filter(p => p.l < -0.5 || p.t < -0.5 || p.r > g.vw + 0.5 || p.b > g.vh + 0.5);
      check(clipped3.length === 0, '15 张：照片都在屏幕内');
      console.log('screenshot', await shot('M3-fifteen.png'), 'B');
    }
  }

  // ---------- 缩放按钮 ----------
  console.log('\n=== 缩放按钮 ===');
  const s0 = await evaluate('window.__dbg.vw().s');
  for (let i = 0; i < 3; i++) { await evaluate("document.getElementById('btnZoomIn').click()"); await sleep(80); }
  const s1 = await evaluate('window.__dbg.vw().s');
  for (let i = 0; i < 6; i++) { await evaluate("document.getElementById('btnZoomOut').click()"); await sleep(80); }
  const s2 = await evaluate('window.__dbg.vw().s');
  const floor = await evaluate('window.__dbg.baseS()*0.8');
  check(s1 > s0 * 1.5, '放大按钮生效 ' + s0.toFixed(2) + ' -> ' + s1.toFixed(2));
  check(Math.abs(s2 - floor) < 0.01, '缩小撞到下限 ' + s2.toFixed(2) + ' = ' + floor.toFixed(2));

  console.log('\n--- 异常 ---');
  console.log(logs.length ? logs.join('\n') : '(无)');
  check(logs.length === 0, '零 JS 异常');
  console.log('\n结果：' + (fail.length ? 'FAIL ' + fail.length + ' 项' : '全部通过'));
}

main().catch(e => { console.error('FATAL', e.message); process.exitCode = 1; })
  .finally(() => { try { chrome.kill(); } catch { } setTimeout(() => process.exit(0), 300); });
