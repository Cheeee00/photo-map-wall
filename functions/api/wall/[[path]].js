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
 * 存储（KV 免费额度 1 GB / 每天 1000 写 / 10 万读，个人用足够）：
 *   idx:<key>        → JSON 清单 {v, code, photos:[], updated}
 *   blb:<key>:<id>   → 原图字节（不转码，保留 EXIF）
 *   cod:<code>       → key（同步码 → 墙）
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
      return j({ ok: true, code: fmtCode(code), count: photos.length });
    }

    // ---- 彻底删掉这面墙（清单 + 所有原图 + 同步码映射）
    if (seg === 'index' && method === 'DELETE') {
      const idx = await readIndex(env, key);
      let removed = 0;
      let cursor;
      do {
        const page = await env.WALLS.list({ prefix: 'blb:' + key + ':', cursor });
        for (const k of page.keys) {
          await env.WALLS.delete(k.name);
          removed++;
        }
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
      if (idx && idx.code) await env.WALLS.delete('cod:' + idx.code);
      await env.WALLS.delete(idxKey);
      return j({ ok: true, removed });
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
      return j({ ok: true, id, bytes: buf.byteLength });
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
      return j({ ok: true, id });
    }

    return bad(404, 'NOT_FOUND');
  } catch (e) {
    return bad(500, 'INTERNAL', { detail: String((e && e.message) || e).slice(0, 200) });
  }
};
