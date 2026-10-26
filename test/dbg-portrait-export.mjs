// 只查一件事：竖屏窗口下点「导出」为什么不产生文件。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IMGS15 } from './_env.mjs';
import { launch, sleep } from './_cdp.mjs';

const PAGE = 'file:///D:/DSH/创业项目/photo-map-wall/index.html';
const imgs = fs.readdirSync(IMGS15).filter((f) => f.endsWith('.png')).sort().map((f) => IMGS15 + '\\' + f);
const DL = path.join(os.tmpdir(), 'photo-map-wall', '_dl_portrait');
fs.rmSync(DL, { recursive: true, force: true });
fs.mkdirSync(DL, { recursive: true });

const t = await launch({ port: 9513, profile: 'mwallport', window: [1600, 1000] });
try {
  await t.goto(PAGE);
  await t.setFiles('#file', imgs.slice(0, 5));
  await sleep(2200);
  await t.resize(820, 1180, { settle: 1000 });

  console.log('画布', await t.evaluate('JSON.stringify(__dbg.canvas())'));
  console.log('按钮盒', await t.evaluate("JSON.stringify(document.getElementById('btnExport').getBoundingClientRect())"));
  console.log('窗口', await t.evaluate('JSON.stringify({iw:innerWidth,ih:innerHeight,dpr:devicePixelRatio})'));

  // 直接调内部导出，看它到底抛不抛
  const direct = await t.evaluate(`(async function(){
    try {
      const p = document.getElementById('btnExport');
      p.click();
      return 'click-ok';
    } catch(e) { return 'THROW ' + e.message; }
  })()`);
  console.log('直接 click：', direct);

  // 监听 unhandledrejection 与 error
  await t.evaluate(`(function(){
    window.__errs = [];
    window.addEventListener('unhandledrejection', e => window.__errs.push('unhandled: ' + (e.reason && e.reason.message || e.reason)));
    window.addEventListener('error', e => window.__errs.push('error: ' + e.message));
    return 1;
  })()`);

  await t.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true });
  const box = JSON.parse(await t.evaluate(`JSON.stringify(document.getElementById('btnExport').getBoundingClientRect())`));
  for (const type of ['mousePressed', 'mouseReleased']) {
    await t.send('Input.dispatchMouseEvent', {
      type, x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2), button: 'left', clickCount: 1,
    });
  }
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const f = fs.readdirSync(DL);
    if (f.length) { console.log('第 ' + (i + 1) + ' 次轮询出现文件：', f); break; }
  }
  console.log('下载目录内容：', JSON.stringify(fs.readdirSync(DL)));
  console.log('页面错误：', await t.evaluate('JSON.stringify(window.__errs || [])'));
  await t.screenshot('X-portrait-export.png');
} finally {
  console.log('异常日志：', t.events.exceptions.concat(t.events.errors).join(' | ') || '(无)');
  await t.close();
  process.exit(0);
}
