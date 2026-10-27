/**
 * 生成 docs/ 里的配图 —— 不手截，全部由脚本产出，随时可重跑。
 *
 *   node tools/make_docs_shots.mjs
 *
 * 做法要点：
 *  - 用真实照片（assets/demo5 的 5 张）当载体，坐标用 test/_exif.mjs 的 injectGps() 注进去，
 *    所以截图里是真实照片配「用于演示的坐标」，不会为了配图伪造拍摄记录。
 *  - 截图先在页面里降到目标宽度、再转 JPEG（q 0.86），所以仓库里只存几百 KB 的图。
 *  - 手机那张走 Emulation.setDeviceMetricsOverride，跟 cdp-mobile 的口径一致。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from '../test/_cdp.mjs';
import { injectGps } from '../test/_exif.mjs';
import { ROOT, TMP, PAGE_URL, SHOTS_DIR } from '../test/_env.mjs';

const DOCS = path.join(ROOT, 'docs');
const DEMO = path.join(ROOT, 'assets/demo5');
const OUTDIR = path.join(TMP, 'docsimgs');

// 演示用坐标：一组国内行程（15 张），一组出国（5 张）
const CN_TRIP = [
  ['北京', 39.9042, 116.4074], ['成都', 30.5728, 104.0668], ['厦门', 24.4798, 118.0894],
  ['哈尔滨', 45.8038, 126.5349], ['拉萨', 29.6450, 91.1409], ['三亚', 18.2528, 109.5119],
  ['西安', 34.3416, 108.9398], ['上海', 31.2304, 121.4737], ['乌鲁木齐', 43.7930, 87.6168],
  ['昆明', 24.8801, 102.8329], ['青岛', 36.0671, 120.3826], ['长沙', 28.2282, 112.9388],
  ['广州', 23.1291, 113.2644], ['武汉', 30.5928, 114.3055], ['沈阳', 41.8057, 123.4315],
];
const WORLD_TRIP = [
  ['巴黎', 48.8566, 2.3522], ['纽约', 40.7128, -74.0060], ['东京', 35.6762, 139.6503],
  ['悉尼', -33.8688, 151.2093], ['北京', 39.9042, 116.4074],
];

function buildFiles(trip) {
  fs.rmSync(OUTDIR, { recursive: true, force: true });
  fs.mkdirSync(OUTDIR, { recursive: true });
  const srcs = fs.readdirSync(DEMO).filter((f) => /\.jpe?g$/i.test(f)).sort();
  return trip.map(([name, lat, lon], i) => {
    const src = fs.readFileSync(path.join(DEMO, srcs[i % srcs.length]));
    const out = path.join(OUTDIR, String(i + 1).padStart(2, '0') + '-' + name + '.jpg');
    fs.writeFileSync(out, injectGps(src, lat, lon));
    return out;
  });
}

/** 把刚截的 PNG 交给页面里的 canvas，降采样后转 JPEG 落盘。 */
async function saveJpg(t, pngPath, outName, targetW, quality = 0.86) {
  const dataUrl = 'data:image/png;base64,' + fs.readFileSync(pngPath).toString('base64');
  const expr = `(function(){return new Promise(function(res,rej){
    const im=new Image();
    im.onload=function(){
      const k=Math.min(1, ${targetW}/im.naturalWidth);
      const c=document.createElement('canvas');
      c.width=Math.round(im.naturalWidth*k); c.height=Math.round(im.naturalHeight*k);
      const x=c.getContext('2d');
      x.imageSmoothingQuality='high';
      x.drawImage(im,0,0,c.width,c.height);
      res(c.toDataURL('image/jpeg', ${quality}));
    };
    im.onerror=function(){rej(new Error('img load fail'));};
    im.src=${JSON.stringify(dataUrl)};
  });})()`;
  const b64 = (await t.evaluate(expr)).replace(/^data:image\/jpeg;base64,/, '');
  const out = path.join(DOCS, outName);
  fs.writeFileSync(out, Buffer.from(b64, 'base64'));
  const kb = (fs.statSync(out).size / 1024).toFixed(0);
  console.log(`  wrote docs/${outName}  ${kb} KB`);
}

async function clearStore(t) {
  await t.goto(PAGE_URL);
  await t.evaluate('indexedDB.deleteDatabase("photo-map-wall"); localStorage.clear(); 1');
  await t.goto(PAGE_URL);
}

async function main() {
  console.log('启动 Chrome（1600×1000）');
  const t = await launch({ port: 9711, profile: 'mwalldocs', window: [1600, 1000] });

  // ① 示例状态：5 张内置照片围着一块中国地图
  await clearStore(t);
  await t.sleep(400);
  await saveJpg(t, await t.screenshot('D1-demo.png'), '01-wall.jpg', 1400);

  // ② 15 张国内行程
  const cn = buildFiles(CN_TRIP);
  await t.setFiles('#file', cn);
  await t.sleep(2600);
  await saveJpg(t, await t.screenshot('D2-fifteen.png'), '02-fifteen.jpg', 1400);

  // ③ 大图预览
  await t.evaluate("document.querySelector('#gPhotos > g').dispatchEvent(new MouseEvent('click',{bubbles:true})); 1");
  await t.sleep(700);
  await saveJpg(t, await t.screenshot('D3-viewer.png'), '03-viewer.jpg', 1200);
  await t.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); 1");
  await t.sleep(300);

  // ④ 宽窗口：画布随窗口变横，照片铺到更宽的两侧
  await t.resize(2400, 1050);
  await t.sleep(900);
  await saveJpg(t, await t.screenshot('D4-wide.png'), '04-wide.jpg', 1500);

  // ⑤ 窄窗口（竖屏桌面）：画布转竖，地图居中
  await t.resize(900, 1500);
  await t.sleep(900);
  await saveJpg(t, await t.screenshot('D5-narrow.png'), '05-narrow.jpg', 820);

  // ⑥ 手机视口
  await t.resize(393, 852, { dsf: 2, mobile: true, touch: true });
  await t.sleep(900);
  await saveJpg(t, await t.screenshot('D6-mobile.png'), '06-mobile.jpg', 620);

  // ⑦ 全球档：5 张出国照片，自动切到世界地图
  await t.resize(1600, 1000);
  await t.sleep(700);
  await clearStore(t);
  const world = buildFiles(WORLD_TRIP);
  await t.setFiles('#file', world);
  await t.sleep(2600);
  await saveJpg(t, await t.screenshot('D7-world.png'), '07-world.jpg', 1400);

  const names = fs.readdirSync(DOCS).filter((f) => f.endsWith('.jpg')).sort();
  console.log('docs/ 现在有：' + names.join(' '));
  await t.close();
}

main().catch((e) => { console.error('FATAL', e && e.message); process.exit(1); });
