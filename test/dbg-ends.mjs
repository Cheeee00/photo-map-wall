/* 比对「排布用的锚点」与「实际画线用的端点」是否一致。
   用法：node test\dbg-ends.mjs <N> [W] [H]                                   */
import { launch } from './_cdp.mjs';
import { IMGS15 } from './_env.mjs';
import fs from 'node:fs';
import path from 'node:path';

const N = +(process.argv[2] || 30);
const W = +(process.argv[3] || 2200);
const H = +(process.argv[4] || 1100);
const POOL = fs.readdirSync(IMGS15).filter((f) => f.endsWith('.png')).sort();
const files = [];
for (let i = 0; i < N; i++) files.push(path.join(IMGS15, POOL[i % POOL.length]));

const t = await launch({ port: 9643, profile: 'layends', window: [W, H], timeout: 60000 });
try {
  await t.goto();
  await t.evaluate("indexedDB.deleteDatabase('photo-map-wall'); true");
  await t.goto();
  await t.sleep(400);
  await t.setFiles('#file', files);
  await t.sleep(1500);

  const ends = JSON.parse(await t.evaluate('JSON.stringify(window.__dbg.ends())'));
  let bad = 0;
  for (const e of ends) {
    if (e.ax === null || !e.pb) { bad++; console.log('MISSING ' + JSON.stringify(e)); continue; }
    const dx = Math.abs(e.ax - e.pb[0]), dy = Math.abs(e.ay - e.pb[1]);
    if (dx > 0.5 || dy > 0.5) { bad++; if (bad <= 8) console.log('DIFF ' + JSON.stringify(e) + ' d=' + dx.toFixed(1) + ',' + dy.toFixed(1)); }
    if (e.pos) console.log('HASPOS ' + JSON.stringify(e));
  }
  console.log('ends ' + ends.length + ' mismatch(or missing) ' + bad);
  console.log('crossPairs ' + (await t.evaluate('JSON.stringify(window.__dbg.crossPairs())')));
  console.log('crossings ' + (await t.evaluate('JSON.stringify(window.__selfTest().crossings)')));
  console.log('done');
  process.exit(0);
} catch (e) {
  console.log('FATAL ' + (e && e.message));
  process.exit(1);
}
