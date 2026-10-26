// 交互行为测试：两档选择器 + 「新照片不打扰视野」+ 大图预览。
// 这些是本轮新增的 UX 契约，靠像素看不出来，必须逐条断言。
import fs from 'node:fs';
import { IMGS15 } from './_env.mjs';
import { launch, sleep } from './_cdp.mjs';

const imgs = fs.readdirSync(IMGS15).filter((f) => f.endsWith('.png')).sort().map((f) => IMGS15 + '\\' + f);
const PAGE = 'file:///D:/DSH/创业项目/photo-map-wall/index.html';

const t = await launch({ port: 9511, profile: 'mwallux', window: [1600, 1000] });
let fatal = null;
try {
  await t.goto(PAGE);

  // ---------- 1. 示例状态 ----------
  const demo = JSON.parse(await t.evaluate('JSON.stringify(__selfTest())'));
  const demoUi = JSON.parse(await t.evaluate(`JSON.stringify({
    granDisabled: document.getElementById('selGran').disabled,
    granValue: document.getElementById('selGran').value,
    hasnew: document.getElementById('btnFit').classList.contains('hasnew'),
    vw: __dbg.vw(), baseS: __dbg.baseS()
  })`));
  t.ok('示例：粒度下档被禁用', demoUi.granDisabled, JSON.stringify(demoUi));
  t.ok('示例：视图 = 中国全览', Math.abs(demoUi.vw.s - demoUi.baseS) < 1e-6, `${demoUi.vw.s} vs ${demoUi.baseS}`);
  t.ok('示例：没有“新照片”提示', !demoUi.hasnew);
  t.ok('示例：5 张示例照片零交叉零重叠', demo.crossings === 0 && demo.issues.length === 0, JSON.stringify(demo.issues));

  // ---------- 2. 第一次上传：应自动全览 ----------
  await t.setFiles('#file', imgs.slice(0, 5));
  await sleep(2200);
  const up1 = JSON.parse(await t.evaluate(`JSON.stringify({
    vw: __dbg.vw(), tgt: __dbg.tgt(), baseS: __dbg.baseS(),
    granDisabled: document.getElementById('selGran').disabled,
    hasnew: document.getElementById('btnFit').classList.contains('hasnew'),
    st: __selfTest()
  })`));
  t.ok('首次上传：粒度下档解锁', !up1.granDisabled);
  t.ok('首次上传：自动全览到打卡点',
    Math.abs(up1.vw.s - Math.max(up1.tgt.s, up1.baseS)) < Math.abs(up1.tgt.s) * 0.06 + 1e-3,
    `view=${up1.vw.s.toFixed(3)} target=${up1.tgt.s.toFixed(3)} base=${up1.baseS.toFixed(3)}`);
  t.ok('首次上传：不弹“新照片”提示', !up1.hasnew);
  t.ok('首次上传：零重叠零交叉', up1.st.issues.length === 0 && up1.st.crossings === 0, JSON.stringify(up1.st.issues));

  // ---------- 3. 第二次上传：不许动视野，只给提示点 ----------
  const before = up1.vw;
  await t.setFiles('#file', imgs.slice(5, 10));
  await sleep(2000);
  const up2 = JSON.parse(await t.evaluate(`JSON.stringify({
    vw: __dbg.vw(),
    hasnew: document.getElementById('btnFit').classList.contains('hasnew'),
    n: __dbg.photos().length,
    st: __selfTest()
  })`));
  const moved = Math.abs(up2.vw.s - before.s) / before.s + Math.abs(up2.vw.tx - before.tx) / 1000 + Math.abs(up2.vw.ty - before.ty) / 1000;
  t.ok('二次上传：视野一动不动', moved < 0.002, `位移量 ${moved.toFixed(5)}；${before.s.toFixed(3)}→${up2.vw.s.toFixed(3)}`);
  t.ok('二次上传：按钮亮起提示点', up2.hasnew);
  t.ok('二次上传：照片确实变多', up2.n === 10, up2.n);
  t.ok('二次上传：零重叠零交叉', up2.st.issues.length === 0 && up2.st.crossings === 0, JSON.stringify(up2.st.issues));

  const shotNew = await t.screenshot('U1-hasnew.png');
  t.ok('二次上传：截图落盘', fs.existsSync(shotNew));

  // ---------- 4. 点「适应全部」→ 提示点消失、视野收拢 ----------
  const fitRect = JSON.parse(await t.evaluate(`JSON.stringify(document.getElementById('btnFit').getBoundingClientRect())`));
  for (const type of ['mousePressed', 'mouseReleased']) {
    await t.send('Input.dispatchMouseEvent', {
      type, x: Math.round(fitRect.x + fitRect.width / 2), y: Math.round(fitRect.y + fitRect.height / 2),
      button: 'left', clickCount: 1,
    });
  }
  await sleep(1500);
  const afterFit = JSON.parse(await t.evaluate(`JSON.stringify({
    vw: __dbg.vw(), hasnew: document.getElementById('btnFit').classList.contains('hasnew')
  })`));
  t.ok('点“适应全部”：提示点消失', !afterFit.hasnew);
  t.ok('点“适应全部”：视野变化（收拢到全部照片）',
    Math.abs(afterFit.vw.s - up2.vw.s) / up2.vw.s > 0.01,
    `${up2.vw.s.toFixed(3)}→${afterFit.vw.s.toFixed(3)}`);

  // ---------- 5. 粒度三档 ----------
  const gran = {};
  for (const g of ['all', 'prov', 'city']) {
    await t.evaluate(`(function(){const s=document.getElementById('selGran');s.value='${g}';s.dispatchEvent(new Event('change'));return 1;})()`);
    await sleep(1200);
    gran[g] = JSON.parse(await t.evaluate('JSON.stringify({vw:__dbg.vw(),gran:document.getElementById("selGran").value})'));
  }
  t.ok('粒度：全部/省/城市三档都能切', gran.all.gran === 'all' && gran.prov.gran === 'prov' && gran.city.gran === 'city');
  t.ok('粒度：省档与全部档视野不同', Math.abs(gran.prov.vw.s - gran.all.vw.s) / gran.all.vw.s > 0.01,
    `${gran.all.vw.s.toFixed(3)} → ${gran.prov.vw.s.toFixed(3)}`);
  t.ok('粒度：城市档比省档更近', gran.city.vw.s > gran.prov.vw.s * 1.02,
    `省 ${gran.prov.vw.s.toFixed(3)} → 城市 ${gran.city.vw.s.toFixed(3)}`);
  t.ok('粒度：切换后零重叠零交叉', (await t.evaluate('__selfTest().issues.length + __selfTest().crossings')) === 0);

  // 回到「全部」再做预览测试
  await t.evaluate(`(function(){const s=document.getElementById('selGran');s.value='all';s.dispatchEvent(new Event('change'));return 1;})()`);
  await sleep(1200);

  // ---------- 6. 点照片看大图 ----------
  const photoRect = JSON.parse(await t.evaluate(`(function(){
    const g = document.querySelectorAll('#gPhotos > g')[0];
    const r = g.getBoundingClientRect();
    return JSON.stringify({x:r.x+r.width/2, y:r.y+r.height/2, w:r.width, h:r.height});
  })()`));
  for (const type of ['mousePressed', 'mouseReleased']) {
    await t.send('Input.dispatchMouseEvent', {
      type, x: Math.round(photoRect.x), y: Math.round(photoRect.y), button: 'left', clickCount: 1,
    });
  }
  await sleep(700);
  const viewer = JSON.parse(await t.evaluate(`JSON.stringify({
    on: document.getElementById('viewer').classList.contains('on'),
    imgW: document.getElementById('viewerImg').naturalWidth,
    barText: document.getElementById('popCity').value
  })`));
  t.ok('点照片：大图打开', viewer.on);
  t.ok('点照片：大图有真实像素', viewer.imgW > 100, viewer.imgW);
  t.ok('点照片：显示地点名', !!viewer.barText, viewer.barText);
  await t.screenshot('U2-viewer.png');

  await t.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await t.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(500);
  t.ok('按 Esc：大图关闭', !(await t.evaluate("document.getElementById('viewer').classList.contains('on')")));

  // ---------- 7. 恢复示例 → 下档重新禁用 ----------
  await t.evaluate("document.getElementById('btnDemo').click()");
  await sleep(1600);
  const back = JSON.parse(await t.evaluate(`JSON.stringify({
    granDisabled: document.getElementById('selGran').disabled,
    granValue: document.getElementById('selGran').value,
    vw: __dbg.vw(), baseS: __dbg.baseS(),
    hasnew: document.getElementById('btnFit').classList.contains('hasnew'),
    n: __dbg.photos().length
  })`));
  t.ok('恢复示例：照片回到 5 张', back.n === 5, back.n);
  t.ok('恢复示例：粒度下档重新禁用', back.granDisabled);
  t.ok('恢复示例：粒度退回“全部”', back.granValue === 'all');
  t.ok('恢复示例：视图回中国全览', Math.abs(back.vw.s - back.baseS) < 1e-6);
  t.ok('恢复示例：提示点已清', !back.hasnew);
} catch (e) {
  fatal = e;
} finally {
  if (fatal) console.log('FATAL ' + (fatal && fatal.message ? fatal.message : String(fatal)));
  const pass = t.report();
  await t.close();
  process.exit(pass && !fatal ? 0 : 1);
}
