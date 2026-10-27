// 取景粒度：中国档「全部 / 省 / 城市」，全球档「全部 / 大洲 / 国家 / 城市」。
//
// 验的是三件事：
//   1. 下拉选项跟着地图范围换（省 ↔ 大洲/国家），且换档时旧值不会残留成非法项；
//   2. 每一档都真的改变取景，且粗细顺序正确：城市 > 全部(打卡点外接框) > 国家 > 大洲
//      （照片都挤在欧洲时才有这个单调关系：全球撒开时「城市」的外接框几乎等于全世界，
//       所以这里刻意用 3 张欧洲照片来测层级）；
//   3. 任何一档 0 出界 0 交叉 —— 取景只管视野，不许把照片排坏。
import fs from 'node:fs';
import path from 'node:path';
import { launch } from './_cdp.mjs';
import { PAGE_URL, EXIFCASES } from './_env.mjs';
import { buildExifJpeg } from './_exif.mjs';

const t = await launch({ port: 9451, profile: 'mwallgran' });
let fatal = null;
try {
  await t.goto(PAGE_URL);
  await t.sleep(500);
  await t.evaluate('indexedDB.deleteDatabase("photo-map-wall")');
  await t.evaluate('(function(){localStorage.clear();document.cookie="pmw_key=;max-age=0;path=/";})()');
  await t.goto(PAGE_URL);
  await t.sleep(900);

  const opts = (sel) => t.evaluate(`(function(){var s=document.getElementById("${sel}");return [].map.call(s.options,function(o){return o.value+":"+o.textContent.replace("粒度：","")})})()`);

  const cnOpts = await opts('selGran');
  t.ok('中国档粒度选项 = 全部/省/城市',
    JSON.stringify(cnOpts) === JSON.stringify(['all:全部', 'prov:省', 'city:城市']), JSON.stringify(cnOpts));

  // 三张欧洲照片：巴黎 / 马赛（法国）、柏林（德国）。
  // 故意都放在欧洲：这样才能看出「大洲 > 国家 > 城市」的粗细层级。
  const DIR = path.join(path.dirname(EXIFCASES), 'grancases');
  fs.mkdirSync(DIR, { recursive: true });
  const spec = [
    ['巴黎', 48.8566, 2.3522], ['马赛', 43.2965, 5.3698], ['柏林', 52.5200, 13.4050],
  ];
  const files = [];
  for (const [nm, lat, lon] of spec) {
    const f = path.join(DIR, nm + '.jpg');
    fs.writeFileSync(f, buildExifJpeg(lat, lon));
    files.push(f);
  }
  await t.setFiles('#file', files);
  await t.sleep(2400);

  const scopeNow = await t.evaluate('document.getElementById("selScope").value');
  t.ok('有国外照片 → 自动进全球档', scopeNow === 'world', scopeNow);

  const wOpts = await opts('selGran');
  t.ok('全球档粒度选项 = 全部/大洲/国家/城市',
    JSON.stringify(wOpts) === JSON.stringify(['all:全部', 'cont:大洲', 'country:国家', 'city:城市']), JSON.stringify(wOpts));

  const labels = await t.evaluate('window.__dbg.photos().map(p=>[p.city,p.cc])');
  t.ok('三张照片的标签是城市名、国家是法国/德国',
    labels.length === 3 && labels.map((x) => x[0]).sort().join(',') === ['巴黎', '柏林', '马赛'].sort().join(',')
    && labels.filter((x) => x[1] === '法国').length === 2 && labels.some((x) => x[1] === '德国'),
    JSON.stringify(labels));

  const st0 = await t.evaluate('window.__selfTest()');
  t.ok('上传后 0 出界 0 交叉', st0.issues.length === 0 && st0.crossings === 0,
    'issues=' + st0.issues.length + ' crossings=' + st0.crossings);

  const scale = () => t.evaluate('+window.__dbg.vw().s');
  const pick = async (v) => {
    await t.evaluate(`(function(){var s=document.getElementById("selGran");s.value="${v}";s.dispatchEvent(new Event("change"));})()`);
    await t.sleep(800);
  };

  const sAll = +(await scale());
  await pick('cont');
  const sCont = +(await scale());
  const stC = await t.evaluate('window.__selfTest()');
  t.ok('大洲档 0 出界 0 交叉', stC.issues.length === 0 && stC.crossings === 0,
    'issues=' + stC.issues.length + ' crossings=' + stC.crossings);
  t.ok('大洲档比「全部」更粗（框更大、缩放更小）', sCont < sAll, 'all=' + sAll + ' cont=' + sCont);
  const shotCont = await t.screenshot('G1-cont.png');

  await pick('country');
  const sCountry = +(await scale());
  const stN = await t.evaluate('window.__selfTest()');
  t.ok('国家档 0 出界 0 交叉', stN.issues.length === 0 && stN.crossings === 0,
    'issues=' + stN.issues.length + ' crossings=' + stN.crossings);
  t.ok('国家档比大洲档细（框更小）', sCountry > sCont, 'cont=' + sCont + ' country=' + sCountry);
  // 不再断言「国家档比全部粗」：法国的世界边界含海外省（圭亚那在 -53°），
  // 于是「法+德」的外接框未必比三个打卡点的外接框更大。层级只在 大洲 ⊃ 国家 ⊃ 城市 之间成立。
  const shotCountry = await t.screenshot('G2-country.png');

  await pick('city');
  const sCity = +(await scale());
  const stCity = await t.evaluate('window.__selfTest()');
  t.ok('城市档 0 出界 0 交叉', stCity.issues.length === 0 && stCity.crossings === 0,
    'issues=' + stCity.issues.length + ' crossings=' + stCity.crossings);
  t.ok('城市档最细（比「全部」更近）', sCity > sAll, 'all=' + sAll + ' city=' + sCity);

  // ——— 带「城市」回中国档：两档都有的选项应保留 ———
  await t.evaluate('(function(){var s=document.getElementById("selScope");s.value="cn";s.dispatchEvent(new Event("change"));})()');
  await t.sleep(900);
  const cnBack = await opts('selGran');
  t.ok('回到中国档，选项又变回 全部/省/城市',
    JSON.stringify(cnBack) === JSON.stringify(['all:全部', 'prov:省', 'city:城市']), JSON.stringify(cnBack));
  const kept = await t.evaluate('document.getElementById("selGran").value');
  t.ok('「城市」两档都有，换档后仍是它（不无故重置）', kept === 'city', kept);

  // ——— 中国档选「省」，再切全球：省没有对应大洲 → 回落「全部」，不能留非法项 ———
  await pick('prov');
  await t.evaluate('(function(){var s=document.getElementById("selScope");s.value="world";s.dispatchEvent(new Event("change"));})()');
  await t.sleep(900);
  const afterProv = await t.evaluate('document.getElementById("selGran").value');
  t.ok('中国档的「省」切到全球后回落成「全部」', afterProv === 'all', afterProv);
  const stW = await t.evaluate('window.__selfTest()');
  t.ok('回落之后仍然 0 出界 0 交叉', stW.issues.length === 0 && stW.crossings === 0,
    'issues=' + stW.issues.length + ' crossings=' + stW.crossings);

  // ——— 手机视口下大洲档也不能崩 ———
  await t.resize(393, 852, { dsf: 3, mobile: true, touch: true });
  await pick('cont');
  const stM = await t.evaluate('window.__selfTest()');
  t.ok('手机视口下大洲档 0 出界 0 交叉', stM.issues.length === 0 && stM.crossings === 0,
    'issues=' + stM.issues.length + ' crossings=' + stM.crossings);
  const shotM = await t.screenshot('G3-cont-mobile.png');

  for (const p of [shotCont, shotCountry, shotM]) console.log(p);
} catch (e) {
  fatal = e;
} finally {
  const pass = t.report();
  await t.close();
  if (fatal) console.error('FATAL', fatal.message);
  process.exit(pass && !fatal ? 0 : 1);
}
