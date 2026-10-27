/* 性能与交叉：给定 N 张照片，测一次 ringLayout 的耗时 + 自检交叉数。
   用法：node test\dbg-perf.mjs <N> [W] [H]                                        */
import { launch } from './_cdp.mjs';
import { IMGS15 } from './_env.mjs';
import fs from 'node:fs';
import path from 'node:path';

const N = +(process.argv[2] || 40);
const W = +(process.argv[3] || 2200);
const H = +(process.argv[4] || 1100);
const POOL = fs.readdirSync(IMGS15).filter((f) => f.endsWith('.png')).sort();
const files = [];
for (let i = 0; i < N; i++) files.push(path.join(IMGS15, POOL[i % POOL.length]));

const t = await launch({ port: 9642, profile: 'layperf', window: [W, H], timeout: 60000 });
try {
  await t.goto();
  await t.evaluate("indexedDB.deleteDatabase('photo-map-wall'); true");
  await t.goto();
  await t.sleep(400);
  const t0 = Date.now();
  await t.setFiles('#file', files);
  await t.sleep(600);
  // 等布局状态从 "空墙" 变成 N 张，最多 60 秒
  for (let k = 0; k < 120; k++) {
    const n = await t.evaluate('(window.__dbg.layoutState() || {}).n || 0');
    if (n >= N) break;
    await t.sleep(500);
  }
  const up = Date.now() - t0;
  const ms = await t.evaluate('(function(){var a=performance.now();window.__dbg.layout(150,14);return Math.round(performance.now()-a);})()');
  const st = await t.evaluate('JSON.stringify(window.__dbg.layoutState())');
  const x = await t.evaluate('JSON.stringify(window.__selfTest().crossings)');
  const iss = await t.evaluate('JSON.stringify(window.__selfTest().issues)');
  console.log('upload+render ' + up + 'ms | single ringLayout(150) ' + ms + 'ms');
  console.log('layoutState ' + st);
  console.log('crossings ' + x);
  console.log('issues ' + iss);
  await t.screenshot('PERF-' + N + '.png');
  console.log('done');
  process.exit(0);
} catch (e) {
  console.log('FATAL ' + (e && e.message));
  process.exit(1);
}
