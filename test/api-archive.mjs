/**
 * 「清空即归档」（using / history 两个分区）的端到端验收 —— 打真实 Pages Function + KV
 *
 *   node test/api-archive.mjs                         # 默认打本地 wrangler pages dev
 *   BASE=https://wall.orange0323.dpdns.org node test/api-archive.mjs
 *
 * 为什么要有这个脚本：R18 要的语义不是「删掉」，而是「搬到历史里、识别码不变」。
 * 这种事只有真跑一遍 KV 才看得见 —— 清单里少了哪些 key、历史里多了哪些 key、
 * 同步码还有没有效，本地 mock 一律证明不了。
 *
 * 本地跑法（两行，先后台起服务再打）：
 *   npx wrangler pages dev dist --port 8792 --ip 127.0.0.1
 *   node test/api-archive.mjs
 */
const BASE = (process.env.BASE || process.argv[2] || 'http://127.0.0.1:8792').replace(/\/+$/, '');
const API = BASE + '/api/wall';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); }
};

// 一张最小但合法的 JPEG（1x1 灰）：验「字节原样搬进历史」，不关心画面
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
const KEY = hex();                        // 主角：这面墙会被清空两次
const KEY2 = hex();                       // 邻居：整个过程一个字都不该变
const H = (k) => ({ 'x-wall-key': k });

const jget = (path, k) => fetch(API + path, { headers: H(k) });
const jpost = (path, body, k) =>
  fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json', ...H(k) }, body: JSON.stringify(body) });
const jdel = (path, k) => fetch(API + path, { method: 'DELETE', headers: H(k) });

const photo = (id, city) => ({
  id, name: city + '.jpg', bytes: TINY.length, w: 1, h: 1,
  lon: 116.4074, lat: 39.9042, city, cc: '中国',
  pos: { fx: 0.31, fy: 0.62 }, ts: 1, t: 'image/jpeg',
});

async function putPhoto(k, id, city) {
  const r = await fetch(API + '/blob?id=' + id + '&n=' + encodeURIComponent(city + '.jpg'), {
    method: 'PUT', headers: { ...H(k), 'content-type': 'image/jpeg' }, body: TINY,
  });
  return r.json();
}

const lsLocal = Date.now();   // 每条记录打印时间太吵，只用来对齐日志顺序
console.log('目标：' + API + '（key=' + KEY.slice(0, 8) + '… / 邻居=' + KEY2.slice(0, 8) + '…）\n');

// 1) 探活
let r = await fetch(API + '/ping');
let o = await r.json();
ok('探活 /ping 通', r.status === 200 && o.ok === true);

// 2) 空墙清空：不许凭空造一个空历史
r = await jdel('/index', KEY); o = await r.json();
ok('空墙清空 → archived:null（不建空历史）', r.status === 200 && o.ok === true && o.archived === null,
  JSON.stringify(o));
r = await jget('/history', KEY); o = await r.json();
ok('空墙清空后历史仍是空的', r.status === 200 && Array.isArray(o.items) && o.items.length === 0);

// 3) 传 2 张 → 写清单 → 拿到同步码
for (const [id, city] of [['p_arch0001', '北京'], ['p_arch0002', '上海']]) {
  o = await putPhoto(KEY, id, city);
  ok('上传 ' + city, o.ok === true && o.bytes === TINY.length);
}
r = await jpost('/index', { photos: [photo('p_arch0001', '北京'), photo('p_arch0002', '上海')] }, KEY);
o = await r.json();
const code1 = o.code;
ok('写清单返回同步码', r.status === 200 && o.count === 2 && /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code1 || ''), code1);

// 邻居墙：建立并记住它此刻的样子（后面验隔离）
await putPhoto(KEY2, 'p_arch9999', '广州');
await jpost('/index', { photos: [photo('p_arch9999', '广州')] }, KEY2);
let nb = await (await jget('/index', KEY2)).json();
ok('邻居墙先有 1 张', nb.exists === true && nb.photos.length === 1);

// 4) 第一次清空 = 归档到 01
r = await jdel('/index', KEY); o = await r.json();
ok('第一次清空 → archived:01 / removed:2 / archivedPhotos:2',
  r.status === 200 && o.ok === true && o.archived === '01' && o.removed === 2 && o.archivedPhotos === 2,
  JSON.stringify(o));

r = await jget('/index', KEY); o = await r.json();
ok('清空后清单变空', r.status === 200 && Array.isArray(o.photos) && o.photos.length === 0,
  'exists=' + o.exists + ' photos=' + o.photos.length);

r = await jget('/history', KEY); o = await r.json();
const h1 = o.items || [];
ok('历史里有第 01 批、2 张', h1.length === 1 && h1[0].n === '01' && h1[0].photos === 2,
  JSON.stringify(h1));
ok('第 01 批的图片字节真的复制过去了（blobs=2）', h1[0] && h1[0].blobs === 2, 'blobs=' + (h1[0] || {}).blobs);
ok('历史条目带归档时间', !!(h1[0] && h1[0].updated && !isNaN(new Date(h1[0].updated).getTime())),
  (h1[0] || {}).updated);

// 5) 同步码：清空前后一个字都没变
// 注意：POST /index 与 /pair、/whoami 返回带连字符的码（XXXX-XXXX-XXXX），
// 而 GET /index 历史上返回的是不带连字符的 12 位原文 —— 比较时统一去连字符。
const norm = (s) => String(s || '').replace(/[^A-Z0-9]/g, '');
r = await jget('/index', KEY); o = await r.json();
const codeAfter1 = o.code;
ok('清空后同步码不变', !!codeAfter1 && norm(codeAfter1) === norm(code1), code1 + ' → ' + codeAfter1);
r = await jpost('/pair', { code: code1.replace(/-/g, '') }); o = await r.json();
ok('用同一个同步码仍能换回同一把 key', r.status === 200 && o.key === KEY, String(o.key).slice(0, 8) + '…');
ok('pair 报的照片数 = 0（墙是空的）', o.photos === 0, 'photos=' + o.photos);

// 6) 再传 1 张 → 第二次清空落 02
o = await putPhoto(KEY, 'p_arch0003', '广州');
ok('清空后再传一张', o.ok === true);
r = await jpost('/index', { photos: [photo('p_arch0003', '广州')] }, KEY); o = await r.json();
ok('清空后写清单仍返回同一个码', o.code === code1, o.code + ' / 原 ' + code1);

r = await jdel('/index', KEY); o = await r.json();
ok('第二次清空 → archived:02 / removed:1', r.status === 200 && o.archived === '02' && o.removed === 1,
  JSON.stringify(o));

r = await jget('/history', KEY); o = await r.json();
const h2 = o.items || [];
ok('历史按 01、02 升序排列', h2.length === 2 && h2[0].n === '01' && h2[1].n === '02',
  JSON.stringify(h2.map((x) => x.n)));
ok('第 01 批还是 2 张、第 02 批 1 张', h2[0] && h2[0].photos === 2 && h2[1] && h2[1].photos === 1,
  JSON.stringify(h2.map((x) => x.photos)));

// 7) 历史列表不许带图片字节（一份 base64 能把响应撑到几十 MB）
const histText = await (await jget('/history', KEY)).text();
ok('历史接口不返回图片字节', !/[A-Za-z0-9+/]{200,}/.test(histText) && histText.length < 4000,
  histText.length + ' B');
ok('历史接口不夹带 photos 的完整字段（位置/经纬度留在快照里，不出现在列表里）',
  !histText.includes('"pos"') && !histText.includes('"lon"'));

// 8) 隔离：邻居墙整个过程没被动过
nb = await (await jget('/index', KEY2)).json();
ok('邻居墙仍有 1 张（清空没波及）', nb.exists === true && nb.photos.length === 1);
r = await fetch(API + '/blob?id=p_arch9999', { headers: H(KEY2) });
ok('邻居墙的原图还在', r.status === 200);
let nh = await (await jget('/history', KEY2)).json();
ok('邻居墙没有历史批次', (nh.items || []).length === 0);
r = await fetch(API + '/blob?id=p_arch9999', { headers: H(KEY) });
ok('主角 key 取不到邻居的图', r.status === 404);

// 9) 参数校验
r = await jdel('/history?n=1', KEY);
ok('历史批号不是两位 → 400', r.status === 400);
r = await jdel('/history?n=ab', KEY);
ok('历史批号非数字 → 400', r.status === 400);
r = await jdel('/history?n=77', KEY);
ok('删不存在的批次 → 404', r.status === 404);
r = await jdel('/index?purge=0', KEY); o = await r.json();
ok('purge=0 走归档语义（空墙 → archived:null）', r.status === 200 && o.archived === null, JSON.stringify(o));

// 10) 删某一批历史
r = await jdel('/history?n=01', KEY); o = await r.json();
ok('删掉第 01 批', r.status === 200 && o.ok === true && o.n === '01' && o.removed === 2, JSON.stringify(o));
r = await jget('/history', KEY); o = await r.json();
ok('只剩第 02 批', o.items.length === 1 && o.items[0].n === '02' && o.items[0].photos === 1,
  JSON.stringify(o.items));

// 11) 彻底删除：连历史 + 同步码一起清
r = await jdel('/index?purge=1', KEY); o = await r.json();
ok('彻底删除成功', r.status === 200 && o.ok === true && o.purged === true, JSON.stringify(o));
ok('彻底删除把最后一历史批也清掉了', o.archivedBatches === 1, 'archivedBatches=' + o.archivedBatches);

r = await jget('/history', KEY); o = await r.json();
ok('彻底删除后历史为空', r.status === 200 && o.items.length === 0);
r = await jget('/index', KEY); o = await r.json();
ok('彻底删除后清单不存在', r.status === 200 && o.exists === false && o.photos.length === 0);
r = await jpost('/pair', { code: code1.replace(/-/g, '') });
ok('彻底删除后同步码失效（隐私出口有效）', r.status === 404);
r = await fetch(API + '/blob?id=p_arch0001', { headers: H(KEY) });
ok('彻底删除后原图取不到', r.status === 404);

// 12) 邻居墙收尾：确认它自始至终能用
nb = await (await jget('/index', KEY2)).json();
ok('邻居墙依旧完好（全程隔离）', nb.exists === true && nb.photos.length === 1);
await jdel('/index?purge=1', KEY2);

console.log(`\n结果：${pass}/${pass + fail} 通过` + (fail ? `，${fail} 条失败` : '  ALL PASS')
  + `（耗时 ${Date.now() - lsLocal} ms）`);
process.exit(fail ? 1 : 0);
