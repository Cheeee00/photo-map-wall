// 一次性补丁：前端在「本机没有身份」时向服务端要回设备 cookie 绑定的 key
const fs = require('node:fs');
const F = 'D:/DSH/创业项目/photo-map-wall/src/index.template.html';
let s = fs.readFileSync(F, 'utf8');
const CRLF = (x) => x.replace(/\n/g, '\r\n');
let n = 0;

/* A. initWallKey 记下「这次是不是新造的 key」 */
const A = CRLF(`  if (!/^[a-f0-9]{32}$/.test(k)) k = newCid() + newCid();
  wallKey = k;`);
const A2 = CRLF(`  initWallKey.minted = !/^[a-f0-9]{32}$/.test(k);
  if (initWallKey.minted) k = newCid() + newCid();
  wallKey = k;`);
if (!s.includes(A)) throw new Error('A 锚点');
s = s.replace(A, A2); n++;

/* B. 新增 syncAdoptServerKey()，放在 setWallKey 之后 */
const B = CRLF(`/* file:// 与 http 页面之外的场景没有同源后端，直接降级 */`);
const B2 = CRLF(`/* 本机没有身份时（清过站点数据、换过浏览器内核），向服务端问一句「这台设备之前是谁」。
   服务端在写清单/传图时下发过 HttpOnly 的 pmw_dev cookie，它不受 Safari ITP
   七天清理脚本可写存储的约束，所以手机放久了回来还能接上同一面墙。 */
let adoptTried = false;
async function syncAdoptServerKey() {
  if (adoptTried) return false;
  adoptTried = true;
  if (!syncAllowed() || !initWallKey.minted) return false;
  try {
    const r = await syncCall('/whoami', {}, 6000);
    if (!r || !r.ok) return false;
    const o = await r.json();
    if (o && o.ok && /^[a-f0-9]{32}$/.test(o.key || '') && o.key !== wallKey) {
      setWallKey(o.key);
      if (o.code) syncCode = o.code;
      renderSyncCode();
      markSync('ok');
      // 接回来的身份上是空的：把本机已有的照片补上去，别让它们只留在这一端
      const mine = photos.filter(function (p) { return !p.demo; });
      if (mine.length) syncQueuePhotos(mine);
      return true;
    }
  } catch (e) { /* 静默：拿不到就继续用新身份 */ }
  return false;
}

/* file:// 与 http 页面之外的场景没有同源后端，直接降级 */`);
if (!s.includes(B)) throw new Error('B 锚点');
s = s.replace(B, B2); n++;

/* C. boot 里先认领服务端身份，再决定拉哪面墙 */
const C = CRLF(`  restoreFromDB().then(function (n) {
    if (n) showHint('已恢复上次的 ' + n + ' 张照片（这台设备或云端存着）');
    return syncPull();
  })`);
const C2 = CRLF(`  restoreFromDB().then(function (n) {
    // 先认领设备身份：本机 key 是刚造的（说明存储被清过），服务端可能还记得这台手机
    return syncAdoptServerKey().then(function () { return n; });
  }).then(function (n) {
    if (n) showHint('已恢复上次的 ' + n + ' 张照片（这台设备或云端存着）');
    return syncPull();
  })`);
if (!s.includes(C)) throw new Error('C 锚点');
s = s.replace(C, C2); n++;

/* D. __dbg 暴露，便于测试 */
const D = CRLF(`  wallKey: function () { return wallKey; },`);
const D2 = CRLF(`  wallKey: function () { return wallKey; },
  adopt: function () { adoptTried = false; return syncAdoptServerKey(); },`);
if (!s.includes(D)) throw new Error('D 锚点');
s = s.replace(D, D2); n++;

fs.writeFileSync(F, s, 'utf8');
console.log('patched', n, 'spots ->', s.length);
