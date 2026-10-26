// 给每个省算一个「标注点」：最大内切圆圆心（pole of inaccessibility）
// 输出写回 provinces.js，字段 label:[lon,lat] + r:内切半径(uv 度)
import fs from 'node:fs';
import { ROOT, PAGE_FILE, PAGE_URL, SHOTS_DIR, TEST_IMGS, IMGS15, EXIFCASES, PROV_FILE, chromePath, userDataDir } from '../test/_env.mjs';

const F = PROV_FILE;
const src = fs.readFileSync(F, 'utf8');
const json = src.slice(src.indexOf('['), src.lastIndexOf(']') + 1);
const PROVINCES = JSON.parse(json);

const D2R = Math.PI / 180;
const mercY = lat => -Math.log(Math.tan(Math.PI / 4 + lat * D2R / 2)) / D2R;
const invMercY = v => Math.atan(Math.sinh(-v * D2R)) / D2R;

function ringArea(r) {
  let a = 0;
  for (let i = 0, n = r.length; i < n; i++) {
    const p = r[i], q = r[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}
function inside(pt, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > pt[1]) !== (yj > pt[1]) &&
        pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}
function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L = dx * dx + dy * dy;
  let t = L > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = a[0] + dx * t, y = a[1] + dy * t;
  return Math.hypot(p[0] - x, p[1] - y);
}
function distToRing(p, ring) {
  let m = Infinity;
  for (let i = 0, n = ring.length; i < n; i++) {
    const d = segDist(p, ring[i], ring[(i + 1) % n]);
    if (d < m) m = d;
  }
  return m;
}

const out = [];
for (const prov of PROVINCES) {
  // 投影到 uv（墨卡托），在 uv 空间求内切圆
  const uvPolys = prov.polys.map(poly => poly.map(ring => ring.map(pt => [pt[0], mercY(pt[1])])));
  let best = null, bestA = -1;
  for (const poly of uvPolys) {
    const a = ringArea(poly[0]);
    if (a > bestA) { bestA = a; best = poly; }
  }
  const ring = best[0];
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of ring) {
    if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
  }
  const N = 46;
  let bp = null, bd = -1;
  for (let i = 1; i < N; i++) {
    for (let j = 1; j < N; j++) {
      const pt = [x0 + (x1 - x0) * i / N, y0 + (y1 - y0) * j / N];
      if (!inside(pt, ring)) continue;
      const d = distToRing(pt, ring);
      if (d > bd) { bd = d; bp = pt; }
    }
  }
  if (!bp) { out.push({ name: prov.name, polys: prov.polys }); continue; }
  out.push({
    name: prov.name,
    label: [+bp[0].toFixed(3), +invMercY(bp[1]).toFixed(3)],
    r: +bd.toFixed(3),
    polys: prov.polys
  });
}

fs.writeFileSync(F, 'const PROVINCES=' + JSON.stringify(out) + ';\n', 'utf8');
console.log('provinces', out.length, 'bytes', fs.statSync(F).size);
for (const p of out) console.log(p.name.padEnd(10), 'r=' + (p.r ?? '-'), 'label=' + JSON.stringify(p.label));
