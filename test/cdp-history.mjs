// R18「清空即归档」的**浏览器级**冒烟：真点击、真面板、真 KV。
// R18 交付时这一层是缺的（后端契约 39/39 只证明了接口，没证明按钮能点）。
//
// 需要先起本地后端：npx wrangler pages dev dist --port 8792
// 脚本自己会去起，起不来就报错而不是假装通过。
//
// 验的是用户原话那件事：
//   点「清空」→ 眼前空了，但照片进「历史」，**同步码一个字都不能变**；想彻底删再删。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, IMGS15, SHOTS_DIR } from './_env.mjs';
import { launch, sleep } from './_cdp.mjs';

const HTTP_PORT = 8792;
const CDP_PORT = 9493;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const URL_ = `${BASE}/`;
const LOG = path.join(process.env.TEMP || '.', 'pmw-hist-dev.log');

const all = fs.readdirSync(IMGS15).filter((f) => f.endsWith('.png')).sort();
const pics3 = all.slice(0, 3).map((f) => path.join(IMGS15, f));
const pics2 = all.slice(3, 5).map((f) => path.join(IMGS15, f));

let t = null;
let fatal = null;
let dev = null;

async function alive() {
  try { const r = await fetch(`${BASE}/api/wall/ping`); return r.ok; } catch (e) { return false; }
}

async function startDev() {
  if (await alive()) return true;                 // 已经有人在跑就复用
  const out = fs.openSync(LOG, 'w');
  dev = spawn('npx', ['--yes', 'wrangler', 'pages', 'dev', 'dist',
    '--port', String(HTTP_PORT), '--ip', '127.0.0.1'], {
    cwd: ROOT, shell: true, stdio: ['ignore', out, out],
    env: Object.assign({}, process.env, { WRANGLER_SEND_METRICS: 'false' }),
  });
  for (let i = 0; i < 60; i++) {
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

// 轮询到页面里的某个表达式满足条件为止（不用固定 sleep 赌时序）
async function until(expr, ok, ms = 15000, step = 180) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    try { last = await t.evaluate(expr); } catch (e) { last = undefined; }
    if (ok(last)) return { ok: true, v: last, ms: Date.now() - t0 };
    await sleep(step);
  }
  return { ok: false, v: last, ms: Date.now() - t0 };
}

async function info() {
  return JSON.parse(await t.evaluate('JSON.stringify(window.__dbg.syncInfo())'));
}
async function nLocal() {
  return await t.evaluate('window.__dbg.photos().length');
}
async function hintText() {
  return await t.evaluate('(document.getElementById("hint")||{}).textContent||""');
}
// 本机看到的云端清单（用同一把 key 直接问后端，绕开页面缓存）
async function remote(key) {
  const r = await fetch(`${BASE}/api/wall/index`, { headers: { 'x-wall-key': key } });
  if (!r.ok) return { photos: [], status: r.status };
  const o = await r.json();
  return { photos: (o && o.photos) || [], status: r.status, code: o && o.code };
}
async function hist(key) {
  const r = await fetch(`${BASE}/api/wall/history`, { headers: { 'x-wall-key': key } });
  if (!r.ok) return { items: [], status: r.status };
  const o = await r.json();
  return { items: (o && o.items) || [], status: r.status };
}

async function cleanSlate() {
  // 清空本机三处存储 → 重新载入 → 一个全新的设备身份（也顺便清掉上一轮残留）
  try {
    await t.evaluate(`(function(){
      try { indexedDB.deleteDatabase('photo-map-wall'); } catch (e) {}
      try { localStorage.clear(); } catch (e) {}
      document.cookie = 'pmw_key=;max-age=0;path=/';
      document.cookie = 'pmw_dev=;max-age=0;path=/';
      return 1;
    })()`);
  } catch (e) { /* 首次可能还没导航 */ }
  await t.goto(URL_ + '?fresh=' + Date.now());
}

async function upload(files) {
  await t.setFiles('#file', files);
  // 上传是异步的（读 EXIF → 建 photo → 排队传云端），等到云端清单条数稳定
  await sleep(1200);
}

async function main() {
  if (!(await startDev())) throw new Error('本地后端没起来，端口 ' + HTTP_PORT);

  t = await launch({ port: CDP_PORT, profile: 'mwallhist', window: [1600, 1000], loadWait: 2600 });
  await t.goto(URL_);
  await cleanSlate();

  // ---------- 一、先有一面有内容的墙 ----------
  await upload(pics3);
  const i1 = await info();
  t.ok('拿到设备身份（32 位 hex）', /^[0-9a-f]{32}$/.test(i1.key || ''), i1.key);
  const up = await until(`window.__dbg.photos().length`, (v) => v === 3, 15000);
  t.ok('三张照片进了墙', up.ok, 'photos=' + up.v);

  const r1 = await until(`window.__dbg.syncInfo().code`, (v) => !!v, 12000);
  const code0 = r1.v || '';
  t.ok('云端给出了 12 位同步码', /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(String(code0)), code0);
  const rem1 = await until('1', () => true, 100, 100);   // 占位，下面直接取
  void rem1;
  let remoteNow = await remote(i1.key);
  const wait3 = await (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      remoteNow = await remote(i1.key);
      if (remoteNow.photos.length === 3) return true;
      await sleep(300);
    }
    return false;
  })();
  t.ok('云端清单也存了 3 张', wait3, 'remote=' + remoteNow.photos.length);

  // ---------- 二、点「清空」：本机空、照片进历史、同步码不变 ----------
  t.ok('点「同步」按钮能打开面板', await t.evaluate(
    '(function(){document.getElementById("btnSync").click();'
    + 'return document.getElementById("syncPanel").classList.contains("on");})()'));

  // 两次 confirm 都自动确认（purge 要两次，清空要一次）
  await t.evaluate('window.confirm = function(){ return true; }');
  await t.evaluate('document.getElementById("btnWipe").click()');

  const gone = await until(`window.__dbg.photos().length`, (v) => v === 0, 20000);
  t.ok('清空后本机照片为 0', gone.ok, 'photos=' + gone.v);

  const h1 = await hintText();
  t.ok('提示写明照片存进了历史', /存进历史第\s*0?\d+\s*批/.test(h1), h1.slice(0, 60));

  const i2 = await info();
  t.ok('清空后同步码一个字没变', i2.code === code0, code0 + ' → ' + i2.code);
  t.ok('清空后设备识别码没变', i2.key === i1.key, (i1.key || '').slice(0, 8) + '…');

  const rem2 = await remote(i1.key);
  t.ok('云端当前清单已空', rem2.photos.length === 0, 'remote=' + rem2.photos.length);

  const hi1 = await hist(i1.key);
  t.ok('云端出现 1 批历史', hi1.items.length === 1, JSON.stringify(hi1.items));
  t.ok('第 01 批记着 3 张', hi1.items[0] && hi1.items[0].n === '01' && hi1.items[0].photos === 3,
    JSON.stringify(hi1.items[0] || {}));

  // ---------- 三、面板里真的能看到这批 ----------
  await t.evaluate('document.getElementById("btnHist").click()');
  const hs = await until('document.getElementById("histList").textContent', (v) => /第\s*01\s*批/.test(v || ''), 10000);
  t.ok('历史面板列出「第 01 批」', hs.ok, String(hs.v || '').slice(0, 60));
  t.ok('历史面板写明「3 张」', /3\s*张/.test(String(hs.v || '')), String(hs.v || '').slice(0, 60));
  t.ok('历史批次数显示 1', String(await t.evaluate('document.getElementById("histCount").textContent')).trim() === '1',
    await t.evaluate('document.getElementById("histCount").textContent'));
  await t.screenshot('H1-history.png');

  // ---------- 四、删掉这一批 ----------
  await t.evaluate('(document.querySelectorAll("#histList .hist-item .act")[0]||{click:function(){}}).click()');
  const hi2 = await until('1', () => true, 100, 100);
  void hi2;
  const goneHist = await (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 12000) {
      const h = await hist(i1.key);
      if (h.items.length === 0) return true;
      await sleep(300);
    }
    return false;
  })();
  t.ok('删掉这批后历史为空', goneHist);
  const emptyUi = await until('document.getElementById("histList").textContent',
    (v) => /还没有历史/.test(v || ''), 8000);
  t.ok('删完 UI 回到「还没有历史」', emptyUi.ok, String(emptyUi.v || '').slice(0, 40));

  // ---------- 五、同步码还能用（清空 ≠ 码失效） ----------
  await t.evaluate('window.confirm = function(){ return true; }');
  await t.evaluate('document.getElementById("syncPanel").classList.remove("on")');
  await upload(pics2);
  const up2 = await until(`window.__dbg.photos().length`, (v) => v === 2, 15000);
  t.ok('清空之后还能继续加照片（2 张）', up2.ok, 'photos=' + up2.v);
  const rem3 = await (async () => {
    const t0 = Date.now();
    let r = null;
    while (Date.now() - t0 < 15000) {
      r = await remote(i1.key);
      if (r.photos.length === 2) return r;
      await sleep(300);
    }
    return r;
  })();
  t.ok('这 2 张也进了同一把 key 的清单', rem3.photos.length === 2, 'remote=' + rem3.photos.length);
  t.ok('同步码仍然是原来那个', (await info()).code === code0, code0);
  // 记一张原图的 id，用来验证「彻底删除」之后字节真的取不到了
  const firstId = (rem3.photos[0] || {}).id;
  const blobBefore = await fetch(`${BASE}/api/wall/blob?id=${encodeURIComponent(firstId)}`,
    { headers: { 'x-wall-key': i1.key } });
  t.ok('彻底删除之前原图是取得到的', blobBefore.status === 200, 'status=' + blobBefore.status);

  // ---------- 六、彻底删除（两次 confirm） ----------
  await t.evaluate('document.getElementById("btnSync").click()');
  await t.evaluate('window.confirm = function(){ return true; }');
  await t.evaluate('document.getElementById("btnPurge").click()');
  // 等到「旧同步码真的接不回来」为止（这才是隐私出口的可判据信号）
  const purged = await (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      const pr = await fetch(`${BASE}/api/wall/pair`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: code0 }),
      });
      if (pr.status === 404) return true;
      await sleep(300);
    }
    return false;
  })();
  t.ok('彻底删除后旧同步码立刻失效（404）', purged);
  // 注意：这里的 key 是「一串随机十六进制」，服务端没有「已注册的 key 名单」，
  // 所以 purge 之后同一把 key 再问清单，得到的是「空墙 200」而不是 401 ——
  // 401 只在「没带 key / 格式非法」时出现。真正确保「回不来」的是 cod: 映射被删（下面的 404）。
  const afterPurge = await remote(i1.key);
  t.ok('彻底删除后同一把 key 也读不到东西（空清单）',
    afterPurge.status === 200 && afterPurge.photos.length === 0,
    'status=' + afterPurge.status + ' photos=' + afterPurge.photos.length);
  const blobAfter = await fetch(`${BASE}/api/wall/blob?id=${encodeURIComponent(firstId)}`,
    { headers: { 'x-wall-key': i1.key } });
  t.ok('彻底删除后原图取不到了（404）', blobAfter.status === 404, 'status=' + blobAfter.status);
  t.ok('彻底删除后历史也没了', (await hist(i1.key)).items.length === 0);
  const pair = await fetch(`${BASE}/api/wall/pair`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: code0 }),
  });
  t.ok('旧同步码接不回来了（404）', pair.status === 404, 'status=' + pair.status);
  t.ok('彻底删除后本机也空了', (await nLocal()) === 0, 'photos=' + (await nLocal()));

  const s = JSON.parse(await t.evaluate('JSON.stringify(window.__selfTest())'));
  t.ok('全程排布无问题', s.issues.length === 0, JSON.stringify(s.issues));
  t.ok('全程红线零交叉', s.crossings === 0, 'crossings=' + s.crossings);
  await t.screenshot('H2-after-purge.png');
}

try {
  await main();
} catch (e) {
  fatal = e;
  console.log('FATAL ' + (e && e.message ? e.message : e));
} finally {
  if (t) {
    const pass = t.report();
    try { await t.close(); } catch (e) { /* 忽略 */ }
    stopDev();
    process.exit(pass && !fatal ? 0 : 1);
  }
  stopDev();
  process.exit(1);
}
