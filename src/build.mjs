// 把内联地图数据 + 示例照片拼进模板，产出可双击打开的 index.html
//
//   node src/build.mjs            → 写到仓库根的 index.html
//   node src/build.mjs out.html   → 写到指定文件
//
// 模板里的五个占位符依次被替换：
//   //__CHINA_DATA__    ← data/china_coords.js
//   //__PROV_DATA__     ← data/provinces.js
//   //__WORLD_DATA__    ← data/world.js
//   "__FELT_URI__"      ← assets/felt-final.jpg（base64 data URI）
//   /*__DEMO_DATA__*/[] ← assets/demo5/*.jpg（base64 + 真实 GPS）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = (...p) => path.join(ROOT, ...p);

const tplPath = R('src', 'index.template.html');
const outPath = process.argv[2] ? path.resolve(process.argv[2]) : R('index.html');

const tpl = fs.readFileSync(tplPath, 'utf8');
const china = fs.readFileSync(R('data', 'china_coords.js'), 'utf8').trim();
const prov = fs.readFileSync(R('data', 'provinces.js'), 'utf8').trim();
const world = fs.readFileSync(R('data', 'world.js'), 'utf8').trim();
const felt = 'data:image/jpeg;base64,' + fs.readFileSync(R('assets', 'felt-final.jpg')).toString('base64');

// 示例照片：5 张真实照片（含真实 GPS），内嵌成 data URI
const DEMO_META = [
  ['IMG_7596_1.jpg', 345, 460, 81.0663, 44.6815],
  ['IMG_9010_2.jpg', 460, 345, 87.0469, 48.6334],
  ['IMG_8878.jpg', 460, 345, 128.0671, 42.0260],
  ['IMG_1786_2.jpg', 345, 460, 120.4233, 50.3489],
  ['IMG_7272.jpg', 345, 460, 107.0276, 24.4102],
];
const demo = DEMO_META.map(([name, w, h, lon, lat]) => ({
  uri: 'data:image/jpeg;base64,' + fs.readFileSync(R('assets', 'demo5', name)).toString('base64'),
  w, h, lon, lat,
}));

for (const [marker, label] of [
  ['//__CHINA_DATA__', 'china_coords'],
  ['//__PROV_DATA__', 'provinces'],
  ['//__WORLD_DATA__', 'world'],
  ['"__FELT_URI__"', 'felt'],
  ['/*__DEMO_DATA__*/[]', 'demo'],
]) {
  if (!tpl.includes(marker)) throw new Error(`模板里找不到占位符 ${marker}（${label}）`);
}
if (!/^const CHINA_POLYGONS=/.test(china)) throw new Error('data/china_coords.js 开头不对：' + china.slice(0, 40));
if (!/^const PROVINCES=/.test(prov)) throw new Error('data/provinces.js 开头不对：' + prov.slice(0, 40));
if (!/^const WORLD=/.test(world)) throw new Error('data/world.js 开头不对：' + world.slice(0, 40));

const out = tpl
  .replace('//__CHINA_DATA__', '/* 中国国界（阿里 DataV 简化，2413→1578 点，含海南/台湾/南海诸岛） */\n' + china)
  .replace('//__PROV_DATA__', '/* 省级行政区边界（DataV 100000_full 简化，35 个） */\n' + prov)
  .replace('//__WORLD_DATA__', '/* 世界国界（Natural Earth 110m 简化，175 国 7083 点；含中文国名与标注点） */\n' + world)
  .replace('"__FELT_URI__"', JSON.stringify(felt))
  .replace('/*__DEMO_DATA__*/[]', '/* 示例照片：5 张真实照片，内嵌 data URI + 真实 GPS */\n' + JSON.stringify(demo));

fs.writeFileSync(outPath, out, 'utf8');
console.log('wrote', path.relative(ROOT, outPath) || outPath,
  '| bytes =', Buffer.byteLength(out),
  '| demo photos =', demo.length,
  '| demo bytes =', demo.reduce((s, d) => s + d.uri.length, 0));
