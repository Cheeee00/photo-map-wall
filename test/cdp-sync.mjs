// 「同一面墙」端到端验证（真浏览器 + 真 Pages Function）。
// 需要先起本地后端：npx wrangler pages dev dist --port 8791
// 脚本自己会去起，起不来就报错而不是假装通过。
//
// 验的是用户真正问的那件事：
//   朋友传了一批 → 你传一批 → 关掉网页再回来（刷新/换设备）→ 照片还在，而且是同一面墙。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, IMGS15, chromePath } from './_env.mjs';
import { launch, sleep } from './_cdp.mjs';

const HTTP_PORT = 8791;
const CDP_PORT = 9491;
const URL_ = `http://127.0.0.1:${HTTP_PORT}/`;
const LOG = path.join(process.env.TEMP || '.', 'pmw-sync-dev.log');

const pics = fs.readdirSync(IMGS15).filter((f) => f.endsWith('.png')).sort().slice(0, 3)
  .map((f) => path.join(IMGS15, f));

let t = null;
let fatal = null;
let dev = null;

async function alive() {
  try {
    const r = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/wall/ping`);
    return r.ok;
  } catch (e) { return false; }
}

async function startDev() {
  if (await alive()) return true;          // 已经有人在跑（本地调试时复用）
  const out = fs.openSync(LOG, 'w');
  dev = spawn('npx', ['--yes', 'wrangler', 'pages', 'dev', 'dist',
    '--port', String(HTTP_PORT), '--ip', '127.0.0.1'], {
    cwd: ROOT, shell: true, stdio: ['ignore', out, out],
    env: Object.assign({}, process.env, { WRANGLER_SEND_METRICS: 'false' }),
  });
  for (let i = 0; i < 60; i++) {           // 最多等 60 秒
    await sleep(1000);
    if (await alive()) return true;
  }
  return false;
}

function stopDev() {
  if (!dev) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(dev.pid), '/T', '/F'], { shell: true });
    else dev.kill('SIGKILL');
  } catch (e) { /* 忽略 */ }
}

async function st(tag) {
  const s = JSON.parse(await t.evaluate('JSON.stringify(window.__selfTest())'));
  t.ok(tag + '：排布无问题', s.issues.length === 0, JSON.stringify(s.issues));
  t.ok(tag + '：红线零交叉', s.crossings === 0, 'crossings=' + s.crossings);
  return s;
}
async function info() {
  return JSON.parse(await t.evaluate('JSON.stringify(window.__dbg.syncInfo())'));
}
async function cities() {
  return JSON.parse(await t.evaluate(
    'JSON.stringify(window.__dbg.photos().map(function(p){return p.city;}))'));
}

(async () => {
  if (!(await startDev())) {
    console.error('本地后端起不来，看日志：' + LOG);
    stopDev();
    process.exit(1);
  }
  t = await launch({ port: CDP_PORT, profile: 'mwallsync', window: [1440, 900] });

  // ---- 第一台设备：上传 3 张，拿到同步码 ----
  await t.goto(URL_);
  await sleep(1500);
  let i0 = await info();
  t.ok('本机身份是 32 位 hex key', /^[a-f0-9]{32}$/.test(i0.key), i0.key);
  t.ok('http 页面下同步可用', i0.allowed === true, JSON.stringify(i0));

  await t.setFiles('#file', pics);
  await sleep(5200);                        // 等上传队列跑完 + 清单落库

  await st('上传 3 张后');
  let i1 = await info();
  t.ok('云端清单收到 3 张', i1.remote === 3, 'remote=' + i1.remote);
  t.ok('拿到了同步码（XXXX-XXXX-XXXX）', /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(i1.code || ''), i1.code);
  t.ok('状态是已同步', i1.state === 'ok', i1.state);
  const codeA = i1.code;
  const citiesA = await cities();
  t.ok('3 张都有地点', citiesA.every((c) => c && c !== '未知地点'), JSON.stringify(citiesA));

  // 服务端直查：清单里确实是 3 张
  const raw = await (await fetch(`http://127.0.0.1:${HTTP_PORT}/api/wall/index`,
    { headers: { 'x-wall-key': i1.key } })).json();
  t.ok('服务端清单 3 条', (raw.photos || []).length === 3, JSON.stringify(raw.photos && raw.photos.length));
  t.ok('服务端存的是压过的中等尺寸版本（长边≤1600、≤1.5MB）', (raw.photos || []).every((p) => p.bytes > 0 && p.bytes <= 1.5 * 1024 * 1024 && p.t === 'image/jpeg'), JSON.stringify(raw.photos));

  // ---- 模拟「换一台设备」：清身份 + 清本地库 ----
  await t.evaluate("localStorage.removeItem('pmw.wallKey');document.cookie='pmw_key=; path=/; max-age=0';'ok'");
  await t.evaluate("new Promise(function(res){var r=indexedDB.deleteDatabase('photo-map-wall');r.onsuccess=function(){res(1);};r.onerror=function(){res(0);};r.onblocked=function(){res(0);};})");
  await t.goto(URL_);
  await sleep(1600);
  let i2 = await info();
  t.ok('新设备是另一把 key', i2.key !== i1.key, i2.key);
  t.ok('新设备看到的是示例（不是别人的照片）', (await st('新设备初始')).photos === 5, '');

  // ---- 输入同步码接回 ----
  const joined = JSON.parse(await t.evaluate(
    'window.__dbg.syncJoin(' + JSON.stringify(codeA) + ').then(function(r){return JSON.stringify(r);})'));
  t.ok('用同步码接上了', joined.ok === true, JSON.stringify(joined));
  await sleep(1200);
  const s3 = await st('接回后');
  t.ok('接回后照片数 = 3', s3.photos === 3, 'photos=' + s3.photos);
  const citiesB = await cities();
  t.ok('接回后地点与原来一致', JSON.stringify(citiesB) === JSON.stringify(citiesA),
    JSON.stringify(citiesB) + ' vs ' + JSON.stringify(citiesA));
  const imgOk = await t.evaluate(
    "(function(){var n=document.querySelectorAll('#gPhotos > g image');if(!n.length)return 'no-img';"
    + "return String(n[0].getAttribute('href')||'').slice(0,11);})()");
  t.ok('接回的照片是真实图像（data:image）', imgOk === 'data:image/', imgOk);

  // ---- 输入错码 ----
  const bad = JSON.parse(await t.evaluate(
    'window.__dbg.syncJoin("AAAA-BBBB-CCCC").then(function(r){return JSON.stringify(r);})'));
  t.ok('错码被拒绝', bad.ok === false, JSON.stringify(bad));

  // ---- 删一张 → 云端也跟着删 ----
  const delRes = await t.evaluate(
    "(function(){var ps=window.__dbg.photos();var p=ps[ps.length-1];"
    + "var g=document.querySelectorAll('#gPhotos > g');g[g.length-1].dispatchEvent(new MouseEvent('click',{bubbles:true}));"
    + "return 'clicked';})()");
  t.ok('能点开预览', delRes === 'clicked', delRes);
  await sleep(400);
  await t.evaluate("document.getElementById('popDel').click();'ok'");
  await sleep(2600);
  const raw2 = await (await fetch(`http://127.0.0.1:${HTTP_PORT}/api/wall/index`,
    { headers: { 'x-wall-key': (await info()).key } })).json();
  t.ok('删掉一张后云端清单剩 2 条', (raw2.photos || []).length === 2,
    'n=' + (raw2.photos || []).length);

  // ---- 删整面墙 ----
  const wiped = JSON.parse(await t.evaluate(
    'window.__dbg.syncWipe().then(function(r){return JSON.stringify(r);})'));
  t.ok('删整墙成功', wiped.ok === true, JSON.stringify(wiped));
  const raw3 = await (await fetch(`http://127.0.0.1:${HTTP_PORT}/api/wall/index`,
    { headers: { 'x-wall-key': (await info()).key } })).json();
  t.ok('删整墙后清单为空', (raw3.photos || []).length === 0, JSON.stringify(raw3.photos));

  // 页面不该因为云端被删而崩
  const s5 = await st('清空云端后本机');
  t.ok('清空云端后本机照片仍在', s5.photos === 2, 'photos=' + s5.photos);
})()
  .catch((e) => { fatal = e; })
  .finally(async () => {
    const pass = t ? t.report() : false;
    if (t) await t.close().catch(() => {});
    stopDev();
    if (fatal) console.error('FATAL', fatal);
    process.exit(pass && !fatal ? 0 : 1);
  });
