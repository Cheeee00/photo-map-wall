/* 一次性补丁：上传进度条 */
const fs = require('node:fs');
const F = 'D:/DSH/创业项目/photo-map-wall/src/index.template.html';
let s = fs.readFileSync(F, 'utf8');
const CRLF = (x) => x.replace(/\n/g, '\r\n');
let n = 0;

/* A. CSS */
const cssAnchor = CRLF("  #hint.undo:hover{color:#FFD9A8;}\n");
const cssAdd = CRLF(`
  /* ---------- 上传进度条 ----------
     一次加十几张时，照片要逐张读文件 + 解尺寸 + 读 EXIF，能有好几秒。
     只有一行「正在读取 3 / 12」看不出还剩多久，加一条细进度条。 */
  #prog{
    position:fixed;left:50%;bottom:104px;transform:translateX(-50%);
    width:min(280px,64vw);z-index:20;pointer-events:none;
    opacity:0;transition:opacity .25s;
  }
  #prog.on{opacity:1;}
  #prog b{
    display:block;text-align:center;font-size:11.5px;font-weight:400;letter-spacing:.5px;
    color:rgba(232,220,203,.72);margin-bottom:5px;
  }
  #prog .bar{
    height:4px;border-radius:3px;overflow:hidden;background:rgba(255,255,255,.13);
    box-shadow:0 1px 2px rgba(0,0,0,.35) inset;
  }
  #prog .bar > i{
    display:block;height:100%;width:0;border-radius:3px;
    background:linear-gradient(90deg,#C6A65C,#E9CE87);
    transition:width .18s ease-out;
  }
  @media (max-width:560px){ #prog{bottom:calc(122px + env(safe-area-inset-bottom,0px));} }
`);
if (!s.includes(cssAnchor)) throw new Error('CSS 锚点没找到');
s = s.replace(cssAnchor, cssAnchor + cssAdd); n++;

/* B. HTML */
const htmlAnchor = CRLF('<div id="hint">拖照片进来 · 或点「加照片」 · 拖动地图上的大头针可改位置</div>\n');
const htmlAdd = CRLF(`  <div id="prog"><b></b><div class="bar"><i></i></div></div>
`);
if (!s.includes(htmlAnchor)) throw new Error('HTML 锚点没找到');
s = s.replace(htmlAnchor, htmlAnchor + htmlAdd); n++;

/* C. JS 函数，插在 addFiles 之前 */
const jsAnchor = CRLF("async function addFiles(files) {");
const jsAdd = CRLF(`/* 上传进度：只有真正在做耗时活（读文件/解尺寸/读 EXIF）时才出现，
   干完立刻收掉，不留一条 100% 的条子在屏幕上。 */
let progLog = [];
const progEl = document.getElementById('prog');
const progBar = progEl ? progEl.querySelector('.bar > i') : null;
const progTxt = progEl ? progEl.querySelector('b') : null;
function progSet(i, total) {
  if (!progEl) return;
  progLog.push({ i: i, n: total });
  if (progLog.length > 200) progLog.shift();
  if (progBar) progBar.style.width = (total ? Math.round(i / total * 100) : 0) + '%';
  if (progTxt) progTxt.textContent = total > 1
    ? '正在读取 ' + i + ' / ' + total + ' 张…'
    : '正在读取…';
  progEl.classList.add('on');
}
function progHide() { if (progEl) progEl.classList.remove('on'); }

` + "async function addFiles(files) {");
if (!s.includes(jsAnchor)) throw new Error('JS 锚点没找到');
s = s.replace(jsAnchor, jsAdd); n++;

/* D. 循环里改用进度条；结束后收掉 */
const oldLoop = CRLF(`    // 一次加十几张时要有进度：什么都不显示，用户会以为按钮没反应
    if (take.length > 2 && i < take.length - 1) {
      showHint('正在读取 ' + (i + 1) + ' / ' + take.length + ' 张…', 120000);
    }
`);
const newLoop = CRLF(`    // 进度条：一次加十几张时要看得出还剩多少
    progSet(i + 1, take.length);
`);
if (!s.includes(oldLoop)) throw new Error('循环锚点没找到');
s = s.replace(oldLoop, newLoop); n++;

const afterLoop = CRLF("  if (btnAdd) btnAdd.removeAttribute('aria-busy');\n");
const afterLoopNew = CRLF(`  if (btnAdd) btnAdd.removeAttribute('aria-busy');
  progSet(take.length, take.length);          // 走到 100% 再收，避免 96% 直接消失
  setTimeout(progHide, 240);
`);
if (!s.includes(afterLoop)) throw new Error('循环后锚点没找到');
s = s.replace(afterLoop, afterLoopNew); n++;

/* E. 空/失败早退时也要收掉进度条 */
const early = CRLF(`    showHint(notImage ? ('这 ' + notImage + ' 个文件不是照片，没能加进来。') : '没有可用的照片。');
    return;`);
const earlyNew = CRLF(`    progHide();
    showHint(notImage ? ('这 ' + notImage + ' 个文件不是照片，没能加进来。') : '没有可用的照片。');
    return;`);
if (!s.includes(early)) throw new Error('早退锚点没找到');
s = s.replace(early, earlyNew); n++;

/* F. __dbg 暴露进度日志，测试可断言 */
const dbgAnchor = CRLF("  wallKey: function () { return wallKey; },");
if (!s.includes(dbgAnchor)) throw new Error('__dbg 锚点没找到');
s = s.replace(dbgAnchor, CRLF(`  wallKey: function () { return wallKey; },
  progLog: function () { return progLog.slice(); },`)); n++;

fs.writeFileSync(F, s, 'utf8');
console.log('patched', n, 'spots, bytes ->', s.length);
