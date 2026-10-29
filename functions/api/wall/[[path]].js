/**
 * 照片地图墙 · 云端「同一面墙」服务（Cloudflare Pages Function）
 *
 * 解决的问题：手机刷新、退出重进、换 Wi-Fi/流量之后，照片不能丢，
 * 而且要能回到**同一个人的同一面墙**里。
 *
 * 身份怎么定（关键设计，别改成用 IP）：
 *   - 不用 IP：手机在流量和 Wi-Fi 之间切换 IP 就变了；同一个基站下的多个人
 *     还共用一个出口 IP（CGNAT），用 IP 会把不同人混成一面墙。
 *   - 用客户端自己生成的 128 位随机 key（存在浏览器的 localStorage + cookie 里），
 *     放在 `x-wall-key` 请求头里。它跟着**设备**走，不跟着网络走，所以换网络不掉。
 *   - key 太长记不住，所以再发一个 12 位的「同步码」给人看（`XXXX-XXXX-XXXX`），
 *     换设备时输入同步码就能接回同一面墙。同步码由服务端随机生成并存映射，
 *     不是 key 的派生（派生短码会削弱强度）。
 *
 * 存储（KV 免费额度 1 GB / 每天 1000 写 / 10 万读，个人用足够）。
 *
 * KV 没有真文件夹，分区一律用 key 前缀模拟。用户要的是两个分区
 * （using / history，history 里按【识别码】_01、【识别码】_02 分批）：
 *
 *   【using】当前这面墙 —— 前端正在看的那一批
 *     idx:<key>         JSON 清单 {v, code, photos:[], updated}
 *     blb:<key>:<id>    图片字节（不转码，保留 EXIF；metadata 存 n 文件名 / t content-type）
 *     blx:<key>         using 下所有图片 id 的登记表（见下「最终一致」）
 *
 *   【history】历史批次 —— 「清空」不真删，整批搬到这儿
 *     arc:<key>:<NN>        那一批的清单快照 {v, n, key, code, archivedAt, updated, photos:[], ids:[]}
 *     abl:<key>:<NN>:<id>   那一批的图片字节（metadata 与 blb 相同）
 *     arx:<key>             批号登记表 {v, slots:[], next}
 *     NN = 两位零填充，01 起、上限 99；同一面墙反复清空就是 01 → 02 → 03 …
 *
 *   另：cod:<code> → key（同步码 → 墙）。
 *   它的寿命和 using / history 都无关：清空、归档、删某一批历史都不碰它，
 *   只有 `DELETE /index?purge=1`（彻底删）才清掉 —— 所以清空之后拿同一个同步码
 *   还能接回同一面墙（只是空的）。
 *
 *   还有一条容易踩：清空之后 `idx:<key>` **仍然存在**，只是 photos 变成 []，
 *   code 留在里面。不能整条删 —— 删了同步码就取不回来了，下次写清单会另发一个新码，
 *   用户手里那个码就再也接不回来。
 *
 * 老数据兼容：`blx:` / `arx:` 两张登记表是后加的，老数据里没有。凡是读登记表的地方
 * 都把 `list()` 的结果并进去（登记表为空 = 退化成老行为），所以线上的老墙照常读写，
 * 只是**登记表落地之前那一次归档可能漏账** —— 那一次只能靠 list 兜底，认了。
 *
 * 清单由**客户端整体写入**，服务端不维护计数器 —— 这样躲开了 KV
 * 「读-改-写」的竞态（两个请求同时改同一份清单会互相覆盖）。代价是同一个人
 * 在两台设备上同时编辑时是「后写覆盖」，对这个场景可以接受。
 */

const PREFIX = '/api/wall';
const MAX_BLOB = 8 * 1024 * 1024;      // 单张 8 MB
const MAX_INDEX = 256 * 1024;          // 清单 256 KB
const MAX_PHOTOS = 80;                 // 一面墙最多 80 张
const clamp01 = (v) => (typeof v === 'number' && v >= 0 ? (v > 1 ? 1 : v) : 0);
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 去掉 I L O 0 1 这些易混字符

// ---------------------------------------------------------------- 小工具

const j = (obj, code = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status: code,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      ...extra,
    },
  });

const bad = (code, err, more = {}) => j({ ok: false, err, ...more }, code);

const KEY_RE = /^[a-f0-9]{32}$/;
const ID_RE = /^[A-Za-z0-9_-]{4,48}$/;
const CODE_RE = /^[A-Z2-9]{12}$/;

function keyOf(request, url) {
  const h = request.headers.get('x-wall-key') || '';
  const k = (h || url.searchParams.get('k') || '').toLowerCase().trim();
  return KEY_RE.test(k) ? k : null;
}

function normCode(raw) {
  const c = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return CODE_RE.test(c) ? c : null;
}

function fmtCode(c) {
  return c.slice(0, 4) + '-' + c.slice(4, 8) + '-' + c.slice(8, 12);
}

/* 设备 cookie（HttpOnly，由服务端下发）。
   为什么不用 localStorage 就够了：Safari 的 ITP 会把「脚本可写的存储」
   （localStorage / document.cookie）在 7 天不访问后清掉，但**服务端 Set-Cookie 的
   HttpOnly cookie 不受这条规则约束**。所以再存一份服务端 cookie，
   手机放一周再回来时还能认出是同一台设备、同一个同步码。 */
const DEV_COOKIE = 'pmw_dev';
const DEV_AGE = 34560000;    // 400 天（Chrome 上限）

function cookieOf(request, name) {
  const raw = request.headers.get('cookie') || '';
  const m = raw.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : '';
}
function devCookie(key) {
  return DEV_COOKIE + '=' + key + '; Path=/; Max-Age=' + DEV_AGE
    + '; HttpOnly; SameSite=Lax; Secure';
}

function newCode() {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  let s = '';
  for (let i = 0; i < 12; i++) s += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
  return s;
}

/** 读 KV 清单；不存在返回 null */
async function readIndex(env, key) {
  const raw = await env.WALLS.get('idx:' + key, { type: 'json' });
  if (!raw || typeof raw !== 'object') return null;
  if (!Array.isArray(raw.photos)) raw.photos = [];
  return raw;
}

/** 给这面墙发（或取回）一个同步码 */
async function ensureCode(env, key, idx) {
  if (idx && idx.code) return idx.code;
  let code = newCode();
  // 撞码概率极低（32^12），但还是让一下
  for (let i = 0; i < 5; i++) {
    const taken = await env.WALLS.get('cod:' + code);
    if (!taken) break;
    code = newCode();
  }
  await env.WALLS.put('cod:' + code, key);
  return code;
}

// ------------------------------------------------------------ 历史批次工具

const ARC_MAX = 99;                  // 最多留 99 批（NN 两位零填充的上限）
const NN_RE = /^[0-9]{2}$/;          // 只认 '01'..'99'，不接受 '1' / '001'
/* 先转数字再比：直接拿字符串比会掉进 JS 的隐式转换陷阱 ——
   "01" < 10 是 true（"01" 被转成 1），于是 01 会被补成 001。
   2026-10-30 线上历史批次显示为 001/002 就是这么来的。 */
const pad2 = (v) => { const n = Number(v) || 0; return n < 10 ? '0' + n : String(n); };

/** 列出某个前缀下的所有 key 名（KV 单页最多 1000 条，这里自动翻页） */
async function listKeys(env, prefix) {
  const out = [];
  let cursor;
  do {
    const page = await env.WALLS.list({ prefix, cursor });
    for (const k of page.keys) out.push(k.name);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

/** 删掉某个前缀下的全部 key，返回删掉的条数 */
async function delPrefix(env, prefix) {
  const names = await listKeys(env, prefix);
  for (const n of names) await env.WALLS.delete(n);
  return names.length;
}

/* ⚠️ 这一段是 2026-10-30 线上事故的直接产物，改之前先读完这段注释。

   原先历史批次靠 `listKeys('arc:<key>:')` 现列。本地 miniflare 是强一致的，
   39 条契约 485 ms 全绿；一上真实 KV 就废 —— **`KV` 的 `list()` 是最终一致的**，
   刚 `put` 的 key 可能几十秒内都列不出来。后果链：
     `arcSlots()` 看不见刚归档的批次 → 第二次清空又算出 01，把上一批覆盖；
     `listKeys('blb:')` 看不见刚上传的字节 → 一张都没复制进历史，然后
     `delPrefix('blb:')` 也删不掉 → 「清空这面墙」变成真删，用户以为留着的照片没了。
   所以：**凡是「刚写完马上要读」的目录，一律不靠 list()，自己记账。**

   记账放在 `arx:<key>`（批次登记表）：{v, slots:["01","02"], next:3}。
   `listKeys` 只留作兜底（认领这份改动之前已经归档、登记表里还没有的老批次），
   取并集，两者都不会丢。 */

const ARX_MAX = ARC_MAX;

async function readArcIdx(env, key) {
  const raw = await env.WALLS.get('arx:' + key, { type: 'json' });
  const slots = raw && Array.isArray(raw.slots) ? raw.slots : [];
  const clean = [...new Set(slots.filter((n) => NN_RE.test(n)))].sort();
  const mx = clean.length ? Number(clean[clean.length - 1]) : 0;
  let next = Number(raw && raw.next) || 0;
  if (!(next > mx)) next = mx + 1;
  return { v: 1, slots: clean, next };
}

async function writeArcIdx(env, key, a) {
  await env.WALLS.put('arx:' + key, JSON.stringify({ v: 1, slots: a.slots, next: a.next }));
}

/** 这面墙已有的历史槽位号（升序两位字符串数组，如 ['01','02']） */
async function arcSlots(env, key) {
  const a = await readArcIdx(env, key);
  // 兜底：老数据（登记表落地之前归档的批次）只能靠 list 认，最终一致也够用
  const p = 'arc:' + key + ':';
  const seen = (await listKeys(env, p))
    .map((n) => n.slice(p.length))
    .filter((n) => NN_RE.test(n));
  return [...new Set(a.slots.concat(seen))].sort();
}

/* 图片字节目录也自己记账（`blx:<key>`），理由同上：刚 PUT 的图，list() 列不出来，
   归档时就会「以为没有字节可复制」，然后 delPrefix 也删不掉 —— 照片原地不动地丢了。
   list() 同样留作兜底，取并集。 */
async function readBlobIds(env, key) {
  const raw = await env.WALLS.get('blx:' + key, { type: 'json' });
  const ids = raw && Array.isArray(raw.ids) ? raw.ids : [];
  return [...new Set(ids.filter((s) => ID_RE.test(s)))];
}
async function writeBlobIds(env, key, ids) {
  const clean = [...new Set(ids.filter((s) => ID_RE.test(s)))];
  await env.WALLS.put('blx:' + key, JSON.stringify({ v: 1, ids: clean }));
}
/** 某一批历史里存着的图片 id。优先读归档记录里的 ids，读不到才退回 list()。 */
async function arcBlobIds(env, key, nn) {
  const rec = await env.WALLS.get('arc:' + key + ':' + nn, { type: 'json' });
  if (rec && Array.isArray(rec.ids)) return rec.ids.filter((s) => ID_RE.test(s));
  const p = 'abl:' + key + ':' + nn + ':';
  return (await listKeys(env, p)).map((n) => n.slice(p.length));
}

/** 当前这面墙所有图片字节的 KV key 名（登记表 ∪ list） */
async function blobNamesOf(env, key) {
  const idPrefix = 'blb:' + key + ':';
  const ids = await readBlobIds(env, key);
  const seen = (await listKeys(env, idPrefix)).map((n) => n.slice(idPrefix.length))
    .filter((n) => ID_RE.test(n));
  const all = [...new Set(ids.concat(seen))];
  return { idPrefix, names: all.map((id) => idPrefix + id), ids: all };
}
async function delBlobAll(env, key) {
  const { ids, names } = await blobNamesOf(env, key);
  for (const n of names) await env.WALLS.delete(n);
  await writeBlobIds(env, key, []);
  return ids.length;
}

// ---------------------------------------------------------------- 路由

export const onRequest = async (ctx) => {
  const { request, env } = ctx;
  const url = new URL(request.url);
  const seg = url.pathname.slice(PREFIX.length).replace(/^\/+|\/+$/g, '');
  const method = request.method;

  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
        'access-control-allow-headers': 'content-type,x-wall-key',
        'access-control-max-age': '86400',
      },
    });
  }

  if (!env.WALLS) return bad(500, 'NO_KV_BINDING');

  try {
    // ---- 探活：前端用它判断「这个站点有没有云端同步能力」
    if (seg === 'ping') return j({ ok: true, sync: true, limits: { maxBlob: MAX_BLOB, maxPhotos: MAX_PHOTOS } });

    // ---- 用同步码换回 key（换设备时用）
    if (seg === 'pair' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const code = normCode(body.code);
      if (!code) return bad(400, 'BAD_CODE_FORMAT');
      const key = await env.WALLS.get('cod:' + code);
      if (!key) return bad(404, 'NO_SUCH_CODE');
      const idx = await readIndex(env, key);
      return j({ ok: true, key, photos: idx ? idx.photos.length : 0 });
    }

    // ---- 我是谁：本机没有 key 时（清过站点数据 / 换了浏览器内核）问服务端要回设备 cookie
    if (seg === 'whoami' && method === 'GET') {
      const ck = cookieOf(request, DEV_COOKIE);
      if (!KEY_RE.test(ck)) return j({ ok: true, key: null });
      const idx = await readIndex(env, ck);
      return j({ ok: true, key: ck, photos: idx ? idx.photos.length : 0,
        code: idx && idx.code ? fmtCode(idx.code) : null });
    }

    const key = keyOf(request, url);
    if (!key) return bad(401, 'BAD_KEY');
    const idxKey = 'idx:' + key;

    // ---- 读清单
    if (seg === 'index' && method === 'GET') {
      const idx = await readIndex(env, key);
      if (!idx) return j({ ok: true, exists: false, photos: [], code: null });
      return j({ ok: true, exists: true, photos: idx.photos, code: idx.code || null, updated: idx.updated || null });
    }

    // ---- 写清单（客户端整体覆盖）
    if (seg === 'index' && method === 'POST') {
      const len = Number(request.headers.get('content-length') || 0);
      if (len > MAX_INDEX) return bad(413, 'INDEX_TOO_LARGE');
      const body = await request.json().catch(() => null);
      if (!body || !Array.isArray(body.photos)) return bad(400, 'BAD_INDEX');
      if (body.photos.length > MAX_PHOTOS) return bad(413, 'TOO_MANY_PHOTOS', { max: MAX_PHOTOS });

      const prev = await readIndex(env, key);
      const code = (prev && prev.code) || (await ensureCode(env, key, null));
      // 只留白名单字段，别把客户端的任意结构写进来
      const photos = body.photos.slice(0, MAX_PHOTOS).map((p) => ({
        id: String(p.id || '').slice(0, 48),
        name: String(p.name || '').slice(0, 120),
        bytes: Number(p.bytes) || 0,
        w: Number(p.w) || 0,
        h: Number(p.h) || 0,
        lon: Number(p.lon),
        lat: Number(p.lat),
        city: String(p.city || '').slice(0, 40),
        cc: String(p.cc || '').slice(0, 40),
        // 手动摆放位置（0–1 相对画布）：存相对值，换窗口大小也不会跑出画面
        pos: (p.pos && typeof p.pos.fx === 'number' && typeof p.pos.fy === 'number')
          ? { fx: clamp01(p.pos.fx), fy: clamp01(p.pos.fy) } : null,
        ts: Number(p.ts) || 0,
        t: String(p.t || 'image/jpeg').slice(0, 40),
      }));
      const rec = { v: 1, code, photos, updated: new Date().toISOString() };
      await env.WALLS.put(idxKey, JSON.stringify(rec));
      return j({ ok: true, code: fmtCode(code), count: photos.length },
        200, { 'set-cookie': devCookie(key) });
    }

    /* ---- 清空这面墙 = 归档 + 清空（识别码不变）
       用户要的语义：点「清空」之后眼前这面墙是空的，但照片不是真删 ——
       整批搬进历史第 NN 批，同一个同步码仍然接回这面墙。
       `?purge=1` 才是真删（连历史一起），这个隐私出口不能丢。 */
    if (seg === 'index' && method === 'DELETE') {
      const purge = url.searchParams.get('purge');
      const isPurge = purge === '1' || purge === 'true';

      // ---- 彻底删：using + 历史 + 同步码映射，全清
      if (isPurge) {
        const idx0 = await readIndex(env, key);
        const blobs = await delBlobAll(env, key);
        /* 删历史也不能走 list()：刚归档的批次在真实 KV 上要几十秒才列得出来，
           结果就是「彻底删除」报成功、历史里那批却还躺着（线上实测 archivedBatches=0）。
           批号从登记表 ∪ list 拿，字节从批次快照的 ids ∪ list 拿。 */
        const slots = await arcSlots(env, key);
        const arcs = slots.length;
        /* 批号从登记表 ∪ list 拿，字节对整个 `abl:` 前缀删（list 漏掉的也在这一片里）。 */
        const abl = await delPrefix(env, 'abl:' + key + ':');
        for (const nn of slots) await env.WALLS.delete('arc:' + key + ':' + nn);
        await env.WALLS.delete('arx:' + key);
        if (idx0 && idx0.code) await env.WALLS.delete('cod:' + idx0.code);
        await env.WALLS.delete(idxKey);
        return j({ ok: true, purged: true, removed: blobs, archivedBatches: arcs, archivedBlobs: abl });
      }

      const idx = await readIndex(env, key);
      const list = idx && Array.isArray(idx.photos) ? idx.photos : [];
      const { idPrefix, ids: blobIds } = await blobNamesOf(env, key);

      /* 本来就没有照片：不凭空造一个空的历史批次（否则用户会看到一串「0 张」的批次，
         纯噪音）。清单为空但还残留图片字节的，顺手清掉，也不归档 ——
         那些字节没有清单就没有地点/时间，归档了也复原不成一面墙。 */
      if (!list.length) {
        const removed0 = blobIds.length ? await delBlobAll(env, key) : 0;
        return j({ ok: true, archived: null, removed: removed0, archivedPhotos: 0 });
      }

      const arx = await readArcIdx(env, key);
      const slots = [...new Set(arx.slots.concat(await arcSlots(env, key)).filter((s) => NN_RE.test(s)))].sort();
      const next = Math.max(arx.next, slots.length ? Number(slots[slots.length - 1]) + 1 : 1);
      if (next > ARC_MAX) {
        /* 满了怎么办：返回 409 让用户先删一批，而不是静默循环覆盖最旧的。
           理由：这个功能的全部价值就是「清空不丢照片」；循环覆盖等于悄悄销毁
           用户以为还留着的东西，而且那是唯一没法撤回的操作。
           腾地方有两条明路 —— `DELETE /history?n=NN` 删某一批，
           或者 `DELETE /index?purge=1` 全删。 */
        return bad(409, 'ARCHIVE_FULL', { max: ARC_MAX, used: slots.length });
      }
      const nn = pad2(next);

      // 先把字节复制过去，全部复制完再删原件：中途失败宁可留下 using，也不要两头都没有。
      // 这里遍历的是**记账表里的 id**，不是 list() 的结果 —— 刚上传的图 list 列不出来。
      const copied = [];
      for (const id of blobIds) {
        const got = await env.WALLS.getWithMetadata(idPrefix + id, { type: 'arrayBuffer' });
        if (!got || !got.value) continue;
        await env.WALLS.put('abl:' + key + ':' + nn + ':' + id, got.value, { metadata: got.metadata || {} });
        copied.push(id);
      }

      await env.WALLS.put('arc:' + key + ':' + nn, JSON.stringify({
        v: 1, n: nn, key, code: (idx && idx.code) || null,
        archivedAt: new Date().toISOString(), updated: (idx && idx.updated) || null,
        photos: list,
        ids: copied,          // 记账：这一批到底复制了哪些图，别再靠 list() 猜
      }));
      arx.slots = [...new Set(arx.slots.concat([nn]))].sort();
      arx.next = Math.min(next + 1, ARX_MAX + 1);
      await writeArcIdx(env, key, arx);

      const removed = await delBlobAll(env, key);

      // using 下留一份空清单：code 在里面，删了同步码就变了
      if (idx && idx.code) {
        await env.WALLS.put(idxKey, JSON.stringify({
          v: 1, code: idx.code, photos: [], updated: new Date().toISOString(),
        }));
      } else {
        await env.WALLS.delete(idxKey);
      }

      return j({ ok: true, archived: nn, removed, archivedPhotos: list.length },
        200, { 'set-cookie': devCookie(key) });
    }

    /* ---- 历史批次列表。只回清单，绝不把图片字节读出来 —— 一批 80 张、
       全转成 base64 能把响应撑到几十 MB，而且前端一行也用不上。 */
    if (seg === 'history' && method === 'GET') {
      const slots = await arcSlots(env, key);
      const items = [];
      for (const s of slots) {
        const nn = pad2(s);
        const rec = await env.WALLS.get('arc:' + key + ':' + nn, { type: 'json' });
        const list = rec && Array.isArray(rec.photos) ? rec.photos : [];
        items.push({
          n: nn,
          photos: list.length,
          updated: (rec && (rec.updated || rec.archivedAt)) || null,
          blobs: (await arcBlobIds(env, key, nn)).length,
        });
      }
      return j({ ok: true, items });
    }

    /* ---- 删掉某一批历史（真删这一批，其余批次不动） */
    if (seg === 'history' && method === 'DELETE') {
      const n = url.searchParams.get('n') || '';
      if (!NN_RE.test(n) || Number(n) < 1) return bad(400, 'BAD_BATCH', { expect: '两位数字，如 01' });
      const had = await env.WALLS.get('arc:' + key + ':' + n);
      const removed = await delPrefix(env, 'abl:' + key + ':' + n + ':');
      await env.WALLS.delete('arc:' + key + ':' + n);
      const arx = await readArcIdx(env, key);
      arx.slots = arx.slots.filter((s) => s !== n);
      await writeArcIdx(env, key, arx);
      if (!had && !removed) {
        /* 记账里有、实际没数据（比如上次归档中途断了）也要从表里摘掉，
           否则这一批会永久占着一个槽位号，历史里又永远看不到它。 */
        return bad(404, 'NO_SUCH_BATCH', { n });
      }
      return j({ ok: true, n, removed });
    }

    // ---- 存一张原图
    if (seg === 'blob' && method === 'PUT') {
      const id = url.searchParams.get('id') || '';
      if (!ID_RE.test(id)) return bad(400, 'BAD_ID');
      const declared = Number(request.headers.get('content-length') || 0);
      if (declared > MAX_BLOB) return bad(413, 'TOO_LARGE', { maxBytes: MAX_BLOB, gotBytes: declared });
      const buf = await request.arrayBuffer();
      if (buf.byteLength > MAX_BLOB) return bad(413, 'TOO_LARGE', { maxBytes: MAX_BLOB, gotBytes: buf.byteLength });
      if (buf.byteLength < 12) return bad(415, 'NOT_AN_IMAGE');
      await env.WALLS.put('blb:' + key + ':' + id, buf, {
        metadata: {
          n: String(url.searchParams.get('n') || '').slice(0, 120),
          t: String(request.headers.get('content-type') || 'image/jpeg').slice(0, 40),
        },
      });
      const ids = await readBlobIds(env, key);
      if (!ids.includes(id)) { ids.push(id); await writeBlobIds(env, key, ids); }
      return j({ ok: true, id, bytes: buf.byteLength }, 200, { 'set-cookie': devCookie(key) });
    }

    // ---- 取原图（换设备恢复的关键：没有它就只能恢复「有照片但看不到」）
    if (seg === 'blob' && method === 'GET') {
      const id = url.searchParams.get('id') || '';
      if (!ID_RE.test(id)) return bad(400, 'BAD_ID');
      const got = await env.WALLS.getWithMetadata('blb:' + key + ':' + id, { type: 'arrayBuffer' });
      if (!got || !got.value) return bad(404, 'NO_BLOB');
      const t = (got.metadata && got.metadata.t) || 'image/jpeg';
      return new Response(got.value, {
        status: 200,
        headers: {
          'content-type': t,
          'cache-control': 'private, max-age=86400',
          'access-control-allow-origin': '*',
        },
      });
    }

    // ---- 删一张原图
    if (seg === 'blob' && method === 'DELETE') {
      const id = url.searchParams.get('id') || '';
      if (!ID_RE.test(id)) return bad(400, 'BAD_ID');
      await env.WALLS.delete('blb:' + key + ':' + id);
      const ids = (await readBlobIds(env, key)).filter((s) => s !== id);
      await writeBlobIds(env, key, ids);
      return j({ ok: true, id });
    }

    return bad(404, 'NOT_FOUND');
  } catch (e) {
    return bad(500, 'INTERNAL', { detail: String((e && e.message) || e).slice(0, 200) });
  }
};
