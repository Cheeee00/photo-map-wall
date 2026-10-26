// 持久化（IndexedDB）验证：上传 → 刷新 → 复原 → 「示例」清空 → 再刷新仍干净。
// 必须走 http:// 而不是 file://：file:// 的源是不透明源，浏览器不给 IndexedDB 持久配额。
// 所以本脚本自带一个静态服务器。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, IMGS15 } from './_env.mjs';
import { launch, sleep } from './_cdp.mjs';

const HTTP_PORT = 9481;
const CDP_PORT = 9482;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.jpg': 'image/jpeg', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  const f = path.join(ROOT, rel);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); res.end('nope'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

const URL_ = `http://127.0.0.1:${HTTP_PORT}/index.html`;

const pics = fs.readdirSync(IMGS15).filter((f) => f.endsWith('.png')).sort().slice(0, 3).map((f) => path.join(IMGS15, f));

let t = null;
let fatal = null;

async function cities() {
  return JSON.parse(await t.evaluate(
    'JSON.stringify(window.__dbg.photos().map(function(p){return {city:p.city,lon:+p.lon.toFixed(3),lat:+p.lat.toFixed(3)};}))'));
}

async function counts(tag) {
  const st = JSON.parse(await t.evaluate('JSON.stringify(window.__selfTest())'));
  t.ok(tag + ' 自检无问题', st.issues.length === 0, JSON.stringify(st.issues));
  t.ok(tag + ' 红线零交叉', st.crossings === 0, 'crossings=' + st.crossings);
  return st;
}

(async () => {
  await new Promise((r) => server.listen(HTTP_PORT, '127.0.0.1', r));
  t = await launch({ port: CDP_PORT, profile: 'mwallpersist', window: [1440, 900] });

  await t.goto(URL_);
  await sleep(600);
  const db0 = await t.evaluate('window.__dbg.dbCount()');
  t.ok('初始状态：本地无记录', db0 === 0, 'dbCount=' + db0);
  let st = JSON.parse(await t.evaluate('JSON.stringify(window.__selfTest())'));
  t.ok('初始状态：放的是 5 张示例', st.photos === 5, 'photos=' + st.photos);

  // 上传 3 张真实照片
  await t.setFiles('#file', pics);
  await sleep(2600);
  st = await counts('上传 3 张后');
  t.ok('上传 3 张后：照片数 3', st.photos === 3, 'photos=' + st.photos);
  const db1 = await t.evaluate('window.__dbg.dbCount()');
  t.ok('上传后：本地存了 3 条', db1 === 3, 'dbCount=' + db1);
  const before = await cities();
  t.ok('上传后：每张都有地点', before.every((c) => c.city && c.city !== '未知地点'), JSON.stringify(before));

  // 刷新
  await t.goto(URL_);
  await sleep(2600);
  st = await counts('刷新后');
  t.ok('刷新后：照片复原为 3 张', st.photos === 3, 'photos=' + st.photos);
  const after = await cities();
  t.ok('刷新后：地点与刷新前一致', JSON.stringify(after) === JSON.stringify(before),
    JSON.stringify(after) + ' vs ' + JSON.stringify(before));
  const imgOk = await t.evaluate(
    'Array.prototype.every.call(document.querySelectorAll("#gPhotos image"), function(i){return i.getAttribute("href") && i.getAttribute("href").indexOf("data:image") === 0;})');
  t.ok('刷新后：照片图源仍是内嵌 dataURL（导出链路不受影响）', imgOk === true, 'dataURL=' + imgOk);
  t.ok('刷新后：粒度档可用（说明识别为真实照片）',
    (await t.evaluate('document.getElementById("selGran").disabled')) === false);

  await t.screenshot('P1-restored.png');

  // 点「示例」→ 清空本地
  await t.evaluate('document.getElementById("btnDemo").click()');
  await sleep(1400);
  st = JSON.parse(await t.evaluate('JSON.stringify(window.__selfTest())'));
  t.ok('点示例后：回到 5 张示例', st.photos === 5, 'photos=' + st.photos);
  await sleep(600);
  const db2 = await t.evaluate('window.__dbg.dbCount()');
  t.ok('点示例后：本地记录被清空', db2 === 0, 'dbCount=' + db2);

  // 再刷新：应仍是示例，不该把刚才的记录捞回来
  await t.goto(URL_);
  await sleep(2600);
  st = JSON.parse(await t.evaluate('JSON.stringify(window.__selfTest())'));
  t.ok('再刷新：仍是示例 5 张（没有被旧记录复活）', st.photos === 5, 'photos=' + st.photos);
  t.ok('再刷新：粒度档重新禁用', (await t.evaluate('document.getElementById("selGran").disabled')) === true);

  // 异常兜底：删掉一张后本地记录同步减少
  await t.setFiles('#file', pics);
  await sleep(2600);
  t.ok('再次上传：3 张', (await t.evaluate('window.__selfTest().photos')) === 3);
  await t.evaluate(`(function(){
    const p = window.__dbg.photos()[0];
    document.querySelector('#gPhotos > g[data-uid="' + p.uid + '"]').dispatchEvent(new MouseEvent('click', {bubbles:true}));
  })()`);
  await sleep(700);
  await t.evaluate('document.getElementById("popDel").click()');
  await sleep(1200);
  const db3 = await t.evaluate('window.__dbg.dbCount()');
  t.ok('删一张后：本地记录同步减到 2', db3 === 2, 'dbCount=' + db3);
})().catch((e) => { fatal = e; console.error('FATAL', e.message); })
  .finally(() => {
    const pass = t ? t.report() : false;
    try { server.close(); } catch (e) { }
    if (t) t.close();
    setTimeout(() => process.exit(pass && !fatal ? 0 : 1), 400);
  });
