// 生成 README 用的「全球档」截图：真实照片 + 注入的国外坐标。
// 为什么不用 test/shots 里 cdp-world 的图：那个用的是纯蓝测试块，放进 README 像坏图。
// 这里的做法是拿 assets/demo5 的 5 张真照片，各自在 SOI 后插一个带 GPS 的 APP1。
import fs from 'node:fs';
import path from 'node:path';
import { launch } from './_cdp.mjs';
import { injectGps } from './_exif.mjs';
import { ROOT, TMP } from './_env.mjs';

// 五张真照片 → 五个国家（巴黎 / 纽约 / 东京 / 悉尼 / 北京）
const PLACES = [
  ['IMG_7596_1.jpg', 48.8566, 2.3522, '巴黎'],
  ['IMG_9010_2.jpg', 40.7128, -74.0060, '纽约'],
  ['IMG_8878.jpg', 35.6762, 139.6503, '东京'],
  ['IMG_1786_2.jpg', -33.8688, 151.2093, '悉尼'],
  ['IMG_7272.jpg', 39.9042, 116.4074, '北京'],
];

const OUT = path.join(TMP, 'docsgps');

function build() {
  fs.mkdirSync(OUT, { recursive: true });
  const files = [];
  for (const [name, lat, lon, label] of PLACES) {
    const src = fs.readFileSync(path.join(ROOT, 'assets', 'demo5', name));
    const dst = path.join(OUT, label + '-' + name);
    fs.writeFileSync(dst, injectGps(src, lat, lon));
    files.push(dst);
  }
  return files;
}

const files = build();
console.log('注入完成：' + files.length + ' 张 → ' + OUT);

const t = await launch({ port: 9701, profile: 'docs', window: [1600, 1000] });
try {
  await t.goto();
  await t.evaluate(`document.getElementById('btnDemo').click()`);
  await t.sleep(500);
  await t.setFiles('#file', files);
  await t.sleep(1800);

  const st = await t.evaluate(`JSON.stringify(window.__selfTest())`);
  const s = JSON.parse(st);
  console.log('photos=' + s.photos + ' yarns=' + s.yarns + ' pins=' + s.pins +
    ' crossings=' + s.crossings + ' issues=' + s.issues.length);

  const place = await t.evaluate(
    `JSON.stringify(window.__dbg.photos().map(p => p.city))`);
  console.log('地点：' + place);
  console.log('范围：' + await t.evaluate(`document.getElementById('selScope').value`));

  const p = await t.screenshot('D1-world-docs.png');
  console.log('截图：' + p);
} finally {
  const pass = t.report();
  await t.close();
  process.exit(pass ? 0 : 1);
}
