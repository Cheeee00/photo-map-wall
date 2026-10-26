// 生成省级边界简化数据：拉 DataV 100000_full.json → Douglas-Peucker → PROVINCES 数组
// 第一次运行会把原始 GeoJSON 缓存到 data/china_boundary_full.json，
// 之后即使断网也能重建（删掉缓存即可重新联网获取）。
import fs from 'node:fs';
import { ROOT, PAGE_FILE, PAGE_URL, SHOTS_DIR, TEST_IMGS, IMGS15, EXIFCASES, PROV_FILE, chromePath, userDataDir } from '../test/_env.mjs';

const URL_FULL = 'https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json';
const TOL = 0.055;        // 简化容差（度）
const MIN_AREA = 0.02;    // 丢弃面积小于此值（平方度）的碎多边形
const MIN_PTS = 4;

const CACHE = ROOT + '/data/china_boundary_full.json';   // 100000_full.json 的本地缓存

let geo;
if (fs.existsSync(CACHE)) {
  geo = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  console.log('用缓存', CACHE);
} else {
  const res = await fetch(URL_FULL);
  if (!res.ok) throw new Error('fetch failed ' + res.status);
  geo = await res.json();
  fs.writeFileSync(CACHE, JSON.stringify(geo), 'utf8');
  console.log('已缓存原始数据到', CACHE);
}
if (!Array.isArray(geo.features) || geo.features.length < 30) {
  throw new Error('这份 GeoJSON 不是省级数据（features=' + (geo.features || []).length +
                  '）。100000_full.json 应有 35 个 feature；请删掉 ' + CACHE + ' 后重跑。');
}
console.log('features:', geo.features.length);

// Douglas-Peucker（迭代版，避免递归爆栈）
function perp(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy;
  if (L2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2;
  t = Math.max(0, Math.min(1, t));
  const px = a[0] + t * dx, py = a[1] + t * dy;
  return Math.hypot(p[0] - px, p[1] - py);
}

function simplify(pts, tol) {
  const n = pts.length;
  if (n <= 2) return pts.slice();
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop();
    let maxD = -1, idx = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const d = perp(pts[i], pts[i0], pts[i1]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol && idx > 0) {
      keep[idx] = 1;
      stack.push([i0, idx], [idx, i1]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

function ringArea(poly) {
  let s = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;
}

const r = (v) => Math.round(v * 1000) / 1000;   // 3 位小数 ≈ 100m，够用

const provinces = [];
for (const f of geo.features) {
  const name = f.properties.name;
  const g = f.geometry;
  if (!g) continue;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;

  // 兜底：面积过滤会把澳门这种极小行政区整个删掉，先把每个 feature 的最大环单独留一份
  let biggest = null, biggestArea = -1;
  for (const poly of polys) for (const ring of poly) {
    let rr = ring.slice();
    const first = rr[0], last = rr[rr.length - 1];
    if (first[0] === last[0] && first[1] === last[1] && rr.length > 2) rr = rr.slice(0, -1);
    if (rr.length < MIN_PTS) continue;
    const a = ringArea(rr);
    if (a > biggestArea) { biggestArea = a; biggest = rr; }
  }

  const outPolys = [];
  for (const poly of polys) {
    const rings = [];
    for (const ring of poly) {
      // 去掉重复闭合点
      let rr = ring.slice();
      const first = rr[0], last = rr[rr.length - 1];
      if (first[0] === last[0] && first[1] === last[1] && rr.length > 2) rr = rr.slice(0, -1);
      if (rr.length < MIN_PTS) continue;
      const area = ringArea(rr);
      if (area < MIN_AREA) continue;
      const s = simplify(rr, TOL);
      if (s.length < MIN_PTS) continue;
      rings.push(s.map((p) => [r(p[0]), r(p[1])]));
    }
    if (rings.length) outPolys.push(rings);
  }
  if (!outPolys.length && biggest) {
    // 极小行政区：用更细的容差，否则 DP 会把它整个塌成 2 个点
    const s = simplify(biggest, TOL / 12);
    if (s.length >= MIN_PTS) outPolys.push([s.map((p) => [r(p[0]), r(p[1])])]);
  }
  if (!outPolys.length) { console.warn('skip (empty):', name); continue; }
  provinces.push({ name, polys: outPolys });
}

let pts = 0;
for (const p of provinces) for (const poly of p.polys) for (const ring of poly) pts += ring.length;
console.log('provinces:', provinces.length, 'points:', pts);

// 紧凑输出：数字数组，无空格
function dump(v) {
  if (Array.isArray(v)) return '[' + v.map(dump).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).map((k) =>
      (typeof v[k] === 'string' ? JSON.stringify(k) + ':' + JSON.stringify(v[k]) : JSON.stringify(k) + ':' + dump(v[k]))
    ).join(',') + '}';
  }
  return String(v);
}

const body = 'const PROVINCES=' + dump(provinces) + ';\n';
fs.writeFileSync(PROV_FILE, body, 'utf8');
console.log('bytes:', Buffer.byteLength(body));
console.log('names:', provinces.map((p) => p.name).join(' '));
