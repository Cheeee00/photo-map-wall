// 用合成 EXIF 验证 parseExifGps + locateLabel：构造标准 APP1/TIFF，塞已知经纬度
//
//   node test/gen-exif-cases.mjs      → 写出 N 个 jpg + expected.json
//   node test/exif-node.mjs           → 不开浏览器，直接校验解析结果
//   node test/cdp-exif2.mjs           → 走真实上传链路校验
import fs from 'node:fs';
import path from 'node:path';
import { EXIFCASES } from './_env.mjs';
import { buildExifJpeg } from './_exif.mjs';

// [名字, 经度, 纬度] —— buildExifJpeg 的参数顺序是 (lat, lon)，别写反
const expected = [
  ['哈尔滨', 126.535, 45.803], ['上海', 121.474, 31.230], ['三亚', 109.508, 18.247],
  ['拉萨', 91.140, 29.645], ['成都', 104.066, 30.572], ['北京', 116.407, 39.904],
  ['乌鲁木齐', 87.617, 43.793], ['厦门', 118.089, 24.480], ['那曲（藏北野点）', 92.06, 31.48]
];

fs.rmSync(EXIFCASES, { recursive: true, force: true });
fs.mkdirSync(EXIFCASES, { recursive: true });

const meta = expected.map(function (e, i) {
  const buf = buildExifJpeg(e[2], e[1]);                 // (lat, lon)
  const name = 'case' + String(i + 1).padStart(2, '0') + '-' + e[0];
  fs.writeFileSync(path.join(EXIFCASES, name + '.jpg'), buf);
  return { name: name, lon: e[1], lat: e[2], city: e[0] };
});
fs.writeFileSync(path.join(EXIFCASES, 'expected.json'), JSON.stringify(meta, null, 1), 'utf8');
console.log('wrote ' + meta.length + ' EXIF cases to ' + EXIFCASES);
