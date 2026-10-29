// 上传进度条验收：
// ① 一次加 15 张时进度条真的出现（不是一直 0% 也不是瞬间闪掉）
// ② 宽度按张数递增，从很小的值走到 100%
// ③ 干完就收掉，屏幕上不留一条 100% 的条子
// ④ 只加 1 张也照常能上传（进度条不是必需品）
import path from 'node:path';
import fs from 'node:fs';
import { launch } from './_cdp.mjs';
import { IMGS15 } from './_env.mjs';

const PORT = 9399;
const IMGS = fs.existsSync(IMGS15)
  ? fs.readdirSync(IMGS15).filter((f) => f.endsWith('.png')).sort().slice(0, 15).map((f) => path.join(IMGS15, f))
  : [];

async function main() {
  const t = await launch({ port: PORT, profile: 'mwallprog', window: [1600, 1000] });
  let fatal = null;
  try {
    await t.goto();
    await t.evaluate(`(async () => {
      await new Promise(r => { const q = indexedDB.deleteDatabase('photo-map-wall'); q.onsuccess = q.onerror = q.onblocked = r; });
      try { localStorage.clear(); document.cookie = 'pmw_key=; max-age=0; path=/'; } catch (e) {}
      return true;
    })()`);
    await t.goto();

    t.ok('进度条元素在页面上', await t.evaluate(`!!document.getElementById('prog')`));

    // 起上传，同时高频采样
    const samples = [];
    await t.setFiles('#file', IMGS);
    for (let k = 0; k < 130; k++) {
      const s = await t.evaluate(`(() => {
        const el = document.getElementById('prog');
        const bar = el.querySelector('.bar > i');
        return { on: el.classList.contains('on'), w: parseFloat(bar.style.width) || 0,
                 txt: el.querySelector('b').textContent };
      })()`);
      samples.push(s);
      if (k > 4 && !s.on && samples.some((x) => x.w >= 100)) break;
      await t.sleep(50);
    }
    await t.sleep(600);

    const shown = samples.filter((s) => s.on);
    const maxW = Math.max.apply(null, samples.map((s) => s.w));
    const midW = samples.filter((s) => s.w > 0 && s.w < 100).length;
    t.ok('进度条出现过', shown.length > 0, 'on 采样 ' + shown.length + '/' + samples.length);
    t.ok('宽度走到过 100%', maxW >= 100, 'maxW=' + maxW);
    t.ok('中间状态被看到过（不是瞬间跳完）', midW > 0, 'mid 采样 ' + midW);
    const txtHasCount = shown.some((s) => /\d+\s*\/\s*15/.test(s.txt));
    t.ok('进度文字带张数', txtHasCount, JSON.stringify(shown.map((s) => s.txt).slice(0, 3)));

    // 干完收掉
    const end = await t.evaluate(`document.getElementById('prog').classList.contains('on')`);
    t.ok('干完就收掉了', end === false, 'still on=' + end);

    const log = await t.evaluate(`__dbg.progLog()`);
    t.ok('进度日志覆盖 15 张', log.length >= 15 && log[log.length - 1].n === 15,
      'len=' + log.length + ' last=' + JSON.stringify(log[log.length - 1]));
    let mono = true;
    for (let i = 1; i < log.length; i++) if (log[i].i < log[i - 1].i) mono = false;
    t.ok('进度是单调递增的', mono);

    const st = await t.evaluate(`__selfTest()`);
    t.ok('15 张上传后自检干净', st.issues.length === 0 && st.crossings === 0,
      'issues=' + st.issues.length + ' crossings=' + st.crossings);
    t.ok('张数正确', await t.evaluate(`__dbg.photos().length`) === 15);

    // 再加 1 张：进度条流程不能把它卡住
    await t.setFiles('#file', [IMGS[0]]);
    await t.sleep(1500);
    t.ok('单张补传也能加进来', await t.evaluate(`__dbg.photos().length`) === 16,
      'n=' + await t.evaluate(`__dbg.photos().length`));
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
