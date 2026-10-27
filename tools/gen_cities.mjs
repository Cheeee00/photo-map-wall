/**
 * 生成 data/cities.js —— 世界城市点（供「全球」档给照片起名、以及城市级取景用）。
 *
 * 数据来源：Natural Earth ne_10m_populated_places（公有领域），已缓存在
 * data/cities_raw.geojson；国家中文名取 data/world_raw.geojson 的 NAME_ZH，
 * 并按 tools/geo_names.mjs 的 SHORT 表缩短（与地图上的国名保持一致，不能两处叫法不同）。
 *
 * 用法：node tools/gen_cities.mjs [--refetch]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHORT } from './geo_names.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'data', 'cities_raw.geojson');
const WORLD_RAW = path.join(ROOT, 'data', 'world_raw.geojson');
const OUT = path.join(ROOT, 'data', 'cities.js');

const SRC = [
  'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/ne_10m_populated_places.geojson',
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_populated_places.geojson',
];

// 阈值：人口 30 万以上的城市 + 所有首都。再小的地方对「照片钉在哪」没有区分意义，
// 但每个国家只保留前 30 个，避免中国/美国把体积吃光。
const MIN_POP = 300000;
const PER_COUNTRY = 30;

async function ensureRaw(refetch) {
  if (!refetch && fs.existsSync(RAW) && fs.statSync(RAW).size > 100000) {
    console.log('cache hit:', path.relative(ROOT, RAW), fs.statSync(RAW).size, 'B');
    return;
  }
  for (const u of SRC) {
    try {
      const r = await fetch(u, { headers: { 'user-agent': 'photo-map-wall-build' } });
      if (!r.ok) { console.log('miss', r.status, u); continue; }
      fs.writeFileSync(RAW, Buffer.from(await r.arrayBuffer()));
      console.log('downloaded', u);
      return;
    } catch (e) {
      console.log('err', u, e.message);
    }
  }
  throw new Error('城市数据下载失败：本地没有缓存，三个镜像都不通');
}

// 国家中文名：ISO_A2 有 -99 的坑（法国就是），所以 ADM0_A3 也要建一份
function countryNames() {
  const rows = JSON.parse(fs.readFileSync(WORLD_RAW, 'utf8')).features;
  const byA2 = new Map();
  const byA3 = new Map();
  for (const f of rows) {
    const p = f.properties || {};
    const zh = p.NAME_ZH || p.NAME;
    if (!zh) continue;
    const cn = SHORT[zh] || zh;
    if (p.ISO_A2 && p.ISO_A2 !== '-99') byA2.set(p.ISO_A2, cn);
    if (p.ADM0_A3 && p.ADM0_A3 !== '-99') byA3.set(p.ADM0_A3, cn);
  }
  return { byA2, byA3 };
}

await ensureRaw(process.argv.includes('--refetch'));

const { byA2, byA3 } = countryNames();
const feats = JSON.parse(fs.readFileSync(RAW, 'utf8')).features;

const pick = [];
let noCountry = 0;
for (const f of feats) {
  const p = f.properties || {};
  const pop = Math.round(p.POP_MAX || 0);
  const cap = p.ADM0CAP === 1;
  if (!cap && pop < MIN_POP) continue;
  const name = p.NAME_ZH || p.NAME;
  if (!name) continue;
  const cn = byA3.get(p.ADM0_A3) || byA2.get(p.ISO_A2) || '';
  if (!cn) { noCountry++; continue; }
  const lon = typeof p.LONGITUDE === 'number' ? p.LONGITUDE : null;
  const lat = typeof p.LATITUDE === 'number' ? p.LATITUDE : null;
  if (lon == null || lat == null) continue;
  pick.push({ n: name, c: cn, a: lon, o: lat, p: pop });
}

// 同一国家的同名城市（人民/都会区重复收录）只留人口最大的那个
const seen = new Map();
for (const c of pick) {
  const k = c.c + '|' + c.n;
  const old = seen.get(k);
  if (!old || c.p > old.p) seen.set(k, c);
}
const dedup = [...seen.values()];

// 每个国家最多 PER_COUNTRY 个
const perCountry = new Map();
dedup.sort((a, b) => b.p - a.p);
const out = [];
for (const c of dedup) {
  const n = perCountry.get(c.c) || 0;
  if (n >= PER_COUNTRY) continue;
  perCountry.set(c.c, n + 1);
  // 紧凑数组 [名, 国, 经, 纬]：页面里只用到这四项，键名是白付的体积。
  // dedup 已按人口降序，所以 out 天然也是人口序，不用再排。
  out.push([c.n, c.c, Math.round(c.a * 100) / 100, Math.round(c.o * 100) / 100]);
}

const body = 'const CITIES_W=' + JSON.stringify(out) + ';\n';
fs.writeFileSync(OUT, body, 'utf8');

console.log('cities =', out.length,
  '| countries =', perCountry.size,
  '| dropped(no country name) =', noCountry,
  '| bytes =', Buffer.byteLength(body),
  '| file =', path.relative(ROOT, OUT));
