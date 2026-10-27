/* 诊断：给定 N 张照片，打印每个档位的 fits/x、每张的分边与锚点、以及交叉对。
   用法：node test\dbg-lay.mjs <N> [W] [H]                                          */
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

const t = await launch({ port: 9641, profile: 'laydbg', window: [W, H], timeout: 40000 });
try {
  await t.goto();
  await t.evaluate("indexedDB.deleteDatabase('photo-map-wall'); true");
  await t.goto();
  await t.sleep(400);
  await t.setFiles('#file', files);
  await t.sleep(1600);

  const st = await t.evaluate('JSON.stringify(window.__dbg.layoutState())');
  console.log('layoutState ' + st);
  console.log('canvas ' + (await t.evaluate('JSON.stringify(window.__dbg.canvas())')));

  const tiers = [200, 190, 180, 170, 160, 150, 140, 130, 120, 110, 100, 92, 84, 76, 68, 60, 54, 48, 42];
  const rows = await t.evaluate(
    'JSON.stringify(' + JSON.stringify(tiers) + '.map(function (cw) {' +
    '  try { var r = window.__dbg.layout(cw, cw < 140 ? 8 : 14); return [cw, r.fits, r.x, r.why]; }' +
    '  catch (e) { return [cw, "ERR", e.message]; } }))'
  );
  console.log('tiers ' + rows);
  console.log('sideInfo ' + (await t.evaluate('JSON.stringify(window.__dbg.sideInfo())')));
  console.log('crossPairs ' + (await t.evaluate('JSON.stringify(window.__dbg.crossPairs())')));
  console.log('crossings ' + (await t.evaluate('JSON.stringify(window.__selfTest().crossings)')));
  console.log('issues ' + (await t.evaluate('JSON.stringify(window.__selfTest().issues)')));

  await t.screenshot('LAY-' + N + '.png');
  console.log('done');
  process.exit(0);
} catch (e) {
  console.log('FATAL ' + (e && e.message));
  process.exit(1);
}
