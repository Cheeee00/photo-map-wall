// 稳定性矩阵：多尺寸 × 多照片数，外加四种「折腾」场景。
// 判据统一是三条：无 JS 异常、照片零重叠不出界、红线零交叉。
//
// 注意：这里刻意用 fs.writeSync(1, ...) 而不是 console.log。
// 一旦进程硬崩（0xC0000409），管道里的 stdout 缓冲会整段丢失，
// 同步写能把「崩之前跑到了哪一步」保留下来。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IMGS15 } from './_env.mjs';
import { launch, sleep } from './_cdp.mjs';

const say = (s) => { try { fs.writeSync(1, s + '\n'); } catch (e) { } };

const PAGE = 'file:///D:/DSH/创业项目/photo-map-wall/index.html';
const imgs = fs.readdirSync(IMGS15).filter((f) => f.endsWith('.png')).sort().map((f) => IMGS15 + '\\' + f);
// 注意：不要在这里删上一轮下载出来的 PNG。
// Windows 上对「刚被浏览器写完的图片」调 fs.rmSync 会让 node 进程以
// 0xC0000409（__fastfail）硬崩，且崩得没有任何堆栈和输出。
// 解法是每轮导出换一个全新的子目录，谁也不用删。
const DL = path.join(os.tmpdir(), 'photo-map-wall', '_dl_stability');
fs.mkdirSync(DL, { recursive: true });
const MARK = path.join(os.tmpdir(), 'photo-map-wall', 'stability-phase.txt');
const mark = (s) => { try { fs.appendFileSync(MARK, s + '\n'); } catch (e) { } };
fs.writeFileSync(MARK, '');

// 覆盖桌面 / 平板 / 手机、横屏 / 竖屏、超宽 / 超窄
const SIZES = [
  [2560, 1440, '2K 横屏'],
  [1920, 1080, '1080p'],
  [1600, 1000, '主力桌面'],
  [1366, 768, '老笔记本'],
  [1280, 800, '小笔记本'],
  [1024, 768, '4:3 老屏'],
  [1180, 820, 'iPad 横屏'],
  [820, 1180, 'iPad 竖屏'],
  [932, 430, '手机横屏'],
  [430, 932, 'iPhone Pro Max'],
  [393, 852, 'iPhone 14/15'],
  [360, 640, '小安卓'],
];

mark('cleaned');

mark('pre-launch');
const t = await launch({ port: 9521, profile: 'mwallstab', window: [1600, 1000], timeout: 90000 });
mark('post-launch');
let fatal = null;

const PROBE = `(function(){
  const st = __selfTest();
  const vb = document.getElementById('board').getAttribute('viewBox').split(' ').map(Number);
  const r = document.getElementById('board').getBoundingClientRect();
  const boxes = [];
  const nodes = document.querySelectorAll('#gPhotos > g');
  for (let i = 0; i < nodes.length; i++) {
    const b = nodes[i].getBoundingClientRect();
    boxes.push([Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)]);
  }
  return JSON.stringify({
    st: { crossings: st.crossings, issues: st.issues, photos: st.photos },
    vb: vb, rect: [r.width, r.height], boxes: boxes,
    iw: innerWidth, ih: innerHeight
  });
})()`;

function judge(label, p, expectN) {
  const bad = [];
  if (p.st.issues.length) bad.push('布局问题 ' + JSON.stringify(p.st.issues));
  if (p.st.crossings !== 0) bad.push('红线交叉 ' + p.st.crossings);
  if (expectN !== undefined && p.st.photos !== expectN) bad.push('照片数 ' + p.st.photos + '≠' + expectN);
  const vbRatio = p.vb[2] / p.vb[3];
  const viewRatio = p.rect[0] / p.rect[1];
  if (Math.abs(vbRatio - viewRatio) / viewRatio > 0.015) {
    bad.push('画布比例 ' + vbRatio.toFixed(4) + ' ≠ 可视区 ' + viewRatio.toFixed(4));
  }
  let clipped = 0;
  for (const b of p.boxes) {
    if (b[0] < -1 || b[1] < -1 || b[2] > p.iw + 1 || b[3] > p.ih + 1) clipped++;
  }
  if (clipped) bad.push(clipped + ' 张照片出界');
  t.ok(label, bad.length === 0, bad.join('；') || (p.st.photos + ' 张 · vb ' + p.vb[2] + '×' + p.vb[3]));
}

try {
  mark('goto');
  await t.goto(PAGE);
  mark('A');

  for (const [w, h, name] of SIZES) {
    mark('A ' + w + 'x' + h);
    await t.resize(w, h);
    judge('A ' + name + ' ' + w + '×' + h + '（示例）', JSON.parse(await t.evaluate(PROBE)), 5);
  }

  mark('B upload');
  await t.resize(1600, 1000);
  await t.setFiles('#file', imgs.slice(0, 15));
  await sleep(2600);
  for (const [w, h, name] of SIZES) {
    mark('B ' + w + 'x' + h);
    await t.resize(w, h, { settle: 620 });
    judge('B ' + name + ' ' + w + '×' + h + '（15 张）', JSON.parse(await t.evaluate(PROBE)), 15);
  }

  mark('C jitter');
  await t.resize(1600, 1000);
  for (let i = 0; i < 24; i++) {
    const w = 700 + Math.round(Math.random() * 1500);
    const h = 520 + Math.round(Math.random() * 900);
    mark('C ' + i + ' ' + w + 'x' + h);
    await t.resize(w, h, { settle: 90 });
  }
  await t.resize(1440, 900, { settle: 900 });
  judge('C 连续改窗 24 次后自愈', JSON.parse(await t.evaluate(PROBE)), 15);
  t.ok('C 抖动过程中无异常', t.events.exceptions.length === 0, t.events.exceptions.slice(0, 2).join(' | '));

  mark('D delete');
  for (let i = 0; i < 14; i++) {
    const ok = await t.evaluate(`(function(){
      const g = document.querySelectorAll('#gPhotos > g')[0];
      if (!g) return 0;
      g.dispatchEvent(new MouseEvent('click', {bubbles:true}));
      const b = document.getElementById('popDel');
      if (!b) return 0;
      b.click();
      return 1;
    })()`);
    if (!ok) break;
    await sleep(240);
  }
  await sleep(900);
  judge('D 删到只剩 1 张', JSON.parse(await t.evaluate(PROBE)), 1);

  mark('D refill');
  await t.setFiles('#file', imgs.slice(0, 15));
  await sleep(2400);
  judge('D 再补回 15 张（1+15=16）', JSON.parse(await t.evaluate(PROBE)), 16);

  mark('E zoom');
  const zoom = JSON.parse(await t.evaluate(`(function(){
    const zi = document.getElementById('btnZoomIn'), zo = document.getElementById('btnZoomOut');
    for (let i=0;i<40;i++) zo.click();
    const lo = __dbg.vw().s, base = __dbg.baseS();
    for (let i=0;i<60;i++) zi.click();
    return JSON.stringify({lo:lo, hi:__dbg.vw().s, base:base, loRatio:lo/base, hiRatio:__dbg.vw().s/base});
  })()`));
  t.ok('E 缩小有下限（≥0.78×基准）', zoom.loRatio >= 0.78, '缩到底 ' + zoom.loRatio.toFixed(3) + '×');
  t.ok('E 放大有上限（≤12×基准）', zoom.hiRatio <= 12.0001, '放到顶 ' + zoom.hiRatio.toFixed(3) + '×');

  await t.evaluate("document.getElementById('btnFit').click()");
  await sleep(1200);
  judge('E 缩放到极限后「适应全部」恢复', JSON.parse(await t.evaluate(PROBE)), 16);

  mark('F export');
  // 每轮导出换一个全新子目录：Windows 上删「刚被浏览器写完的图片」
  // 会让 node 以 0xC0000409(__fastfail) 硬崩，且没有任何堆栈输出。
  for (const [w, h, name, sub] of [[1600, 1000, '横屏', 'a'], [820, 1180, '竖屏', 'b']]) {
    mark('F ' + w + 'x' + h);
    const dir = path.join(DL, sub + '-' + Date.now());
    fs.mkdirSync(dir, { recursive: true });
    await t.resize(w, h, { settle: 800 });
    await t.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir, eventsEnabled: true });
    const box = JSON.parse(await t.evaluate('JSON.stringify(document.getElementById("btnExport").getBoundingClientRect())'));
    for (const type of ['mousePressed', 'mouseReleased']) {
      await t.send('Input.dispatchMouseEvent', {
        type, x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2), button: 'left', clickCount: 1,
      });
    }
    let file = null;
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      const now = fs.readdirSync(dir).filter((f) => f.endsWith('.png'));
      if (now.length) { file = now[0]; break; }
    }
    if (!file) {
      t.ok('F 导出（' + name + '）：文件落盘', false, '20 秒没出现文件；目录 ' + JSON.stringify(fs.readdirSync(dir)));
      continue;
    }
    const buf = fs.readFileSync(path.join(dir, file));
    const pw = buf.readUInt32BE(16), ph = buf.readUInt32BE(20);
    const canvas = JSON.parse(await t.evaluate('JSON.stringify(__dbg.canvas())'));
    const wantRatio = canvas.bw / canvas.bh;
    /* 导出基准高 1200 × 2（EXPORT_SCALE）；很大的画布会被 EXPORT_MAX_PX 等比收下来，所以只断言「不低于 1200」、高宽比另行验证 */
    t.ok('F 导出（' + name + '）：长边不低于 1200', ph >= 1200 && Math.max(pw, ph) >= 1200, pw + '×' + ph);
    t.ok('F 导出（' + name + '）：宽高比=画布比', Math.abs(pw / ph - wantRatio) / wantRatio < 0.01,
      'png ' + (pw / ph).toFixed(4) + ' vs 画布 ' + wantRatio.toFixed(4));
    t.ok('F 导出（' + name + '）：文件不是空的', buf.length > 200000, (buf.length / 1048576).toFixed(2) + ' MB');
  }
  mark('done');
} catch (e) {
  fatal = e;
} finally {
  if (fatal) say('FATAL ' + (fatal && fatal.message ? fatal.message : String(fatal)));
  const pass = t.report();
  mark('report done');
  await t.close();
  process.exit(pass && !fatal ? 0 : 1);
}
