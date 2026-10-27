// 诊断：大量照片 + 特定窗口比例时，红线为什么还剩交叉。
//   node test/dbg-crossings.mjs [照片数] [宽] [高]
// 输出排布状态（是否降级 cascade）、自检交叉数、以及每一对交叉线两端的针位/锚点。
// 注意：跑完不会自己退出（CDP 连接挂着），看够数据就 job_kill。
import fs from 'node:fs';
import path from 'node:path';
import { IMGS15, TMP } from './_env.mjs';
import { launch, sleep } from './_cdp.mjs';

const N = +(process.argv[2] || 30);
const W = +(process.argv[3] || 2200);
const H = +(process.argv[4] || 1100);
const POOL = fs.readdirSync(IMGS15).filter((f) => f.endsWith('.png')).sort();
const files = [];
for (let i = 0; i < N; i++) files.push(path.join(IMGS15, POOL[i % POOL.length]));

// 每轮从空墙开始，否则 IndexedDB 会把上一轮的照片带进来，数量对不上
const profileDir = path.join(TMP, 'dbgcross');
fs.rmSync(profileDir, { recursive: true, force: true });
fs.mkdirSync(profileDir, { recursive: true });

(async () => {
  const t = await launch({ port: 9493, profile: 'dbgcross', window: [W, H] });
  await t.goto();
  await sleep(800);
  // 确保从空墙开始：清掉 IndexedDB 再重载
  await t.evaluate("indexedDB.deleteDatabase('photo-map-wall')");
  await t.goto();
  await sleep(700);
  const before = JSON.parse(await t.evaluate('JSON.stringify(window.__dbg.photos().length)'));
  console.log('上传前照片数: ' + before);
  await t.setFiles('#file', files);
  await sleep(3500);

  const st = JSON.parse(await t.evaluate('JSON.stringify(window.__selfTest())'));
  const ls = JSON.parse(await t.evaluate('JSON.stringify(window.__dbg.layoutState())'));
  const cv = JSON.parse(await t.evaluate('JSON.stringify(window.__dbg.canvas())'));
  console.log('窗口 ' + W + '×' + H + '  上传 ' + N + ' 张');
  console.log('画布: ' + JSON.stringify(cv));
  console.log('排布: ' + JSON.stringify(ls));
  console.log('自检: photos=' + st.photos + ' crossings=' + st.crossings + ' issues=' + JSON.stringify(st.issues));

  const si = JSON.parse(await t.evaluate('JSON.stringify(window.__dbg.sideInfo())'));
  console.log('side: ' + si.map((o) => o.side + '@' + o.ang + '(' + o.ax + ',' + o.ay + ')').join(' '));
  const pairs = JSON.parse(await t.evaluate('JSON.stringify(window.__dbg.crossPairs())'));
  console.log('交叉对 ' + pairs.length + ' 组（pin = 地图上的针，锚 = 照片自己的针）：');
  for (const p of pairs.slice(0, 8)) {
    console.log('  pin' + JSON.stringify(p.pa) + ' → 锚' + JSON.stringify(p.sa) +
      '   ×   pin' + JSON.stringify(p.pb) + ' → 锚' + JSON.stringify(p.sb));
  }
  await t.screenshot('DBG-' + N + 'x' + W + 'x' + H + '.png');
  console.log('done');
  process.exit(0);
})().catch((e) => { console.log('FATAL ' + (e && e.message)); process.exit(1); });
