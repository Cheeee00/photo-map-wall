// 验证照片拖动：按下→移动→松开后 p.pos 被记住、红线端点跟着走、不误触预览；
// 再点「回原位」应清掉 p.pos 并回到自动排布位置。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PAGE_FILE, PAGE_URL, SHOTS_DIR, IMGS15, EXIFCASES, DEMO5, chromePath, userDataDir } from './_env.mjs';

const CHROME = chromePath();
const PORT = 9395;
const TMP = userDataDir('mwalld');
const OUT = SHOTS_DIR;
const PAGE = PAGE_URL;

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
  await send(ws, 'Runtime.enable'); await send(ws, 'Page.enable');
  await send(ws, 'Page.navigate', { url: PAGE });
  await sleep(2400);

  const ev = async (expr) => {
    const r = await send(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const mouse = (type, x, y, extra) => send(ws, 'Input.dispatchMouseEvent', Object.assign({ type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 }, extra || {}));

  // 取第一张照片的屏幕中心 + 它的 uid
  const info = await ev(`(() => {
    const g = document.querySelector('#gPhotos > g');
    const r = g.getBoundingClientRect();
    const p = __dbg.photos().find(function (q) { return q.uid === +g.getAttribute('data-uid'); });
    return { uid: +g.getAttribute('data-uid'), x: r.x + r.width / 2, y: r.y + r.height / 2,
             pos: p ? p.pos : 'n/a', t: g.getAttribute('transform') };
  })()`);
  console.log('拖动前: ' + JSON.stringify(info));

  const x0 = info.x, y0 = info.y;
  await mouse('mousePressed', x0, y0);
  for (let k = 1; k <= 12; k++) {
    await mouse('mouseMoved', x0 + k * 9, y0 + k * 5);
    await sleep(16);
  }
  await mouse('mouseReleased', x0 + 108, y0 + 60);
  await sleep(400);

  const after = await ev(`(() => {
    const g = document.querySelector('#gPhotos > g');
    const p = __dbg.photos().find(function (q) { return q.uid === ${info.uid}; });
    const y = document.querySelectorAll('#gYarn path')[0];
    return { pos: p.pos ? p.pos.map(Math.round) : null, t: g.getAttribute('transform'),
             viewer: document.getElementById('viewer').classList.contains('on'),
             yarn: y.getAttribute('d') };
  })()`);
  console.log('拖动后: ' + JSON.stringify(after));

  const shot = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'S6-drag.png'), Buffer.from(shot.data, 'base64'));
  console.log('截图 -> S6-drag.png');

  // 点开这张照片 → 「回原位」按钮应可见 → 点击 → pos 清空
  await ev(`(() => { const g = document.querySelector('#gPhotos > g'); g.dispatchEvent(new MouseEvent('click', {bubbles:true})); return true; })()`);
  await sleep(300);
  console.log('回原位按钮可见 = ' + await ev(`!document.getElementById('popReset').hidden`));
  await ev(`document.getElementById('popReset').click()`);
  await sleep(400);
  const back = await ev(`(() => {
    const p = __dbg.photos().find(function (q) { return q.uid === ${info.uid}; });
    const t = __selfTest();
    return { pos: p.pos || null, issues: t.issues, crossings: t.crossings };
  })()`);
  console.log('回原位后: ' + JSON.stringify(back));

  // 真实鼠标点击（不移动）应打开预览，而不是被拖动逻辑吃掉
  await ev(`document.getElementById('viewerClose').click()`);
  await sleep(200);
  const c2 = await ev(`(() => { const g = document.querySelectorAll('#gPhotos > g')[1]; const r = g.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`);
  await mouse('mousePressed', c2.x, c2.y);
  await sleep(30);
  await mouse('mouseReleased', c2.x, c2.y);
  await sleep(400);
  console.log('真实点击后 viewer.on = ' + await ev(`document.getElementById('viewer').classList.contains('on')`));
  await ev(`document.getElementById('viewerClose').click()`);

  console.log('--- 异常 ---');
  console.log(errors.length ? errors.join('\n') : '(无)');
  ws.close(); chrome.kill();
}
main().catch(e => { console.error('FATAL', e); chrome.kill(); process.exit(1); });
