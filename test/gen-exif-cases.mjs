// 用合成 EXIF 验证 parseExifGps + locateLabel：构造标准 APP1/TIFF，塞已知经纬度
import fs from 'node:fs';
import path from 'node:path';
import { EXIFCASES } from './_env.mjs';
import { buildExifJpeg } from './_exif.mjs';

const expected = [
  ['哈尔滨', 126.535, 45.803], ['上海', 121.474, 31.230], ['三亚', 109.508, 18.247],
  ['拉萨', 91.140, 29.645], ['成都', 104.066, 30.572], ['北京', 116.407, 39.904],
  ['乌鲁木齐', 87.617, 43.793], ['厦门', 118.089, 24.480], ['那曲（藏北野点）', 92.06, 31.48]
];

const cases = expected.map(function (e) {
  const buf = buildExifJpeg(e[2], e[1]);   // buildExifJpeg(lat, lon)
  const u8 = new Uint8Array(buf);
  return { name: e[0], lon: e[1], lat: e[2], bytes: Array.from(u8) };
});

// 落盘到 test/_tmp/exifcases（cdp-exif2.mjs 与 test-parser.mjs 都读这里）
fs.rmSync(EXIFCASES, { recursive: true, force: true });
fs.mkdirSync(EXIFCASES, { recursive: true });
cases.forEach(function (c, i) {
  fs.writeFileSync(path.join(EXIFCASES, 'case' + String(i + 1).padStart(2, '0') + '-' + c.name + '.jpg'),
                   Buffer.from(c.bytes));
});
console.log('wrote ' + cases.length + ' EXIF cases to ' + EXIFCASES);
