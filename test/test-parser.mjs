// 直接在 node 里跑页面那份 parseExifGps，隔离「解析器」与「页面/生成脚本」
import fs from 'node:fs';
import { PAGE_FILE, PAGE_URL, SHOTS_DIR, IMGS15, EXIFCASES, DEMO5, chromePath, userDataDir } from './_env.mjs';
const src = fs.readFileSync(PAGE_FILE, 'utf8');
const start = src.indexOf('function exifTypeSize(t)');
const end = src.indexOf('/* GPS → 地点标签');
if (start < 0 || end < 0) throw new Error('找不到解析器片段 start=' + start + ' end=' + end);
const code = src.slice(start, end);
const D2R = Math.PI / 180;
const fn = new Function('D2R', code + '\nreturn {parseExifGps};')(D2R);

const dir = EXIFCASES;
const expect = [
  ['哈尔滨', 126.535, 45.803], ['上海', 121.474, 31.230], ['三亚', 109.508, 18.247],
  ['拉萨', 91.140, 29.645], ['成都', 104.066, 30.572], ['北京', 116.407, 39.904],
  ['乌鲁木齐', 87.617, 43.793], ['厦门', 118.089, 24.480], ['那曲', 92.06, 31.48]
];
const files = fs.readdirSync(dir).filter(f => f.endsWith('.jpg')).sort();
files.forEach((f, i) => {
  const b = fs.readFileSync(dir + '/' + f);
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  const g = fn.parseExifGps(ab);
  const e = expect[i];
  const got = g ? `${g.lon.toFixed(3)},${g.lat.toFixed(3)}` : 'null';
  const ok = g && Math.abs(g.lon - e[1]) < 0.01 && Math.abs(g.lat - e[2]) < 0.01;
  console.log(`${f.padEnd(12)} 期望 ${e[1]},${e[2]}  实得 ${got}  ${ok ? 'OK' : '✗'}`);
});
