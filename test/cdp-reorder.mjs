// 拖动照片 = 自由摆放（想放哪儿放哪儿），验收六件事：
// ① 松手后照片中心真的落在手指放下的位置（不再吸附到系统给的格子）
// ② 位置以 0–1 相对值存进本地库，刷新后还在原处
// ③ 拖动这一张不会把别张挪走（自由摆放 ≠ 自动让位）
// ④ 出画布会被夹住，不会丢照片
// ⑤ 红线交叉时如实提示（自由摆放的必然代价）
// ⑥ 「自动排位」能清掉手动位置、回到零交叉的自动排布
// 顺带覆盖老 cdp-drag.mjs 的断言：拖动不误触大图预览、真实点击能开大图。
import path from 'node:path';
import fs from 'node:fs';
import { launch } from './_cdp.mjs';
import { IMGS15 } from './_env.mjs';

const PORT = 9395;
const IMGS = fs.existsSync(IMGS15)
  ? fs.readdirSync(IMGS15).filter((f) => f.endsWith('.png')).sort().slice(0, 8).map((f) => path.join(IMGS15, f))
  : [];

async function main() {
  const t = await launch({ port: PORT, profile: 'mwallreorder', window: [1600, 1000] });
  let fatal = null;
  try {
    await t.goto();
    await t.evaluate(`(async () => {
      await new Promise(r => { const q = indexedDB.deleteDatabase('photo-map-wall'); q.onsuccess = q.onerror = q.onblocked = r; });
      try { localStorage.clear(); document.cookie = 'pmw_key=; max-age=0; path=/'; } catch (e) {}
      return true;
    })()`);
    await t.goto();

    await t.setFiles('#file', IMGS);
    await t.sleep(2600);

    const n0 = await t.evaluate(`__selfTest()`);
    t.ok('8 张上传后自检干净', n0.issues.length === 0 && n0.crossings === 0,
      'issues=' + n0.issues.length + ' crossings=' + n0.crossings);

    // 记下所有照片的屏幕中心，稍后比对「别张有没有被挪走」
    const before = await t.evaluate(`(() => {
      const out = {};
      document.querySelectorAll('#gPhotos > g[data-uid]').forEach(g => {
        const r = g.getBoundingClientRect();
        out[g.getAttribute('data-uid')] = [+(r.x + r.width / 2).toFixed(1), +(r.y + r.height / 2).toFixed(1)];
      });
      return out;
    })()`);
    const uids = Object.keys(before);
    t.ok('画面上有 8 张照片节点', uids.length === 8, 'n=' + uids.length);

    const uid0 = +uids[0];
    const start = { x: before[uid0][0], y: before[uid0][1] };

    // 目标点：画布坐标里挑一个「绝不在环形槽位上」的位置（地图右下角的空白处）
    const target = await t.evaluate(`(() => {
      const c = __dbg.canvas();
      const m = document.getElementById('gPhotos').getScreenCTM();
      const pt = new DOMPoint(c.bw * 0.42, c.bh * 0.86).matrixTransform(m);
      return { x: +pt.x.toFixed(1), y: +pt.y.toFixed(1) };
    })()`);

    const mouse = (type, x, y) => t.send('Input.dispatchMouseEvent', {
      type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1,
    });

    await mouse('mousePressed', start.x, start.y);
    for (let k = 1; k <= 16; k++) {
      await mouse('mouseMoved', start.x + (target.x - start.x) * k / 16, start.y + (target.y - start.y) * k / 16);
      await t.sleep(16);
    }
    await t.screenshot('F1-free-drag.png');
    await mouse('mouseReleased', target.x, target.y);
    await t.sleep(700);

    const after = await t.evaluate(`(() => {
      const g = document.querySelector('#gPhotos > g[data-uid="' + ${uid0} + '"]');
      const r = g.getBoundingClientRect();
      return { x: +(r.x + r.width / 2).toFixed(1), y: +(r.y + r.height / 2).toFixed(1),
               pos: (__dbg.photos().find(p => p.uid === ${uid0}) || {}).pos || null };
    })()`);

    const dx = Math.abs(after.x - target.x), dy = Math.abs(after.y - target.y);
    t.ok('松手后落在手指放下的位置', dx <= 10 && dy <= 10,
      '偏差 dx=' + dx.toFixed(1) + ' dy=' + dy.toFixed(1) + '（目标 ' + target.x + ',' + target.y + ' 实际 ' + after.x + ',' + after.y + '）');
    t.ok('位置存成相对坐标', !!after.pos && typeof after.pos.fx === 'number',
      JSON.stringify(after.pos));

    // 其余照片一个都不许动
    const moved = await t.evaluate(`(() => {
      const out = [];
      document.querySelectorAll('#gPhotos > g[data-uid]').forEach(g => {
        const id = g.getAttribute('data-uid');
        if (+id === ${uid0}) return;
        const r = g.getBoundingClientRect();
        const b = ${JSON.stringify(before)}[id];
        const c = [+(r.x + r.width / 2).toFixed(1), +(r.y + r.height / 2).toFixed(1)];
        if (Math.abs(b[0] - c[0]) > 1 || Math.abs(b[1] - c[1]) > 1) out.push({ id: id, b: b, c: c });
      });
      return out;
    })()`);
    t.ok('其它照片没有被自动挪走', moved.length === 0, JSON.stringify(moved));

    const n1 = await t.evaluate(`__selfTest()`);
    t.ok('自由摆放后不重叠不出界（除了被拖动这张）',
      !n1.issues.some((s) => s.indexOf('出界') >= 0), n1.issues.join('|'));

    const hintTxt = await t.evaluate("(document.getElementById('hint').textContent || '')");
    t.ok('落位有提示', hintTxt.indexOf('就钉在这儿') >= 0, hintTxt.slice(0, 60));
    t.ok('交叉时如实告知', n1.crossings === 0 || hintTxt.indexOf('交叉') >= 0,
      'crossings=' + n1.crossings + ' hint=' + hintTxt.slice(0, 80));

    t.ok('拖动没有误触预览', await t.evaluate(`!document.getElementById('viewer').classList.contains('on')`));

    // 刷新：位置必须还在
    await t.goto();
    await t.sleep(1400);
    const reload = await t.evaluate(`(() => {
      const p = __dbg.photos().find(q => q.uid === ${uid0});
      const g = document.querySelector('#gPhotos > g[data-uid="' + ${uid0} + '"]');
      if (!p || !g) return null;
      const r = g.getBoundingClientRect();
      return { pos: p.pos, x: +(r.x + r.width / 2).toFixed(1), y: +(r.y + r.height / 2).toFixed(1) };
    })()`);
    t.ok('刷新后手动位置还在', !!reload && Math.abs(reload.x - after.x) <= 10 && Math.abs(reload.y - after.y) <= 10,
      reload ? ('刷新后 ' + reload.x + ',' + reload.y + ' 原为 ' + after.x + ',' + after.y) : 'null');
    await t.screenshot('F2-free-persist.png');

    // 拖到画布角落：夹住但不能丢
    const corner = await t.evaluate(`(() => {
      const g = document.querySelector('#gPhotos > g[data-uid="' + ${uid0} + '"]');
      const r = g.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    await mouse('mousePressed', corner.x, corner.y);
    for (let k = 1; k <= 10; k++) { await mouse('mouseMoved', corner.x + k * 8, corner.y + k * 10); await t.sleep(16); }
    await mouse('mouseReleased', 1596, 996);
    await t.sleep(600);
    const n2 = await t.evaluate(`__selfTest()`);
    t.ok('拖到角落也不出界', !n2.issues.some((s) => s.indexOf('出界') >= 0), n2.issues.join('|'));
    t.ok('拖到角落后张数不变', await t.evaluate(`__dbg.photos().length`) === 8);

    // 真实点击 → 大图 → 「自动排位」清掉手动位置
    const c2 = await t.evaluate(`(() => {
      const g = document.querySelector('#gPhotos > g[data-uid="' + ${uid0} + '"]');
      const r = g.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    await mouse('mousePressed', c2.x, c2.y);
    await t.sleep(40);
    await mouse('mouseReleased', c2.x, c2.y);
    await t.sleep(500);
    t.ok('真实点击能开大图', await t.evaluate(`document.getElementById('viewer').classList.contains('on')`));
    t.ok('「自动排位」可见', await t.evaluate(`!document.getElementById('popReset').hidden`));

    await t.evaluate(`document.getElementById('popReset').click()`);
    await t.sleep(800);
    const back = await t.evaluate(`(() => {
      const p = __dbg.photos().find(q => q.uid === ${uid0});
      return { pos: p ? p.pos : 'n/a', t: __selfTest() };
    })()`);
    t.ok('自动排位清掉手动位置', back.pos === null, JSON.stringify(back.pos));
    t.ok('自动排位后零交叉', back.t.issues.length === 0 && back.t.crossings === 0,
      'issues=' + back.t.issues.length + ' crossings=' + back.t.crossings);

    // 「适应全部」= 视野回全部 + 照片回到自动排版（用户 2026-10-28 反馈：只动镜头像没生效）
    await t.evaluate(`__dbg.setPos(${uid0}, 0.32, 0.78)`);
    await t.sleep(400);
    const manual = await t.evaluate(`__dbg.photos().find(p => p.uid === ${uid0}).pos`);
    t.ok('摆到指定位置后记下了坐标', !!manual && Math.abs(manual.fx - 0.32) < 0.02, JSON.stringify(manual));

    await t.evaluate(`document.getElementById('btnFit').click()`);
    await t.sleep(1100);
    const afterFit = await t.evaluate(`({
      pos: __dbg.photos().map(p => p.pos).filter(Boolean).length,
      n: __dbg.photos().length,
      hint: document.getElementById('hint').textContent,
      t: __selfTest()
    })`);
    t.ok('「适应全部」清掉了手动位置', afterFit.pos === 0, 'remaining=' + afterFit.pos);
    t.ok('「适应全部」后张数不变', afterFit.n === 8, String(afterFit.n));
    t.ok('「适应全部」后自动排版零交叉', afterFit.t.issues.length === 0 && afterFit.t.crossings === 0,
      'issues=' + afterFit.t.issues.length + ' crossings=' + afterFit.t.crossings);
    t.ok('提示里说了可撤销', afterFit.hint.indexOf('撤销') >= 0, afterFit.hint);

    // 撤销要能把用户手摆的位置找回来
    await t.evaluate(`document.getElementById('hint').click()`);
    await t.sleep(700);
    const undone = await t.evaluate(`__dbg.photos().find(p => p.uid === ${uid0}).pos`);
    t.ok('撤销后位置回来了', !!undone && Math.abs(undone.fx - 0.32) < 0.02, JSON.stringify(undone));
    await t.evaluate(`document.getElementById('viewerClose').click()`);
  } catch (e) {
    fatal = e;
    console.error('FATAL', e);
  } finally {
    const pass = t.report();
    await t.close();
    process.exit(pass && !fatal ? 0 : 1);
  }
}
main();
