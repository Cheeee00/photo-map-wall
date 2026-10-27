/**
 * 安全红线测试 —— 这五条每一条对应一个真实攻击面，任一失败绝不上线。
 * 运行：node --test test/security.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';

// ① 不用全局 fetch：Node 24 的 undici 会读系统代理，把 127.0.0.1 也送去 7897，
//    于是拿到的是代理说的 {"type":"forbidden","message":"Request not allowed"}
//    —— 那不是我们服务说的，排查时极易误判。
// ② 用裸 http 模块，零依赖、直连，且将来升级 Node 也不会变。
function localFetch(urlStr, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search,
        method: opts.method || 'GET', headers: opts.headers || {} },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          json: async () => JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
        }));
      });
    req.on('error', reject);
    if (opts.body) req.end(opts.body); else req.end();
  });
}
const fetch = localFetch;

// ③ 端口不写死：listen(0) 让系统分配空闲端口，避免和本机 dev server 抢占
const PORT = Number(process.env.TEST_PORT || 0);
const TOKEN = 'test-token-abc';
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pmw-sec-'));
const SRV = fileURLToPath(new URL('../server.mjs', import.meta.url));

const sleep = ms => new Promise(r => setTimeout(r, ms));

let proc;
let API = '';
test.before(async () => {
  proc = spawn(process.execPath, [SRV], {
    env: { ...process.env, PORT: '0', DATA_DIR: DATA, BACKUP_TOKEN: TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', d => process.stderr.write('[srv] ' + d));
  // 从服务端 stdout 读系统分配的真实端口
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('服务启动超时')), 10000);
    proc.stdout.on('data', d => {
      const m = /\[boot\] PORT=(\d+)/.exec(String(d));
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
  });
  API = `http://127.0.0.1:${port}`;
});
test.after(() => { try { proc.kill(); } catch { } });

const H = t => ({ 'x-backup-token': t || TOKEN });
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7), Buffer.from([0xff, 0xd9]),
]);

async function newBatch(names = ['a.jpg']) {
  const r = await fetch(`${API}/api/batch`, {
    method: 'POST', headers: { ...H(), 'content-type': 'application/json' },
    body: JSON.stringify({ photos: names.map(n => ({ name: n, size: 100 })) }),
  });
  const j = await r.json();
  assert.ok(j.ok, 'batch 应成功: ' + JSON.stringify(j));
  return j.batchId;
}

test('① 没有口令 → 401，且列不出任何批次', async () => {
  const r = await fetch(`${API}/api/health`);
  assert.equal(r.status, 401);
  const r2 = await fetch(`${API}/api/recent`, { headers: H('wrong-token') });
  assert.equal(r2.status, 401);
});

test('② 口令错一个字符也必须是 401（timingSafeEqual 兜底）', async () => {
  const r = await fetch(`${API}/api/health`, { headers: H(TOKEN + 'x') });
  assert.equal(r.status, 401);
});

test('③ 路径穿越 — "../../../evil.jpg" 必须被锁在批次目录里', async () => {
  const id = await newBatch(['../../../evil.jpg']);
  const r = await fetch(`${API}/api/photo?b=${id}&i=0`, { method: 'PUT', headers: H(), body: JPEG });
  assert.ok(r.ok, '上传应成功');
  const j = await r.json();
  const escaped = path.join(DATA, 'evil.jpg');
  assert.ok(!fs.existsSync(escaped), `文件绝不能逃出批次目录！检查 ${escaped}`);
  const inside = path.join(DATA, 'uploads', fs.readdirSync(path.join(DATA, 'uploads')).find(d => d.endsWith(id)));
  assert.ok(fs.existsSync(path.join(inside, j.storedAs)), '文件应落在批次目录内');
});

test('④ 通过 i 参数索引越界必须拒绝', async () => {
  const id = await newBatch(['a.jpg']);
  for (const i of ['-1', '5', '999']) {
    const r = await fetch(`${API}/api/photo?b=${id}&i=${i}`, { method: 'PUT', headers: H(), body: JPEG });
    assert.equal(r.status, 400, `i=${i} 应为 400`);
  }
});

test('⑤ 不存在的批次 id 必须 404', async () => {
  const r = await fetch(`${API}/api/photo?b=deadbeef&i=0`, { method: 'PUT', headers: H(), body: JPEG });
  assert.equal(r.status, 404);
});

test('⑥ 非图片字节必须 415 拒收（哪怕扩展名是 .jpg）', async () => {
  const id = await newBatch(['script.jpg']);
  const evil = Buffer.from('<?php system($_GET["c"]); ?>'.repeat(20));
  const r = await fetch(`${API}/api/photo?b=${id}&i=0`, { method: 'PUT', headers: H(), body: evil });
  assert.equal(r.status, 415, '伪装成图片的可执行内容必须被拒');
});

test('⑦ magic bytes 说了算：内容是 PNG 但名字叫 .heic，按 PNG 归类', async () => {
  const id = await newBatch(['fake.heic']);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 3)]);
  const r = await fetch(`${API}/api/photo?b=${id}&i=0`, { method: 'PUT', headers: H(), body: png });
  const j = await r.json();
  assert.equal(j.kind, 'png', '应嗅探为 png');
});

test('⑧ 超过单文件上限必须断连并计入 413', async () => {
  const id = await newBatch(['big.jpg']);
  const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1024 * 1024 * 30, 1), Buffer.from([0xff, 0xd9])]);
  const r = await fetch(`${API}/api/photo?b=${id}&i=0`, { method: 'PUT', headers: H(), body: big });
  assert.equal(r.status, 413);
});

test('⑨ 同索引重复上传要幂等，不能覆盖出两份', async () => {
  const id = await newBatch(['dup.jpg']);
  const a = await fetch(`${API}/api/photo?b=${id}&i=0`, { method: 'PUT', headers: H(), body: JPEG });
  const first = (await a.json()).storedAs;
  const b = await fetch(`${API}/api/photo?b=${id}&i=0`, { method: 'PUT', headers: H(), body: JPEG });
  const j = await b.json();
  assert.equal(j.dedup, true);
  assert.equal(j.ok, true);
  const dir = path.join(DATA, 'uploads', fs.readdirSync(path.join(DATA, 'uploads')).find(d => d.endsWith(id)));
  assert.equal(fs.readdirSync(dir).filter(f => f === first).length, 1);
});

test('⑩ finish 后 index.jsonl 追加一行，缺图标记为 missing', async () => {
  const id = await newBatch(['x.jpg', 'y.jpg']);
  await fetch(`${API}/api/photo?b=${id}&i=0`, { method: 'PUT', headers: H(), body: JPEG });
  const f = await fetch(`${API}/api/finish?b=${id}`, { method: 'POST', headers: H(), body: '{}' });
  const j = await f.json();
  assert.deepEqual([j.stored, j.total], [1, 2]);
  const lines = fs.readFileSync(path.join(DATA, 'index.jsonl'), 'utf8').trim().split('\n');
  assert.ok(lines.length >= 1);
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.batchId, id);
  assert.equal(last.ok, 1);
});
