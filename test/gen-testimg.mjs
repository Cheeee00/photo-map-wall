// 生成测试用 PNG（纯 Node，无依赖），覆盖各种长宽比
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ROOT, PAGE_FILE, PAGE_URL, SHOTS_DIR, TEST_IMGS, IMGS15, EXIFCASES, PROV_FILE, chromePath, userDataDir } from './_env.mjs';

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(td));
  return Buffer.concat([len, td, crc]);
}

function makePNG(w, h, hue) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const off = y * (1 + w * 3);
    raw[off] = 0;
    for (let x = 0; x < w; x++) {
      const p = off + 1 + x * 3;
      // 斜向渐变的彩色块，方便肉眼确认图片真的贴上了
      const k = ((x / w) * 0.7 + (y / h) * 0.3);
      raw[p] = Math.round(255 * Math.abs(Math.sin((k + hue) * Math.PI)));
      raw[p + 1] = Math.round(255 * Math.abs(Math.sin((k + hue + 0.33) * Math.PI)));
      raw[p + 2] = Math.round(255 * Math.abs(Math.sin((k + hue + 0.66) * Math.PI)));
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const dir = TEST_IMGS;
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

const specs = [
  ['01-landscape-3x2.png', 1200, 800],
  ['02-portrait-3x4.png', 900, 1200],
  ['03-square.png', 1000, 1000],
  ['04-wide-16x9.png', 1600, 900],
  ['05-tall-4x7.png', 800, 1400],
  ['06-portrait-3x4b.png', 1200, 1600],
  ['07-wide-2x1.png', 2000, 1000],
];
specs.forEach(([name, w, h], i) => {
  fs.writeFileSync(dir + '/' + name, makePNG(w, h, i / specs.length));
});
console.log('wrote', specs.length, 'images to', dir);

// 压测用的 15 张：把上面 7 张循环复制成 p01..p15（面积/朝向各异，用来验证环绕排布）
const dir15 = IMGS15;
fs.rmSync(dir15, { recursive: true, force: true });
fs.mkdirSync(dir15, { recursive: true });
const bufs = specs.map(([name]) => fs.readFileSync(dir + '/' + name));
for (let i = 0; i < 15; i++) {
  fs.writeFileSync(path.join(dir15, 'p' + String(i + 1).padStart(2, '0') + '.png'), bufs[i % bufs.length]);
}
console.log('wrote 15 stress images to', dir15);
