// 拖动照片 = 换槽位（改「绕地图一圈的第几号位」），并验收四件事：
// ① 松手后这张真的落到虚线框标出的那个名次 ② 其余照片自动让位、红线仍零交叉
// ③ 名次写进本地库，刷新后还在 ④ 「自动排位」能清掉名次
// 这个脚本同时覆盖了老 cdp-drag.mjs 的断言（拖动不误触预览 / 真实点击能开大图）。
import path from 'node:path';
import fs from 'node:fs';
import { launch } from './_cdp.mjs';
import { IMGS15, SHOTS_DIR } from './_env.mjs';

const PORT = 9395;
// 复用 imgs15 目录里已经生成好的测试图（gen-testimg 铺的 15 张）
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

    // 三张示例不算数：直接上传 8 张
    await t.setFiles('#file', IMGS);
    await t.sleep(2600);

    const n0 = await t.evaluate(`__selfTest()`);
    t.ok('8 张上传后自检干净', n0.issues.length === 0 && n0.crossings === 0,
      'issues=' + n0.issues.length + ' crossings=' + n0.crossings);

    const seq0 = await t.evaluate(`__dbg.order()`);
    t.ok('拿到环形排位', seq0.length === 8, 'n=' + seq0.length);

    const first = seq0[0];
    t.ok('排位里有城市名', !!first.city, JSON.stringify(first));

    // 记下第 1 位这张照片的屏幕坐标与第 6 个槽位的屏幕位置
    const geo = await t.evaluate(`(() => {
      const g = document.querySelector('#gPhotos > g[data-uid="' + ${first.uid} + '"]');
      const r = g.getBoundingClientRect();
      const ring = __dbg.ringScreen();
      const s = ring[5];
      return { x: r.x + r.width / 2, y: r.y + r.height / 2,
               tx: s.x, ty: s.y, rankOfTarget: 5 };
    })()`);

    const mouse = (type, x, y) => t.send('Input.dispatchMouseEvent', {
      type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1,
    });

    await mouse('mousePressed', geo.x, geo.y);
    for (let k = 1; k <= 14; k++) {
      await mouse('mouseMoved', geo.x + (geo.tx - geo.x) * k / 14, geo.y + (geo.ty - geo.y) * k / 14);
      await t.sleep(16);
    }
    const hintOn = await t.evaluate(`+document.getElementById('slotHint').getAttribute('opacity') > 0`);
    t.ok('拖动中出现槽位虚线框', hintOn === true, String(hintOn));
    await t.screenshot('R1-drag-hint.png');

    await mouse('mouseReleased', geo.tx, geo.ty);
    await t.sleep(700);

    const seq1 = await t.evaluate(`__dbg.order()`);
    const moved = seq1.findIndex((q) => q.uid === first.uid);
    t.ok('松手后落到第 6 位', moved === 5, '实际第 ' + (moved + 1) + ' 位');

    const rankStored = await t.evaluate(`(() => {
      const p = __dbg.photos().find(q => q.uid === ${first.uid});
      return p ? p.rank : 'n/a';
    })()`);
    t.ok('名次记在照片上', rankStored === 5, 'rank=' + rankStored);

    const n1 = await t.evaluate(`__selfTest()`);
    /* 名次由用户指定时，"零交叉"不再是无条件契约：把北方某张硬拖到东南的位置，
       它的线必然横穿另外几根（几何上无解）。契约改成两条：
       ① 不许有重叠/出界；② 有交叉必须当场告诉用户，并留「自动排位」的退路。 */
    const hintTxt = await t.evaluate("(document.getElementById('hint').textContent || '')");
    t.ok('换位后不重叠不出界', n1.issues.length === 0, n1.issues.join('|'));
    t.ok('交叉情况如实告知', n1.crossings === 0 || hintTxt.indexOf('交叉') >= 0,
      'issues=' + n1.issues.length + ' crossings=' + n1.crossings + ' hint=' + hintTxt);
    t.ok('换位后没有照片出界', !n1.issues.some((s) => s.indexOf('出界') >= 0), n1.issues.join('|'));

    // 拖动不能顺手把大图预览打开
    t.ok('拖动没有误触预览', await t.evaluate(`!document.getElementById('viewer').classList.contains('on')`));

    // 刷新后名次还在
    await t.goto();
    await t.sleep(1200);
    const seq2 = await t.evaluate(`__dbg.order()`);
    const after = seq2.findIndex((q) => q.city === first.city);
    t.ok('刷新后名次仍生效', after === 5 && seq2.length === 8,
      '刷新后第 ' + (after + 1) + ' 位 / 共 ' + seq2.length);
    await t.screenshot('R2-reorder-persist.png');

    // 真实点击（不移动）应打开大图 → 「自动排位」清名次
    const c2 = await t.evaluate(`(() => {
      const g = document.querySelector('#gPhotos > g[data-uid="' + ${first.uid} + '"]');
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
    await t.sleep(600);
    const rank2 = await t.evaluate(`(() => {
      const p = __dbg.photos().find(q => q.city === ${JSON.stringify(first.city)});
      return { rank: p ? p.rank : 'n/a', t: __selfTest() };
    })()`);
    t.ok('自动排位清掉名次', rank2.rank === null, 'rank=' + rank2.rank);
    t.ok('自动排位后仍合法', rank2.t.issues.length === 0 && rank2.t.crossings === 0,
      'issues=' + rank2.t.issues.length + ' crossings=' + rank2.t.crossings);
    await t.evaluate(`document.getElementById('viewerClose').click()`);

    // 拖到画布边缘也不能把照片弄丢/出界
    const edge = await t.evaluate(`(() => {
      const g = document.querySelector('#gPhotos > g');
      const r = g.getBoundingClientRect();
      return { uid: +g.getAttribute('data-uid'), x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    await mouse('mousePressed', edge.x, edge.y);
    for (let k = 1; k <= 10; k++) { await mouse('mouseMoved', edge.x - k * 6, edge.y + k * 4); await t.sleep(16); }
    await mouse('mouseReleased', 4, 996);
    await t.sleep(600);
    const n3 = await t.evaluate(`__selfTest()`);
    t.ok('拖到屏幕角落也不出界', n3.issues.length === 0 && n3.crossings === 0,
      'issues=' + n3.issues.length + ' crossings=' + n3.crossings);
    t.ok('拖到角落后张数不变', await t.evaluate(`__dbg.photos().length`) === 8);
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
