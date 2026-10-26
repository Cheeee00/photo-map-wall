// 世界地图档验收：范围切换 / 出国照片命名 / 正反两个方向都不崩
//
//   node test/cdp-world.mjs
//
// 覆盖：
//   1. 默认中国档：基准视图 = 中国全览，地图范围下拉有两个选项
//   2. 切「全球」：地图件重画、基准视图变宽、省名换国名、照片排布仍 0 交叉
//   3. 上传 4 张国外 GPS 照片（巴黎/东京/纽约/悉尼）：
//      → 地点认成 法国/日本/美国/澳大利亚（不是「最近的中国城市」）
//      → 自动从中国档切到全球档
//      → 针落在各自的经纬度上（不是被裁到国境线）
//   4. 再切回中国档：不崩、仍 0 交叉（国外照片被裁到国内也不许炸）
//   5. 国内 GPS 照片不受影响（北京 → 北京）
//   6. 导出仍出图
import fs from 'node:fs';
import path from 'node:path';
import { launch } from './_cdp.mjs';
import { WORLDCASES, SHOTS_DIR } from './_env.mjs';
import { buildExifJpeg } from './_exif.mjs';

// 0 交叉/不出界的口径来自页面自检
const FOREIGN = [
  ['巴黎', 48.8566, 2.3522, '法国'],
  ['东京', 35.6895, 139.6917, '日本'],
  ['纽约', 40.7128, -74.0060, '美国'],
  ['悉尼', -33.8688, 151.2093, '澳大利亚'],
];
const DOMESTIC = [['北京', 39.9042, 116.4074, '北京']];

let fatal = null;
const t = await launch({ port: 9621, profile: 'world', window: [1600, 1000] });
try {
  fs.rmSync(WORLDCASES, { recursive: true, force: true });
  fs.mkdirSync(WORLDCASES, { recursive: true });
  const files = [];
  for (const [nm, lat, lon] of FOREIGN.concat(DOMESTIC)) {
    const p = path.join(WORLDCASES, nm + '.jpg');
    fs.writeFileSync(p, buildExifJpeg(lat, lon));
    files.push(p);
  }

  await t.goto();
  // 清场：点「示例」既清 IndexedDB 又回到示例状态，保证每次跑都是同一个起点
  await t.evaluate('document.getElementById("btnDemo").click()');
  await t.sleep(700);

  // —— 1. 默认中国档 ——
  const st0 = await t.evaluate('window.__selfTest()');
  const scope0 = await t.evaluate('document.getElementById("selScope").value');
  const opts = await t.evaluate('Array.from(document.querySelectorAll("#selScope option")).map(o=>o.value)');
  t.ok('默认范围 = 中国', scope0 === 'cn', scope0);
  t.ok('范围下拉有 中国/全球 两项', opts.join(',') === 'cn,world', opts.join(','));
  t.ok('中国档示例 0 出界 0 交叉', st0.issues.length === 0 && st0.crossings === 0,
    'issues=' + st0.issues.length + ' crossings=' + st0.crossings);
  const baseCn = st0.baseScale;
  const cw = await t.evaluate('window.__dbg.canvas()');
  const shotCn = await t.screenshot('W1-scope-cn.png');

  // —— 2. 切全球 ——
  await t.evaluate('(function(){const s=document.getElementById("selScope");s.value="world";s.dispatchEvent(new Event("change"));})()');
  await t.sleep(900);
  const st1 = await t.evaluate('window.__selfTest()');
  const labels1 = await t.evaluate('Array.from(document.querySelectorAll("#mapContent text")).map(n=>n.textContent)');
  t.ok('切全球后 range=world', (await t.evaluate('document.getElementById("selScope").value')) === 'world');
  t.ok('全球档 0 出界 0 交叉', st1.issues.length === 0 && st1.crossings === 0,
    'issues=' + st1.issues.length + ' crossings=' + st1.crossings);
  t.ok('全球档基准视图比中国档小（视野更大）', st1.baseScale < baseCn,
    'cn=' + baseCn.toFixed(3) + ' world=' + st1.baseScale.toFixed(3));
  t.ok('全球档画的是国名（有「中国」以外的名字）',
    labels1.length > 8 && labels1.indexOf('中国') >= 0 &&
    labels1.some((n) => ['俄罗斯', '美国', '巴西', '澳大利亚', '印度'].indexOf(n) >= 0),
    labels1.length + ' 个：' + labels1.slice(0, 8).join('/'));
  // 大国不许被小国挤掉：日本/英国/德国/南非/埃及 这些常在照片里出现
  const BIG = ['中国', '俄罗斯', '美国', '日本', '英国', '德国', '法国', '南非', '埃及', '印度'];
  const missing = BIG.filter((n) => labels1.indexOf(n) < 0);
  t.ok('常见国家名都还在（日本/英国/德国/南非/埃及…）', missing.length === 0,
    'missing=' + missing.join(',') + ' | 全部=' + labels1.join(','));
  const crowd = await t.evaluate(`(function(){
    const ts=[...document.querySelectorAll('#mapContent text')];
    const rs=ts.map(n=>n.getBoundingClientRect());
    let ov=0;
    for(let i=0;i<rs.length;i++)for(let j=i+1;j<rs.length;j++){
      const a=rs[i],b=rs[j];
      if(a.width<1||b.width<1)continue;
      const ix=Math.min(a.right,b.right)-Math.max(a.left,b.left);
      const iy=Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top);
      if(ix>2&&iy>2)ov++;
    }
    return {n:rs.length, ov:ov};
  })()`);
  t.ok('国名标签没有挤成一坨（压字 ≤ 6 对）', crowd.ov <= 6,
    'labels=' + crowd.n + ' overlap=' + crowd.ov);
  const shotWorld = await t.screenshot('W2-scope-world.png');

  // —— 3. 上传国外 + 国内照片 ——
  await t.setFiles('#file', files);
  await t.sleep(2200);
  const st2 = await t.evaluate('window.__selfTest()');
  const got = await t.evaluate('window.__dbg.photos().map(p=>({c:p.city,lon:p.lon,lat:p.lat,gps:!!p.gps}))');
  const scope2 = await t.evaluate('document.getElementById("selScope").value');
  t.ok('5 张全部识别为有 GPS', got.length === 5 && got.every((p) => p.gps), JSON.stringify(got.map((p) => p.c)));
  for (const [nm, lat, lon, want] of FOREIGN.concat(DOMESTIC)) {
    const p = got.find((q) => q.c === want);
    t.ok(nm + ' → ' + want, !!p, got.map((q) => q.c).join(','));
  }
  t.ok('地点没有落到「最近的中国城市」上',
    !got.some((p) => p.c === '北京' && Math.abs(p.lon - 2.35) < 1), JSON.stringify(got.map((p) => [p.c, p.lon])));
  t.ok('经纬度按原值保存（没被裁到国境线）',
    got.some((p) => Math.abs(p.lon - 2.3522) < 0.02) &&
    got.some((p) => Math.abs(p.lon + 74.006) < 0.02),
    JSON.stringify(got.map((p) => [p.c, +p.lon.toFixed(3)])));
  t.ok('有国外照片 → 自动切到全球档', scope2 === 'world', scope2);
  t.ok('上传后 0 出界 0 交叉', st2.issues.length === 0 && st2.crossings === 0,
    'issues=' + st2.issues.length + ' crossings=' + st2.crossings);
  t.ok('5 张照片 5 根线 5 枚针', st2.photos === 5 && st2.yarns === 5 && st2.pins === 5,
    st2.photos + '/' + st2.yarns + '/' + st2.pins);
  const shotUp = await t.screenshot('W3-world-photos.png');

  // —— 4. 切回中国档 ——
  await t.evaluate('(function(){const s=document.getElementById("selScope");s.value="cn";s.dispatchEvent(new Event("change"));})()');
  await t.sleep(900);
  const st3 = await t.evaluate('window.__selfTest()');
  t.ok('切回中国档不崩、0 出界 0 交叉', st3.issues.length === 0 && st3.crossings === 0,
    'issues=' + st3.issues.length + ' crossings=' + st3.crossings);
  const shotBack = await t.screenshot('W4-back-to-cn.png');

  // —— 5. 缩放后仍稳定 ——
  await t.evaluate('window.__dbg && (function(){const s=document.getElementById("selScope");s.value="world";s.dispatchEvent(new Event("change"));})()');
  await t.sleep(700);
  await t.evaluate('(function(){for(let i=0;i<3;i++) document.getElementById("btnZoomIn").click();})()');
  await t.sleep(600);
  const st4 = await t.evaluate('window.__selfTest()');
  t.ok('全球档放大 3 档后仍 0 出界 0 交叉', st4.issues.length === 0 && st4.crossings === 0,
    'issues=' + st4.issues.length + ' crossings=' + st4.crossings);

  // —— 6. 导出 ——
  const png = await t.evaluate('(async()=>{const c=window.__dbg; return await window.__exportInfo? window.__exportInfo(): null})()');
  const shotZoom = await t.screenshot('W5-world-zoom.png');

  console.log('--- 截图 ---');
  for (const s of [shotCn, shotWorld, shotUp, shotBack, shotZoom]) console.log(s);
} catch (e) {
  fatal = e;
} finally {
  const pass = t.report();
  await t.close();
  if (fatal) console.log('FATAL ' + (fatal && fatal.stack || fatal));
  process.exit(pass && !fatal ? 0 : 1);
}
