// 不开浏览器，直接在 node 里跑页面那份 parseExifGps ——
// 隔离「EXIF 解析器」与「页面/上传链路」，也顺便证明这段源码不依赖任何浏览器 API。
//
//   node test/exif-node.mjs
//
// 两组输入：
//   1) assets/demo5 的 5 张真实照片（真相机拍的，GPS 已知）
//   2) 临时目录里合成的 9 个 case（test/gen-exif-cases.mjs 产出，覆盖南北半球/东西经）
import fs from 'node:fs';
import path from 'node:path';
import { PAGE_FILE, EXIFCASES, DEMO5 } from './_env.mjs';

let bad = 0;
function ok(name, cond, detail) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : '  [' + detail + ']'));
  if (!cond) bad++;
}

// ---- 从产物里抠出解析器源码，在 node 里 eval ----
const src = fs.readFileSync(PAGE_FILE, 'utf8');
const start = src.indexOf('function exifTypeSize(t)');
const end = src.indexOf('/* GPS → 地点标签');
if (start < 0 || end < 0) {
  console.error('找不到解析器片段（start=' + start + ' end=' + end + '）——产物结构变了，请同步本脚本');
  process.exit(1);
}
const D2R = Math.PI / 180;
const { parseExifGps } = new Function('D2R', src.slice(start, end) + '\nreturn {parseExifGps};')(D2R);
ok('能在产物里定位并加载 parseExifGps', typeof parseExifGps === 'function');

const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ---- 1. 真实照片：文件名 → 真实 GPS（来自 Lightroom / iPhone 原始 EXIF） ----
const REAL = {
  'IMG_7596_1.jpg': [44.6815, 81.0663],
  'IMG_9010_2.jpg': [48.6334, 87.0469],
  'IMG_8878.jpg': [42.0260, 128.0671],
  'IMG_1786_2.jpg': [50.3489, 120.4233],
  'IMG_7272.jpg': [24.4102, 107.0276],
};
for (const f of Object.keys(REAL)) {
  const p = path.join(DEMO5, f);
  if (!fs.existsSync(p)) { ok('示例图存在 ' + f, false); continue; }
  const g = parseExifGps(fs.readFileSync(p).buffer.slice(0));
  const [lat, lon] = REAL[f];
  ok('真实照片 ' + f + ' 读出 GPS', !!g, g ? g.lat + ',' + g.lon : 'null');
  if (g) {
    ok('  ' + f + ' 纬度正确', near(g.lat, lat, 0.01), g.lat + ' vs ' + lat);
    ok('  ' + f + ' 经度正确', near(g.lon, lon, 0.01), g.lon + ' vs ' + lon);
  }
}

// ---- 2. 合成 case：9 个已知坐标 ----
const cases = fs.existsSync(EXIFCASES)
  ? fs.readdirSync(EXIFCASES).filter((f) => /\.jpg$/i.test(f)).sort()
  : [];
if (!cases.length) {
  console.log('（跳过合成 case：先跑 node test/gen-exif-cases.mjs 再跑本脚本）');
} else {
  const expect = JSON.parse(fs.existsSync(path.join(EXIFCASES, 'expected.json'))
    ? fs.readFileSync(path.join(EXIFCASES, 'expected.json'), 'utf8') : '[]');
  for (const f of cases) {
    const buf = fs.readFileSync(path.join(EXIFCASES, f));
    const g = parseExifGps(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const e = expect.find((x) => x.name === f.replace(/\.jpg$/, ''));
    if (!e) { ok(f + ' 有期望值', false); continue; }
    ok(f + ' 解析成功', !!g);
    if (g) {
      ok('  ' + f + ' 经纬度与期望一致',
        near(g.lat, e.lat, 0.002) && near(g.lon, e.lon, 0.002),
        g.lat.toFixed(4) + ',' + g.lon.toFixed(4) + ' vs ' + e.lat + ',' + e.lon);
    }
  }
}

console.log(bad ? '\nFAILED ' + bad + ' 项' : '\nALL PASS');
process.exit(bad ? 1 : 0);
