// 用合成 EXIF 验证 parseExifGps + locateLabel：构造标准 APP1/TIFF，塞已知经纬度
import fs from 'node:fs';
import path from 'node:path';
import { EXIFCASES } from './_env.mjs';

const expected = [
  ['哈尔滨', 126.535, 45.803], ['上海', 121.474, 31.230], ['三亚', 109.508, 18.247],
  ['拉萨', 91.140, 29.645], ['成都', 104.066, 30.572], ['北京', 116.407, 39.904],
  ['乌鲁木齐', 87.617, 43.793], ['厦门', 118.089, 24.480], ['那曲（藏北野点）', 92.06, 31.48]
];

// 一张 24×24 的合法 JPEG（644 B），作为载体。
// 只拼 APP1 而不带真实图像数据的话，文件在浏览器里解不出来，
// 上传会被当成坏图丢掉 —— 之前就因此测出「9 张一张都没进去」。
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAYABgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwB1FFFesecFFFFABRRRQAUUUUAf/9k=',
  'base64'
);

function degreesToRational(degFloat) {
  const abs = Math.abs(degFloat);
  const d = Math.floor(abs);
  const mFull = (abs - d) * 60;
  const m = Math.floor(mFull);
  const s = Math.round((mFull - m) * 60 * 1000);
  return [[d, 1], [m, 1], [s, 1000]];
}

function buildExifJpeg(lat, lon) {
  const parts = [];
  parts.push(Buffer.from([0xFF, 0xD8]));
  // TIFF body
  const body = Buffer.alloc(128);
  let p = 0;
  body.write('II', 0, 'ascii'); p = 2;
  body.writeUInt16LE(0x2A, p); p += 2;
  body.writeUInt32LE(8, p); p += 4;            // IFD0 offset
  body.writeUInt16LE(1, p); p += 2;            // IFD0 entry count
  body.writeUInt16LE(0x8825, p); p += 2;       // GPSInfo
  body.writeUInt16LE(4, p); p += 2;            // LONG
  body.writeUInt32LE(1, p); p += 4;
  body.writeUInt32LE(26, p); p += 4;           // → GPS IFD at 26
  body.writeUInt32LE(0, p); p += 4;            // next IFD
  // GPS IFD @26
  p = 26;
  body.writeUInt16LE(4, p); p += 2;
  body.writeUInt16LE(1, p); p += 2; body.writeUInt16LE(2, p); p += 2;   // LatRef ASCII
  body.writeUInt32LE(2, p); p += 4; body.write(lat >= 0 ? 'N\0' : 'S\0', p, 'ascii'); p += 2; body.writeUInt16LE(0, p); p += 2;
  body.writeUInt16LE(2, p); p += 2; body.writeUInt16LE(5, p); p += 2;   // Latitude RATIONAL x3
  body.writeUInt32LE(3, p); p += 4; body.writeUInt32LE(80, p); p += 4;
  body.writeUInt16LE(3, p); p += 2; body.writeUInt16LE(2, p); p += 2;   // LonRef ASCII
  body.writeUInt32LE(2, p); p += 4; body.write(lon >= 0 ? 'E\0' : 'W\0', p, 'ascii'); p += 2; body.writeUInt16LE(0, p); p += 2;
  body.writeUInt16LE(4, p); p += 2; body.writeUInt16LE(5, p); p += 2;   // Longitude RATIONAL x3
  body.writeUInt32LE(3, p); p += 4; body.writeUInt32LE(104, p); p += 4;
  body.writeUInt32LE(0, p); p += 4;            // next IFD = 0
  // rationals @80 / @104
  const lr = degreesToRational(lat), nr = degreesToRational(lon);
  [80, 104].forEach((base, idx) => {
    const arr = idx === 0 ? lr : nr;
    arr.forEach((r, i) => { body.writeUInt32LE(r[0], base + i * 8); body.writeUInt32LE(r[1], base + i * 8 + 4); });
  });
  const app1 = Buffer.concat([Buffer.from([0xFF, 0xE1]), Buffer.alloc(2),
                              Buffer.from('Exif\0\0', 'ascii'), body]);
  app1.writeUInt16BE(app1.length - 2, 2);
  parts.push(app1);
  parts.push(TINY_JPEG.subarray(2));           // 载体：去掉它自己的 SOI，接在本脚本的 SOI 之后
  return Buffer.concat(parts);
}

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
