/**
 * 云端「同一面墙」接口的端到端验收（打真实部署，不 mock）
 *
 *   node test/api-cloud.mjs                       # 默认打自定义域
 *   node test/api-cloud.mjs https://xxx.pages.dev # 指定部署域
 *
 * 为什么要有这个脚本：Pages Function + KV 这种东西在本地是测不出来的
 * （本地 miniflare 的 KV 语义和线上有差别，绑定是否真的生效也只有线上能证明）。
 * 所以这里全程走 HTTPS，用一个临时随机 key 建墙、传图、读回、换设备、再删干净。
 */
const BASE = (process.argv[2] || 'https://wall.orange0323.dpdns.org').replace(/\/+$/, '');
const API = BASE + '/api/wall';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); }
};

// 一张最小但合法的 JPEG（1x1 灰），用于验证「魔数不管、字节原样存回」
const TINY = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05,
  0x08, 0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b,
  0x0b, 0x0c, 0x19, 0x12, 0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a,
  0x1c, 0x1c, 0x20, 0x24, 0x2e, 0x27, 0x20, 0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28,
  0x37, 0x29, 0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27, 0x39, 0x3d, 0x38,
  0x32, 0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
  0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x14, 0x00, 0x01, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x0a, 0xff, 0xc4, 0x00, 0x14, 0x10, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xda,
  0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x37, 0xff, 0xd9,
]);

const hex = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
const KEY = hex();
const KEY2 = hex();                       // 模拟另一台设备的墙，用来验证隔离
const H = (k) => ({ 'x-wall-key': k });

const jpost = (path, body, k) =>
  fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json', ...H(k) }, body: JSON.stringify(body) });
const jget = (path, k) => fetch(API + path, { headers: H(k) });

const PHOTOS = [
  { id: 'p_beijing01', name: '北京.jpg', bytes: TINY.length, w: 1, h: 1, lon: 116.4074, lat: 39.9042, city: '北京', ts: 1, t: 'image/jpeg' },
  { id: 'p_tokyo0002', name: '東京.jpg', bytes: TINY.length, w: 1, h: 1, lon: 139.6503, lat: 35.6762, city: '日本', ts: 2, t: 'image/jpeg' },
];

console.log('目标：' + API + '\n');

// 1) 探活
let r = await fetch(API + '/ping');
let o = await r.json();
ok('POST 探活 /ping 通', r.status === 200 && o.ok === true && o.sync === true);

// 2) 无 key / 错 key 一律 401（key 是唯一的凭证）
r = await fetch(API + '/index?k=deadbeef');
ok('不带 key 的请求被拒 401', r.status === 401);
r = await fetch(API + '/index', { headers: { 'x-wall-key': 'z'.repeat(32) } });
ok('格式非法 key 被拒 401', r.status === 401);

// 3) 空墙
r = await jget('/index', KEY); o = await r.json();
ok('新 key 读清单 = 空墙', r.status === 200 && o.exists === false && Array.isArray(o.photos) && o.photos.length === 0);

// 4) 传两张原图
for (const p of PHOTOS) {
  r = await fetch(API + '/blob?id=' + p.id + '&n=' + encodeURIComponent(p.name), {
    method: 'PUT', headers: { ...H(KEY), 'content-type': 'image/jpeg' }, body: TINY,
  });
  o = await r.json();
  ok('上传原图 ' + p.name, r.status === 200 && o.bytes === TINY.length);
}

// 5) 取回原图并逐字节比对 —— 换设备恢复全靠这一步，「存了但读不回」等于没存
r = await fetch(API + '/blob?id=p_beijing01', { headers: H(KEY) });
const back = new Uint8Array(await r.arrayBuffer());
ok('读回原图字节完全一致', r.status === 200 && back.length === TINY.length && back.every((v, i) => v === TINY[i]),
  `${back.length}B / content-type=${r.headers.get('content-type')}`);

// 6) 写清单并读回
r = await jpost('/index', { photos: PHOTOS }, KEY); o = await r.json();
const code = o.code;
ok('写清单返回同步码', r.status === 200 && o.count === 2 && /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code || ''), code);

r = await jget('/index', KEY); o = await r.json();
ok('读回清单 = 2 张，地点/经纬度没被改', r.status === 200 && o.exists === true && o.photos.length === 2
  && o.photos[0].city === '北京' && Math.abs(o.photos[1].lon - 139.6503) < 1e-6, JSON.stringify(o.photos.map((p) => p.city)));

// 7) 换设备：用同步码换回 key（这是「朋友退出重进 / 换手机」的核心路径）
r = await jpost('/pair', { code: code.replace(/-/g, '').toLowerCase() });
o = await r.json();
ok('用同步码换回同一把 key（大小写/横杠都能容错）', r.status === 200 && o.key === KEY, o.key);

// 8) 墙之间隔离：另一把 key 读不到这面墙的东西
r = await jget('/index', KEY2); o = await r.json();
ok('另一把 key 看到的是另一个空墙', o.exists === false);
r = await fetch(API + '/blob?id=p_beijing01', { headers: H(KEY2) });
ok('另一把 key 取不到别人的原图', r.status === 404);

// 9) 越界与非法输入
r = await jpost('/index', { photos: new Array(81).fill({ id: 'x', name: 'n' }) }, KEY);
ok('超过 80 张被拒 413', r.status === 413);
r = await jpost('/index', { photos: 'nope' }, KEY);
ok('清单结构非法被拒 400', r.status === 400);
r = await fetch(API + '/blob?id=' + 'a'.repeat(60), { method: 'PUT', headers: { ...H(KEY), 'content-type': 'image/jpeg' }, body: TINY });
ok('非法 id 被拒 400', r.status === 400);
r = await jpost('/pair', { code: 'ZZZZZZZZZZZZ' });
ok('不存在的同步码 404', r.status === 404);

// 10) 清理：删掉整面墙，连同步码映射也要清掉
r = await fetch(API + '/index', { method: 'DELETE', headers: H(KEY) }); o = await r.json();
ok('删除整面墙', r.status === 200 && o.ok === true && o.removed === 2, 'removed=' + o.removed);
r = await jget('/index', KEY); o = await r.json();
ok('删完后清单为空', o.exists === false);
r = await jpost('/pair', { code });
ok('删完后同步码失效', r.status === 404);
r = await fetch(API + '/blob?id=p_beijing01', { headers: H(KEY) });
ok('删完后原图取不到', r.status === 404);

console.log(`\n结果：${pass}/${pass + fail} 通过` + (fail ? `，${fail} 条失败` : '  ALL PASS'));
process.exit(fail ? 1 : 0);
