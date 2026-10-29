// 一次性补丁：服务端下发设备 cookie + whoami，让「同一台手机」尽量永远是同一个同步码
const fs = require('node:fs');
const F = 'D:/DSH/创业项目/photo-map-wall/functions/api/wall/[[path]].js';
let s = fs.readFileSync(F, 'utf8');
const CRLF = (x) => x.replace(/\n/g, '\r\n');
let n = 0;

/* A. 设备 cookie 助手 */
const A = CRLF(`function newCode() {`);
const A2 = CRLF(`/* 设备 cookie（HttpOnly，由服务端下发）。
   为什么不用 localStorage 就够了：Safari 的 ITP 会把「脚本可写的存储」
   （localStorage / document.cookie）在 7 天不访问后清掉，但**服务端 Set-Cookie 的
   HttpOnly cookie 不受这条规则约束**。所以再存一份服务端 cookie，
   手机放一周再回来时还能认出是同一台设备、同一个同步码。 */
const DEV_COOKIE = 'pmw_dev';
const DEV_AGE = 34560000;    // 400 天（Chrome 上限）

function cookieOf(request, name) {
  const raw = request.headers.get('cookie') || '';
  const m = raw.match(new RegExp('(?:^|;\\\\s*)' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : '';
}
function devCookie(key) {
  return DEV_COOKIE + '=' + key + '; Path=/; Max-Age=' + DEV_AGE
    + '; HttpOnly; SameSite=Lax; Secure';
}

function newCode() {`);
if (!s.includes(A)) throw new Error('A 锚点');
s = s.replace(A, A2); n++;

/* B. whoami 路由（在 key 校验之前：它就是用来「在还没有 key 的时候问一句」的） */
const B = CRLF(`    const key = keyOf(request, url);`);
const B2 = CRLF(`    // ---- 我是谁：本机没有 key 时（清过站点数据 / 换了浏览器内核）问服务端要回设备 cookie
    if (seg === 'whoami' && method === 'GET') {
      const ck = cookieOf(request, DEV_COOKIE);
      if (!KEY_RE.test(ck)) return j({ ok: true, key: null });
      const idx = await readIndex(env, ck);
      return j({ ok: true, key: ck, photos: idx ? idx.photos.length : 0,
        code: idx && idx.code ? fmtCode(idx.code) : null });
    }

    const key = keyOf(request, url);`);
if (!s.includes(B)) throw new Error('B 锚点');
s = s.replace(B, B2); n++;

/* C. 写清单时刷新设备 cookie */
const C = CRLF(`      return j({ ok: true, code: fmtCode(code), count: photos.length });`);
const C2 = CRLF(`      return j({ ok: true, code: fmtCode(code), count: photos.length },
        200, { 'set-cookie': devCookie(key) });`);
if (!s.includes(C)) throw new Error('C 锚点');
s = s.replace(C, C2); n++;

/* D. 传图时也刷新（只传图还没写清单时也能绑上） */
const D = CRLF(`      return j({ ok: true, id, bytes: buf.byteLength });`);
const D2 = CRLF(`      return j({ ok: true, id, bytes: buf.byteLength }, 200, { 'set-cookie': devCookie(key) });`);
if (!s.includes(D)) throw new Error('D 锚点');
s = s.replace(D, D2); n++;

fs.writeFileSync(F, s, 'utf8');
console.log('patched', n, 'spots ->', s.length);
