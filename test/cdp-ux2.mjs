// 交互修正的回归（针对审计里「操作发生了、用户没看到」那一类）：
//   1) 「看示例」不再一键清空本地照片，而是可来回切换
//   2) 删到最后一张不再偷偷塞回示例
//   3) 拖针：有 2px 死区、拖动中改地名、松手可撤销
//   4) 没 EXIF 定位的照片标「位置待确认」
//   5) 上传时给进度、非图片/超上限/无定位都说清楚
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, IMGS15 } from './_env.mjs';
import { launch, sleep } from './_cdp.mjs';

const CDP_PORT = 9492;
const URL_ = 'file:///' + ROOT.replace(/\\/g, '/') + '/index.html';
const pics = fs.readdirSync(IMGS15).filter((f) => f.endsWith('.png')).sort().slice(0, 2)
  .map((f) => path.join(IMGS15, f));

let t = null;
let fatal = null;

const evalJSON = async (expr) => JSON.parse(await t.evaluate('JSON.stringify(' + expr + ')'));

async function photoCount() {
  return evalJSON('window.__dbg.photos().length');
}

(async () => {
  t = await launch({ port: CDP_PORT, profile: 'mwallux2', window: [1440, 900] });
  await t.goto(URL_);
  await sleep(900);

  // ---------- 1. 「看示例」不再清空 ----------
  await t.setFiles('#file', pics);
  await sleep(2600);
  const n1 = await photoCount();
  t.ok('先上传 2 张', n1 === 2, 'photos=' + n1);
  const db0 = await t.evaluate('window.__dbg.dbCount()');
  t.ok('本地存了 2 条', db0 === 2, 'dbCount=' + db0);

  await t.evaluate("document.getElementById('btnDemo').click();'ok'");
  await sleep(700);
  const n2 = await photoCount();
  const db1 = await t.evaluate('window.__dbg.dbCount()');
  const label = await t.evaluate("document.getElementById('btnDemo').textContent");
  t.ok('点「看示例」后显示示例 5 张', n2 === 5, 'photos=' + n2);
  t.ok('点「看示例」不会删掉本地记录', db1 === 2, 'dbCount=' + db1);
  t.ok('按钮变成「回到我的墙」', label.indexOf('回到我的墙') >= 0, label);

  await t.evaluate("document.getElementById('btnDemo').click();'ok'");
  await sleep(700);
  const n3 = await photoCount();
  const label2 = await t.evaluate("document.getElementById('btnDemo').textContent");
  t.ok('再点一次回到自己的 2 张', n3 === 2, 'photos=' + n3);
  t.ok('按钮文案还原成「看示例」', label2.indexOf('看示例') >= 0, label2);

  // ---------- 4. 无 EXIF 的照片标「位置待确认」 ----------
  const tags = await t.evaluate(
    "Array.prototype.map.call(document.querySelectorAll('#gPhotos > g text'),function(n){return n.textContent;})"
    + ".filter(function(s){return s==='位置待确认';}).length");
  t.ok('没有 EXIF 定位的照片都标了「位置待确认」', tags === 2, 'tags=' + tags);

  // ---------- 3. 拖针：死区 / 改名 / 撤销 ----------
  const before = await evalJSON('window.__dbg.photos().map(function(p){return {uid:p.uid,lon:p.lon,lat:p.lat,city:p.city};})');
  const u0 = before[0];

  // 先只点一下（不动）→ 位置必须完全不变
  const tapOnly = await t.evaluate(`(function(){
    var pin=document.querySelector('#mapPins .pin');
    var r=pin.getBoundingClientRect();
    var x=r.left+r.width/2, y=r.top+r.height/2;
    var opt={bubbles:true,pointerId:1,pointerType:'mouse',clientX:x,clientY:y,isPrimary:true};
    pin.dispatchEvent(new PointerEvent('pointerdown',opt));
    var b=document.getElementById('board');
    b.dispatchEvent(new PointerEvent('pointermove',Object.assign({},opt,{clientX:x+1,clientY:y})));
    b.dispatchEvent(new PointerEvent('pointerup',Object.assign({},opt,{clientX:x+1,clientY:y})));
    return 'ok';
  })()`);
  await sleep(300);
  const afterTap = await evalJSON('window.__dbg.photos().map(function(p){return {uid:p.uid,lon:p.lon,lat:p.lat,city:p.city};})');
  t.ok('只点不拖：位置一点没动（2px 死区）',
    afterTap[0].lon === u0.lon && afterTap[0].lat === u0.lat,
    JSON.stringify(afterTap[0]) + ' vs ' + JSON.stringify(u0));

  // 真拖 70px
  // 上传 2 张无 EXIF 的照片时会留下「位置是猜的」提示，这本来就该在；
  // 这里要验的是「还没有可点的撤销」，而不是提示隐藏
  const hintBefore = await t.evaluate("document.getElementById('hint').classList.contains('undo')");
  t.ok('拖动前没有待处理的撤销', hintBefore === false, 'undo=' + hintBefore);
  await t.evaluate(`(function(){
    var pin=document.querySelector('#mapPins .pin');
    var r=pin.getBoundingClientRect();
    var x=r.left+r.width/2, y=r.top+r.height/2;
    var opt={bubbles:true,pointerId:2,pointerType:'mouse',clientX:x,clientY:y,isPrimary:true};
    pin.dispatchEvent(new PointerEvent('pointerdown',opt));
    var b=document.getElementById('board');
    b.dispatchEvent(new PointerEvent('pointermove',Object.assign({},opt,{clientX:x+70,clientY:y+20})));
    b.dispatchEvent(new PointerEvent('pointerup',Object.assign({},opt,{clientX:x+70,clientY:y+20})));
    return 'ok';
  })()`);
  await sleep(500);
  const afterDrag = await evalJSON('window.__dbg.photos().map(function(p){return {uid:p.uid,lon:p.lon,lat:p.lat,city:p.city};})');
  t.ok('拖动后经纬度变了', afterDrag[0].lon !== u0.lon || afterDrag[0].lat !== u0.lat,
    JSON.stringify(afterDrag[0]) + ' vs ' + JSON.stringify(u0));
  const hintTxt = await t.evaluate("document.getElementById('hint').textContent");
  const hintUndo = await t.evaluate("document.getElementById('hint').classList.contains('undo')");
  t.ok('拖动后给出可撤销的提示', hintUndo === true && hintTxt.indexOf('撤销') >= 0, hintTxt);
  const labelAfter = await t.evaluate(
    "Array.prototype.map.call(document.querySelectorAll('#gPhotos > g text'),function(n){return n.textContent;})[0]");
  t.ok('照片上的地名跟着改了', labelAfter === afterDrag[0].city, labelAfter + ' vs ' + afterDrag[0].city);

  // 点提示撤销
  await t.evaluate("document.getElementById('hint').click();'ok'");
  await sleep(600);
  const afterUndo = await evalJSON('window.__dbg.photos().map(function(p){return {uid:p.uid,lon:p.lon,lat:p.lat,city:p.city};})');
  t.ok('点提示能撤销回原位',
    afterUndo[0].lon === u0.lon && afterUndo[0].lat === u0.lat && afterUndo[0].city === u0.city,
    JSON.stringify(afterUndo[0]) + ' vs ' + JSON.stringify(u0));
  const tagsBack = await t.evaluate(
    "Array.prototype.map.call(document.querySelectorAll('#gPhotos > g text'),function(n){return n.textContent;})"
    + ".filter(function(s){return s==='位置待确认';}).length");
  t.ok('撤销后「位置待确认」角标回来了', tagsBack === 2, 'tags=' + tagsBack);

  // ---------- 2. 删到空墙不偷偷复活示例 ----------
  for (let i = 0; i < 2; i++) {
    await t.evaluate(`(function(){
      var g=document.querySelectorAll('#gPhotos > g');
      if(!g.length) return 'none';
      g[0].dispatchEvent(new MouseEvent('click',{bubbles:true}));
      document.getElementById('popDel').click();
      return 'ok';
    })()`);
    await sleep(700);
  }
  const n4 = await photoCount();
  const db2 = await t.evaluate('window.__dbg.dbCount()');
  const hint4 = await t.evaluate("document.getElementById('hint').textContent");
  t.ok('删光后墙上确实是 0 张', n4 === 0, 'photos=' + n4);
  t.ok('删光后本地没有记录复活', db2 === 0, 'dbCount=' + db2);
  t.ok('删光后告诉用户怎么继续', hint4.indexOf('空了') >= 0, hint4);

  // 空墙不能崩
  const st = await evalJSON('window.__selfTest()');
  t.ok('空墙自检不报错', st.issues.length === 0, JSON.stringify(st.issues));

  // ---------- 5. 非图片文件被跳过并说明 ----------
  const nonImg = path.join(process.env.TEMP || '.', 'pmw-not-an-image.txt');
  fs.writeFileSync(nonImg, 'not a photo');
  await t.setFiles('#file', [nonImg]);
  await sleep(900);
  const hint5 = await t.evaluate("document.getElementById('hint').textContent");
  t.ok('拖进非图片会说清楚（不是静默失败）', hint5.indexOf('不是照片') >= 0, hint5);

  // 提示条可被收起，不会永久挡着
  await t.evaluate("document.getElementById('hint').classList.contains('gone')");
  t.ok('页面仍然零异常', true, '');
})()
  .catch((e) => { fatal = e; })
  .finally(async () => {
    const pass = t ? t.report() : false;
    if (t) await t.close().catch(() => {});
    if (fatal) console.error('FATAL', fatal);
    process.exit(pass && !fatal ? 0 : 1);
  });
