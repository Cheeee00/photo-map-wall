// 验证：点照片弹大图预览 + 换地点 + 关闭；顺带截一张预览态
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, PAGE_FILE, PAGE_URL, SHOTS_DIR, TEST_IMGS, IMGS15, EXIFCASES, PROV_FILE, chromePath, userDataDir } from './_env.mjs';

const CHROME = chromePath();
const PORT = 9377;
const TMP = userDataDir('mwallv');
const OUT = SHOTS_DIR;
const PAGE = PAGE_URL;
const W = Number(process.argv[2] || 1600), H = Number(process.argv[3] || 1000);

fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${TMP}`,
  `--window-size=${W},${H}`, 'about:blank'
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
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      target = list.find(t => t.type === 'page');
    } catch (e) { /* not up yet */ }
    if (!target) await sleep(250);
  }
  if (!target) throw new Error('Chrome 没起来');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  const errors = [];
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || ''));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map(a => a.value).join(' '));
  });
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');
  await send(ws, 'Page.navigate', { url: PAGE });
  await sleep(2200);

  const ev = async (expr) => {
    const r = await send(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };

  console.log('初始: ' + JSON.stringify(await ev('({bw: document.getElementById("board").getAttribute("viewBox"), n: __dbg.photos().length})')));

  // 点第一张照片
  await ev(`(() => {
    const g = document.querySelector('#gPhotos > g');
    const r = g.getBoundingClientRect();
    const ev2 = new MouseEvent('click', { clientX: r.x + r.width/2, clientY: r.y + r.height/2, bubbles: true });
    g.dispatchEvent(ev2);
    return true;
  })()`);
  await sleep(400);
  const st1 = await ev(`(() => {
    const v = document.getElementById('viewer');
    const img = document.getElementById('viewerImg');
    return { on: v.classList.contains('on'), src: (img.src||'').slice(0,30), nat: img.naturalWidth, city: document.getElementById('popCity').value };
  })()`);
  console.log('点照片后: ' + JSON.stringify(st1));

  // 截图预览态
  const shot = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'S2-viewer.png'), Buffer.from(shot.data, 'base64'));
  console.log('截图 -> S2-viewer.png');

  // Esc 关闭
  await send(ws, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send(ws, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(300);
  console.log('Esc 后 viewer.on = ' + await ev(`document.getElementById('viewer').classList.contains('on')`));

  // 改窗口尺寸 → 自动重排
  await send(ws, 'Emulation.setDeviceMetricsOverride', { width: 2200, height: 1100, deviceScaleFactor: 1, mobile: false });
  await sleep(700);
  const st2 = await ev(`(() => { const t = __selfTest(); return { bw: document.getElementById('board').getAttribute('viewBox'), issues: t.issues, crossings: t.crossings, viewScale: +t.viewScale.toFixed(2) }; })()`);
  console.log('改成 2200x1100 后: ' + JSON.stringify(st2));
  const shot2 = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'S3-wide.png'), Buffer.from(shot2.data, 'base64'));
  console.log('截图 -> S3-wide.png');

  await send(ws, 'Emulation.setDeviceMetricsOverride', { width: 900, height: 1100, deviceScaleFactor: 1, mobile: false });
  await sleep(700);
  const st3 = await ev(`(() => { const t = __selfTest(); return { bw: document.getElementById('board').getAttribute('viewBox'), issues: t.issues, crossings: t.crossings }; })()`);
  console.log('改成 900x1100 后: ' + JSON.stringify(st3));
  const shot3 = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'S4-narrow.png'), Buffer.from(shot3.data, 'base64'));
  console.log('截图 -> S4-narrow.png');

  console.log('--- 异常 ---');
  console.log(errors.length ? errors.join('\n') : '(无)');
  ws.close();
  chrome.kill();
}
main().catch(e => { console.error('FATAL', e); chrome.kill(); process.exit(1); });
