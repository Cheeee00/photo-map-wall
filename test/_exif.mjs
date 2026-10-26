// 合成带 GPS 的 JPEG（零依赖）：给测试脚本造「有定位的照片」
// 只拼 APP1 而不带真实图像数据的话，文件在浏览器里解不出来，
// 上传会被当成坏图丢掉 —— 所以必须附带一张真实的小 JPEG 当载体。

// 一张 24×24 的合法 JPEG（644 B），作为载体
export const TINY_JPEG = Buffer.from(
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

/** 拼一个带 GPS 的 APP1(Exif) 段。注意参数顺序是 (lat, lon)，别写反（写反过一次）。 */
export function buildApp1(lat, lon) {
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
  return app1;
}

/** 造一张带 GPS 的 JPEG（载体是上面的 24×24 小图）。 */
export function buildExifJpeg(lat, lon) {
  return Buffer.concat([Buffer.from([0xFF, 0xD8]), buildApp1(lat, lon), TINY_JPEG.subarray(2)]);
}

/**
 * 给一张**真实** JPEG 注入 GPS：在 SOI 之后插一个 APP1。
 * 用于「拿真照片 + 假坐标」造演示图（docs 截图、世界档 showcase）。
 * 原图必须自己以 FFD8 开头；已带 APP1 也没关系，解析器读第一个。
 */
export function injectGps(jpegBuf, lat, lon) {
  if (jpegBuf[0] !== 0xFF || jpegBuf[1] !== 0xD8) throw new Error('injectGps: 输入不是 JPEG');
  return Buffer.concat([Buffer.from([0xFF, 0xD8]), buildApp1(lat, lon), jpegBuf.subarray(2)]);
}
