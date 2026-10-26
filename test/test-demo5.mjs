// 用页面里的 parseExifGps 直接跑 5 张真实示例图，确认能读出 GPS
import fs from 'node:fs';
import { PAGE_FILE, PAGE_URL, SHOTS_DIR, IMGS15, EXIFCASES, DEMO5, chromePath, userDataDir } from './_env.mjs';
const src = fs.readFileSync(PAGE_FILE, 'utf8');
const start = src.indexOf('function exifTypeSize(t)');
const end = src.indexOf('/* GPS → 地点标签');
if (start < 0 || end < 0) throw new Error('slice fail ' + start + ' ' + end);
const code = src.slice(start, end);
const D2R = Math.PI / 180;
const fn = new Function('D2R', code + '\nreturn {parseExifGps};')(D2R);
const dir = DEMO5;
for (const f of fs.readdirSync(dir).filter(x => /\.jpg$/i.test(x)).sort()) {
  const b = fs.readFileSync(dir + '/' + f);
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  const g = fn.parseExifGps(ab);
  console.log(`${f.padEnd(16)} ${g ? `lon=${g.lon.toFixed(3)} lat=${g.lat.toFixed(3)}` : 'null'}`);
}
