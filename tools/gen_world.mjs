// 生成 data/world.js —— 世界国界（Natural Earth 110m 简化）
//
//   node tools/gen_world.mjs            用缓存（data/world_raw.geojson），没有就下载
//   node tools/gen_world.mjs --refetch  强制重新下载
//
// 输出：const WORLD=[{n:"中文国名",r:标签半径,l:[lon,lat] 标签点,p:[[[lon,lat],...],...]},...]
//   p  = 每个国家若干个外环（洞丢掉：110m 尺度下洞里套的国家靠坐标判断也够用）
//   r  = 外接框短边的一半（度），用来决定「这个国家的名字画得下吗」
//   l  = Natural Earth 给的标注点（LABEL_X/LABEL_Y），没有就用外接框中心
import fs from 'node:fs';
import { SHORT, CONT_CN } from './geo_names.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = (...p) => path.join(ROOT, ...p);

// Natural Earth 的 CONTINENT 是英文，翻成中文：大洲级取景要用
const SRC = 'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/ne_110m_admin_0_countries.geojson';
const CACHE = R('data', 'world_raw.geojson');
const OUT = R('data', 'world.js');

// —— 取原始数据（带缓存；github raw 直连不通，走 jsDelivr） ——
async function loadRaw() {
  const refetch = process.argv.includes('--refetch');
  if (!refetch && fs.existsSync(CACHE)) {
    console.log('cache hit:', path.relative(ROOT, CACHE), fs.statSync(CACHE).size, 'B');
    return JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  }
  console.log('downloading', SRC);
  const res = await fetch(SRC);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const txt = await res.text();
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, txt, 'utf8');
  console.log('saved', path.relative(ROOT, CACHE), Buffer.byteLength(txt), 'B');
  return JSON.parse(txt);
}

// —— Douglas-Peucker ——
function dp(pts, tol) {
  if (pts.length < 4) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  const tol2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const ax = pts[a][0], ay = pts[a][1], bx = pts[b][0], by = pts[b][1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let best = -1, bi = -1;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i][0], py = pts[i][1];
      let d2;
      if (len2 === 0) {
        d2 = (px - ax) * (px - ax) + (py - ay) * (py - ay);
      } else {
        let t = ((px - ax) * dx + (py - ay) * dy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = ax + t * dx, qy = ay + t * dy;
        d2 = (px - qx) * (px - qx) + (py - qy) * (py - qy);
      }
      if (d2 > best) { best = d2; bi = i; }
    }
    if (best > tol2) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

function ringArea(r) {
  let s = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    s += (r[j][0] * r[i][1] - r[i][0] * r[j][1]);
  }
  return Math.abs(s) / 2;
}
function bboxOf(rings) {
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const ring of rings) for (const p of ring) {
    if (p[0] < u0) u0 = p[0]; if (p[0] > u1) u1 = p[0];
    if (p[1] < v0) v0 = p[1]; if (p[1] > v1) v1 = p[1];
  }
  return { u0, u1, v0, v1 };
}

const raw = await loadRaw();

// 南极洲：一整圈贴边的多边形，画出来会把地图拉扁，直接跳过
const SKIP = new Set(['Antarctica', '南极洲', 'Fr. S. Antarctic Lands', '法属南部领地']);

// Natural Earth 的中文名是「官方全称」，直接印在地图上太长，改成通称
const countries = [];
let rawPts = 0, outPts = 0;

for (const f of raw.features) {
  const pr = f.properties || {};
  const rawName = pr.NAME_ZH || pr.NAME || pr.ADMIN;
  if (!rawName || SKIP.has(rawName) || SKIP.has(pr.NAME)) continue;
  const name = SHORT[rawName] || rawName;

  const g = f.geometry;
  if (!g) continue;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  if (!polys.length) continue;

  // 每个多边形只取外环
  const rings = polys.map(p => p[0]).filter(r => r && r.length >= 4);
  if (!rings.length) continue;

  const bb = bboxOf(rings);
  const span = Math.max(bb.u1 - bb.u0, bb.v1 - bb.v0);
  const tol = Math.min(0.80, Math.max(0.04, span / 170));
  const minArea = Math.max(0.02, span * span / 40000);

  let kept = [];
  let biggest = null, bigArea = -1;
  for (const ring of rings) {
    rawPts += ring.length;
    const a = ringArea(ring);
    if (a > bigArea) { bigArea = a; biggest = ring; }
    if (a < minArea) continue;
    const s = dp(ring, tol);
    if (s.length >= 4) kept.push(s);
  }
  // 极小国家/岛：面积过滤后空了，就把最大的那个环用更细的容差留下来
  if (!kept.length && biggest) {
    const s = dp(biggest, Math.max(0.004, tol / 10));
    if (s.length >= 4) kept.push(s);
  }
  if (!kept.length) continue;

  const rounded = kept.map(ring => ring.map(p => [
    Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100,
  ]));
  for (const ring of rounded) outPts += ring.length;

  const b2 = bboxOf(rounded);
  // 标签字号按「主陆块」定：法国的外接框算上海外省会比德国还大，字号就会离谱
  const mainBB = bboxOf([rounded.reduce((a, r) => (ringArea(r) > ringArea(a) ? r : a))]);
  const lx = typeof pr.LABEL_X === 'number' ? pr.LABEL_X : (b2.u0 + b2.u1) / 2;
  const ly = typeof pr.LABEL_Y === 'number' ? pr.LABEL_Y : (b2.v0 + b2.v1) / 2;

  countries.push({
    n: name,
    k: CONT_CN[pr.CONTINENT] || '',

    r: Math.round(Math.min(mainBB.u1 - mainBB.u0, mainBB.v1 - mainBB.v0) / 2 * 100) / 100,
    l: [Math.round(lx * 100) / 100, Math.round(ly * 100) / 100],
    p: rounded,
  });
}

countries.sort((a, b) => b.r - a.r);

const body = 'const WORLD=' + JSON.stringify(countries) + ';\n';
fs.writeFileSync(OUT, body, 'utf8');

console.log('countries =', countries.length,
  '| points', rawPts, '→', outPts,
  '| bytes =', Buffer.byteLength(body),
  '| file =', path.relative(ROOT, OUT));
