/* 只测交叉/重叠/出界与耗时，不调用任何会改变页面状态的诊断钩子。
   用法：node test\dbg-x.mjs <N> [W] [H]                                      */
import { launch } from './_cdp.mjs';
import { IMGS15 } from './_env.mjs';
import fs from 'node:fs';
import path from 'node:path';

const N = +(process.argv[2] || 15);
const W = +(process.argv[3] || 2200);
const H = +(process.argv[4] || 1100);
const POOL = fs.readdirSync(IMGS15).filter((f) => f.endsWith('.png')).sort();
const files = [];
for (let i = 0; i < N; i++) files.push(path.join(IMGS15, POOL[i % POOL.length]));

const t = await launch({ port: 9644, profile: 'layx', window: [W, H], timeout: 60000 });
try {
  await t.goto();
  await t.evaluate("indexedDB.deleteDatabase('photo-map-wall'); true");
  await t.goto();
  await t.sleep(400);
  const t0 = Date.now();
  await t.setFiles('#file', files);
  for (let k = 0; k < 100; k++) {
    const n = await t.evaluate('(window.__dbg.layoutState() || {}).n || 0');
    if (n >= N) break;
    await t.sleep(100);
  }
  await t.sleep(900);                       // 等视野补间走完
  const ms = Date.now() - t0;
  const r = JSON.parse(await t.evaluate('JSON.stringify((function(){var s=window.__selfTest();return {n:s.photos, x:s.crossings, iss:s.issues, yarns:s.yarns, pins:s.pins};})())'));
  console.log('N=' + N + ' render=' + ms + 'ms photos=' + r.n + ' crossings=' + r.x +
              ' yarns=' + r.yarns + ' pins=' + r.pins + ' issues=' + JSON.stringify(r.iss).slice(0, 200));
  const lay = JSON.parse(await t.evaluate('JSON.stringify(window.__dbg.layoutState())'));
  console.log('layout ' + JSON.stringify(lay));
  await t.screenshot('X-' + N + '.png');
  console.log('done');
  process.exit(0);
} catch (e) {
  console.log('FATAL ' + (e && e.message));
  process.exit(1);
}
