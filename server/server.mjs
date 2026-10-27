/**
 * 照片地图墙 · 后台备份服务
 *
 * 设计约定（与前端配合）：
 *   1) POST /api/batch           body=JSON  登记一个批次（谁、什么设备、几张） → 返回 batchId
 *   2) PUT  /api/photo?b=..&n=.. body=原始字节   存单张照片（原字节，不转码）
 *   3) POST /api/finish?b=..     body=JSON  收尾，写 meta.json + 追加 index.jsonl
 *
 * 特意不用 multipart：原生手写 multipart 解析容易出错，而分批裸字节上传既简单
 * 又能让前端逐张并发、逐张重试，还能天然支持大文件。
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------- 配置
const PORT = Number(process.env.PORT || 8788);
const ROOT = process.env.DATA_DIR || '/data';
const UPLOADS = path.join(ROOT, 'uploads');
const INDEX = path.join(ROOT, 'index.jsonl');
const TOKEN = process.env.BACKUP_TOKEN || '';
const MAX_FILE = Number(process.env.MAX_FILE_MB || 25) * 1024 * 1024;
const MAX_PER_BATCH = Number(process.env.MAX_PHOTOS_PER_BATCH || 30);
const MAX_BODY = Number(process.env.MAX_META_MB || 2) * 1024 * 1024;

if (!TOKEN) {
  console.error('[FATAL] BACKUP_TOKEN 未设置 —— 公网服务必须带共享口令');
  process.exit(1);
}

await fsp.mkdir(UPLOADS, { recursive: true });

// ---------------------------------------------------------------- 工具
const TOKEN_BUF = Buffer.from(TOKEN);
function tokenOk(given) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  if (a.length !== TOKEN_BUF.length) return false;
  return crypto.timingSafeEqual(a, TOKEN_BUF);
}

function json(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(s),
  });
  res.end(s);
}

/**
 * 读请求体，带上限。
 * 注意：超限**不能**立刻 destroy —— 那会让客户端收到 ECONNRESET 而不是 413，
 * 调用方无法区分「文件太大」和「网络断了」。这里只 reject，由上层写响应，
 * 响应发完后关闭连接。开销 `destroySocket=true` 表示这段连接不要再复用。
 */
async function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let killed = false;
    req.on('data', c => {
      if (killed) return;                     // 已判超限，丢弃后续字节
      size += c.length;
      if (size > limit) {
        killed = true;
        const e = new Error('PAYLOAD_TOO_LARGE');
        e.destroySocket = true;
        req.pause();                          // 停止读取，但不掐连接
        reject(e);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!killed) resolve(Buffer.concat(chunks)); });
    req.on('error', e => reject(e));
  });
}

/** 发完响应后按需关闭连接 */
function settle(req, res, close) {
  if (close) res.setHeader('Connection', 'close');
  res.on('finish', () => { if (close) { try { req.destroy(); } catch { } } });
}

/**
 * 文件名消毒 —— 这是这类服务最常见的漏洞来源，务必保守：
 * 去掉目录分隔符与控制字符，只保留一个白名单字符集，且拒绝以点开头（隐藏文件）。
 */
function sanitizeName(raw) {
  const base = path.basename(String(raw || '').replace(/\\/g, '/'));
  let s = base.replace(/[\u0000-\u001f\u007f]/g, '');
  s = s.replace(/[^A-Za-z0-9._()\-\u4e00-\u9fa5]/g, '_');
  s = s.replace(/^\.+/, '').replace(/\.+$/, '');
  s = s.slice(0, 120);
  if (!s) s = 'photo';
  if (!/\.[A-Za-z0-9]{2,5}$/.test(s)) s += '.bin';
  return s;
}

/** 用 magic bytes 判断真身，不信任客户端给的 content-type */
const MAGIC = [
  { ext: 'jpg', test: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff, mime: 'image/jpeg' },
  { ext: 'png', test: b => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), mime: 'image/png' },
  { ext: 'gif', test: b => b.subarray(0, 6).toString('latin1').startsWith('GIF8'), mime: 'image/gif' },
  { ext: 'webp', test: b => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP', mime: 'image/webp' },
  { ext: 'heic', test: b => b.subarray(4, 8).toString('latin1') === 'ftyp' && /heic|heix|hevc|heim|heis|mif1|msf1|avif/i.test(b.subarray(8, 12).toString('latin1')), mime: 'image/heic' },
  { ext: 'tiff', test: b => (b.subarray(0, 2).toString('latin1') === 'II' && b[2] === 0x2a) || (b.subarray(0, 2).toString('latin1') === 'MM' && b[3] === 0x2a), mime: 'image/tiff' },
];
function sniff(buf) {
  if (!buf || buf.length < 12) return { kind: 'unknown', mime: 'application/octet-stream' };
  for (const m of MAGIC) if (m.test(buf)) return { kind: m.ext, mime: m.mime };
  return { kind: 'unknown', mime: 'application/octet-stream' };
}

/** User-Agent → 上传设备（粗粒度够用了） */
function parseUA(ua) {
  const s = String(ua || '');
  const out = { raw: s.slice(0, 300), os: 'Unknown', device: 'Unknown', browser: 'Unknown' };
  if (/iPhone/i.test(s)) { out.device = 'iPhone'; out.os = 'iOS'; }
  else if (/iPad/i.test(s)) { out.device = 'iPad'; out.os = 'iPadOS'; }
  else if (/Android/i.test(s) && /Mobile/i.test(s)) { out.device = 'Android Phone'; out.os = 'Android'; }
  else if (/Android/i.test(s)) { out.device = 'Android Tablet'; out.os = 'Android'; }
  else if (/Macintosh/i.test(s)) { out.device = 'Mac'; out.os = 'macOS'; }
  else if (/Windows/i.test(s)) { out.device = 'PC'; out.os = 'Windows'; }
  else if (/Linux/i.test(s)) { out.device = 'Linux'; out.os = 'Linux'; }
  const osVer = s.match(/(?:iPhone OS|CPU OS|Android|Mac OS X|Windows NT) ([0-9_]+)/i);
  if (osVer) out.osVersion = osVer[1].replace(/_/g, '.');
  if (/(CriOS)\/(\d+)/i.test(s)) out.browser = 'Chrome iOS';
  else if (/Edg\//i.test(s)) out.browser = 'Edge';
  else if (/OPR\//i.test(s)) out.browser = 'Opera';
  else if (/Firefox\//i.test(s)) out.browser = 'Firefox';
  else if (/Version\/[\d.]+.*Safari/i.test(s)) out.browser = 'Safari';
  else if (/Chrome\//i.test(s)) out.browser = 'Chrome';
  const bv = s.match(/(?:CriOS|Edg|OPR|Firefox|Chrome|Version)\/([0-9]+)/i);
  if (bv) out.browserVersion = bv[1];
  return out;
}

/** Cloudflare 已经帮我们算好了来源国，直接读 header，不用第三方库 */
function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return String(cf).split(',')[0].trim();
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket.remoteAddress || '';
}

// ---------------------------------------------------------------- 批次状态（内存 + 落盘）
const batches = new Map();        // batchId -> { dir, meta, received }
const SWEEP_MS = 30 * 60 * 1000;  // 半小时内没收尾的孤儿批次，扫掉

async function appendIndex(rec) {
  await fsp.appendFile(INDEX, JSON.stringify(rec) + '\n', 'utf8');
}

async function writeMeta(dir, meta) {
  await fsp.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
}

setInterval(() => {
  const now = Date.now();
  for (const [id, b] of batches) {
    if (now - b.createdAt > SWEEP_MS) {
      batches.delete(id);
      console.warn(`[sweep] 孤儿批次未收尾，丢弃: ${id}`);
    }
  }
}, SWEEP_MS).unref();

// ---------------------------------------------------------------- HTTP
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // CORS：前端在 Pages 域名，服务在 API 域名，必须显式放行
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'Origin');
  }
  res.setHeader('access-control-allow-headers', 'content-type,x-backup-token');
  res.setHeader('access-control-allow-methods', 'GET,POST,PUT,OPTIONS');
  res.setHeader('access-control-max-age', '86400');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  try {
    if (url.pathname === '/api/health') {
      if (!tokenOk(req.headers['x-backup-token'])) return json(res, 401, { ok: false, err: 'unauthorized' });
      return json(res, 200, {
        ok: true, service: 'photo-wall-backup',
        batches: fs.existsSync(UPLOADS) ? (await fsp.readdir(UPLOADS)).length : 0,
        diskRoot: ROOT,
      });
    }

    if (!tokenOk(req.headers['x-backup-token'])) {
      return json(res, 401, { ok: false, err: 'unauthorized' });
    }

    // ---------- 1) 登记批次 ----------
    if (url.pathname === '/api/batch' && req.method === 'POST') {
      const body = await readBody(req, MAX_BODY);
      const m = JSON.parse(body.toString('utf8'));
      const photos = Array.isArray(m.photos) ? m.photos : [];
      if (photos.length > MAX_PER_BATCH) {
        return json(res, 413, { ok: false, err: 'TOO_MANY_PHOTOS', max: MAX_PER_BATCH });
      }
      const id = crypto.randomBytes(6).toString('hex');
      const day = new Date().toISOString().slice(0, 10);
      const dir = path.join(UPLOADS, `${day}-${id}`);
      await fsp.mkdir(dir, { recursive: true });
      const meta = {
        batchId: id,
        startedAt: new Date().toISOString(),
        client: {
          ip: clientIp(req),
          country: req.headers['cf-ipcountry'] ? String(req.headers['cf-ipcountry']) : null,
          userAgent: parseUA(req.headers['user-agent']),
          language: req.headers['accept-language'] ? String(req.headers['accept-language']).slice(0, 60) : null,
          screen: m.screen || null,
          timezone: m.timezone || null,
          pageUrl: m.pageUrl || null,
        },
        photos: photos.map(p => ({
          clientName: String(p.name || '').slice(0, 200),
          size: Number(p.size) || null,
          declaredType: p.type ? String(p.type).slice(0, 80) : null,
          exif: p.exif || null,
          storedAs: null, kind: null, bytes: null, sha256: null, status: 'pending',
        })),
        finishedAt: null,
      };
      batches.set(id, { dir, meta, createdAt: Date.now(), received: new Set() });
      console.log(`[batch] ${id} <- ${meta.client.ip} (${meta.client.userAgent.device}) ${photos.length} 张`);
      return json(res, 200, { ok: true, batchId: id, maxFileBytes: MAX_FILE });
    }

    // ---------- 2) 存单张照片 ----------
    if (url.pathname === '/api/photo' && req.method === 'PUT') {
      const id = url.searchParams.get('b') || '';
      const idx = Number(url.searchParams.get('i'));
      const b = batches.get(id);
      if (!b) return json(res, 404, { ok: false, err: 'NO_BATCH' });
      if (!Number.isInteger(idx) || idx < 0 || idx >= b.meta.photos.length) {
        return json(res, 400, { ok: false, err: 'BAD_INDEX' });
      }
      if (b.received.has(idx)) return json(res, 200, { ok: true, dedup: true });

      // Content-Length 提前判：省得把整个超大 body 传完才拦
      const declared = Number(req.headers['content-length'] || 0);
      if (declared > MAX_FILE) {
        return json(res, 413, { ok: false, err: 'TOO_LARGE', limitBytes: MAX_FILE, gotBytes: declared });
      }

      const buf = await readBody(req, MAX_FILE);
      const sn = sniff(buf);
      if (sn.kind === 'unknown') {
        return json(res, 415, { ok: false, err: 'NOT_AN_IMAGE', detected: 'unknown' });
      }
      const raw = b.meta.photos[idx].clientName || `photo${idx}`;
      const name = `${String(idx).padStart(2, '0')}-${sanitizeName(raw)}`;
      const dest = path.join(b.dir, name);
      if (!dest.startsWith(b.dir + path.sep)) return json(res, 400, { ok: false, err: 'BAD_PATH' });

      await fsp.writeFile(dest, buf);
      b.received.add(idx);
      const p = b.meta.photos[idx];
      p.storedAs = name;
      p.kind = sn.kind;
      p.mime = sn.mime;
      p.bytes = buf.length;
      p.sha256 = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32);
      p.status = 'stored';
      // 每存一张都落盘 meta，进程崩了也不会丢账本
      await writeMeta(b.dir, b.meta);
      return json(res, 200, { ok: true, storedAs: name, bytes: buf.length, kind: sn.kind });
    }

    // ---------- 3) 收尾 ----------
    if (url.pathname === '/api/finish' && req.method === 'POST') {
      const id = url.searchParams.get('b') || '';
      const b = batches.get(id);
      if (!b) return json(res, 404, { ok: false, err: 'NO_BATCH' });
      b.meta.finishedAt = new Date().toISOString();
      for (const p of b.meta.photos) if (p.status === 'pending') p.status = 'missing';
      await writeMeta(b.dir, b.meta);
      const ok = b.meta.photos.filter(p => p.status === 'stored').length;
      await appendIndex({ batchId: id, dir: path.relative(ROOT, b.dir), ok, total: b.meta.photos.length, who: b.meta.client });
      batches.delete(id);
      console.log(`[done ] ${id} ${ok}/${b.meta.photos.length} 张`);
      return json(res, 200, { ok: true, stored: ok, total: b.meta.photos.length });
    }

    // ---------- 4) 最近批次（给自己看的，方便核对） ----------
    if (url.pathname === '/api/recent' && req.method === 'GET') {
      const n = Math.min(Number(url.searchParams.get('n')) || 10, 50);
      const days = await fsp.readdir(UPLOADS);
      const dirs = days.filter(d => /^\d{4}-\d{2}-\d{2}-/.test(d)).sort().reverse().slice(0, n);
      const out = [];
      for (const d of dirs) {
        try {
          const m = JSON.parse(await fsp.readFile(path.join(UPLOADS, d, 'meta.json'), 'utf8'));
          out.push(m);
        } catch { /* 半截目录跳过 */ }
      }
      return json(res, 200, { ok: true, batches: out });
    }

    return json(res, 404, { ok: false, err: 'NOT_FOUND' });
  } catch (e) {
    const msg = String(e && e.message || e);
    if (msg === 'PAYLOAD_TOO_LARGE') {
      settle(req, res, true);
      return json(res, 413, { ok: false, err: 'TOO_LARGE', limitBytes: MAX_FILE });
    }
    console.error('[err]', req.method, url.pathname, msg);
    return json(res, 500, { ok: false, err: 'INTERNAL' });
  }
});

server.requestTimeout = 5 * 60 * 1000;
server.headersTimeout = 60 * 1000;
server.listen(PORT, '0.0.0.0', () => {
  // PORT=0 时由系统分配空闲端口；打印真实端口供测试/容器编排读取
  const actual = server.address().port;
  console.log(`[boot] photo-wall-backup 监听 ${actual}, 数据目录 ${ROOT}`);
  console.log(`[boot] PORT=${actual}`);
});

process.on('unhandledRejection', e => console.error('[unhandled]', e));
process.on('uncaughtException', e => console.error('[uncaught]', e));
