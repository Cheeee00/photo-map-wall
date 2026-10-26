// 15 张真实上传后，切换多种窗口尺寸，逐步验证「随页面自动变换」：
// 每档读 viewBox / selfTest.issues / crossings / 照片屏幕包围盒是否都在视口内
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, PAGE_FILE, PAGE_URL, SHOTS_DIR, TEST_IMGS, IMGS15, EXIFCASES, PROV_FILE, chromePath, userDataDir } from './_env.mjs';

const CHROME = chromePath();
const PORT = 9388;
const TMP = userDataDir('mwallre');
const OUT = SHOTS_DIR;
const IMGS = IMGS15;
const PAGE = PAGE_URL;

fs.mkdirSync(TMP, { recursive: true });
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${TMP}`,
  '--window-size=1600,1000', 'about:blank'
], { stdio: 'ignore' });

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

async function main() {
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`); const l = await r.json(); target = l.find(t => t.type === 'page'); } catch (e) {}
    if (!target) await sleep(250);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const errors = [];
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text + ' ' + ((m.params.exceptionDetails.exception || {}).description || ''));
  });
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');
  await send(ws, 'DOM.enable');
  await send(ws, 'Page.navigate', { url: PAGE });
  await sleep(2200);

  const ev = async (expr) => {
    const r = await send(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };

  // 上传 15 张
  const files = fs.readdirSync(IMGS).filter(f => /\.png$/i.test(f)).sort().slice(0, 15).map(f => path.join(IMGS, f));
  const doc = await send(ws, 'DOM.getDocument', { depth: 1 });
  const q = await send(ws, 'DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' });
  await send(ws, 'DOM.setFileInputFiles', { files, nodeId: q.nodeId });
  await sleep(2400);
  console.log('上传后: ' + JSON.stringify(await ev('(() => { const t = __selfTest(); return { n: t.photos, issues: t.issues.length, crossings: t.crossings, bw: document.getElementById("board").getAttribute("viewBox") }; })()')));

  // 逐档改尺寸
  const sizes = [[2200, 1100], [1600, 1000], [1366, 768], [1024, 640], [800, 1200], [1280, 900]];
  for (const [w, h] of sizes) {
    await send(ws, 'Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(900);
    const r = await ev(`(() => {
      const t = __selfTest();
      const box = document.getElementById('board').getBoundingClientRect();
      // 每张照片的 DOM 包围盒是否落在窗口内
      let clipped = 0;
      document.querySelectorAll('#gPhotos > g').forEach(function (g) {
        const b = g.getBoundingClientRect();
        if (b.left < -1 || b.top < -1 || b.right > innerWidth + 1 || b.bottom > innerHeight + 1) clipped++;
      });
      return { vb: document.getElementById('board').getAttribute('viewBox'), bw: Math.round(box.width), bh: Math.round(box.height), issues: t.issues, crossings: t.crossings, clipped: clipped };
    })()`);
    console.log(`${w}x${h} -> ` + JSON.stringify(r));
  }
  const shot = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'S5-reflow15.png'), Buffer.from(shot.data, 'base64'));
  console.log('截图 -> S5-reflow15.png');
  console.log('--- 异常 ---');
  console.log(errors.length ? errors.join('\n') : '(无)');
  ws.close(); chrome.kill();
}
main().catch(e => { console.error('FATAL', e); chrome.kill(); process.exit(1); });
