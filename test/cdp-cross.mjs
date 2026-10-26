// 独立交叉校验：不信任页面里的 segCross，直接从渲染出的红线 path 取样，
// 在 Node 里用另一套线段求交算法两两检查，报出交叉对与坐标。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, PAGE_FILE, PAGE_URL, SHOTS_DIR, TEST_IMGS, IMGS15, EXIFCASES, PROV_FILE, chromePath, userDataDir } from './_env.mjs';

const CHROME = chromePath();
const PORT = 9391;
const TMP = userDataDir('mwallx');
const IMGS = IMGS15;
const PAGE = PAGE_URL;
const N = Number(process.argv[2] || 15);

fs.mkdirSync(TMP, { recursive: true });
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${TMP}`, '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let id = 0;
function send(ws, method, params) {
  return new Promise((res, rej) => {
    const mid = ++id;
    const onMsg = ev => {
      const m = JSON.parse(ev.data);
      if (m.id !== mid) return;
      ws.removeEventListener('message', onMsg);
      if (m.error) rej(new Error(method + ': ' + JSON.stringify(m.error)));
      else res(m.result);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
}
function segX(a, b, c, d) {
  const r1 = (b[0] - a[0]), r2 = (b[1] - a[1]);
  const s1 = (d[0] - c[0]), s2 = (d[1] - c[1]);
  const den = r1 * s2 - r2 * s1;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c[0] - a[0]) * s2 - (c[1] - a[1]) * s1) / den;
  const u = ((c[0] - a[0]) * r2 - (c[1] - a[1]) * r1) / den;
  if (t > 0.001 && t < 0.999 && u > 0.001 && u < 0.999) return [a[0] + t * r1, a[1] + t * r2];
  return null;
}

async function main() {
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`); const l = await r.json(); target = l.find(t => t.type === 'page'); } catch (e) {}
    if (!target) await sleep(250);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  await send(ws, 'Runtime.enable'); await send(ws, 'Page.enable'); await send(ws, 'DOM.enable');
  await send(ws, 'Page.navigate', { url: PAGE });
  await sleep(2200);
  const ev = async (expr) => {
    const r = await send(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };

  if (N > 0) {
    const files = fs.readdirSync(IMGS).filter(f => /\.png$/i.test(f)).sort().slice(0, N).map(f => path.join(IMGS, f));
    const doc = await send(ws, 'DOM.getDocument', { depth: 1 });
    const q = await send(ws, 'DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' });
    await send(ws, 'DOM.setFileInputFiles', { files, nodeId: q.nodeId });
    await sleep(2600);
  }

  // 从渲染结果取样：每条红线的完整 polyline + 它属于哪个城市
  const raw = await ev(`(() => {
    const out = [];
    document.querySelectorAll('#gYarn path').forEach(function (p) {
      // 主描边是较粗那条；每条线两个 path（主 + 高光），只取粗的
      if (+p.getAttribute('stroke-width') < 2) return;
      const L = p.getTotalLength();
      const pts = [];
      for (let i = 0; i <= 24; i++) { const q = p.getPointAtLength(L * i / 24); pts.push([+q.x.toFixed(2), +q.y.toFixed(2)]); }
      out.push({ cls: p.parentNode.getAttribute('data-city') || '', d: p.getAttribute('d').slice(0, 24), pts: pts });
    });
    return out;
  })()`);

  console.log('红线数: ' + raw.length);
  let bad = [];
  for (let i = 0; i < raw.length; i++) for (let j = i + 1; j < raw.length; j++) {
    const A = raw[i].pts, B = raw[j].pts;
    let hit = null;
    for (let a = 0; a + 1 < A.length && !hit; a++) for (let b = 0; b + 1 < B.length && !hit; b++) {
      const x = segX(A[a], A[a + 1], B[b], B[b + 1]);
      if (x) hit = x;
    }
    if (hit) bad.push({ i, j, at: hit.map(v => Math.round(v)) });
  }
  console.log('独立校验交叉数: ' + bad.length);
  bad.forEach(b => console.log('  ' + JSON.stringify(b)));
  console.log('自检报告: ' + JSON.stringify(await ev('(() => { const t = __selfTest(); return { n: t.photos, issues: t.issues.length, crossings: t.crossings }; })()')));
  ws.close(); chrome.kill();
}
main().catch(e => { console.error('FATAL', e); chrome.kill(); process.exit(1); });
