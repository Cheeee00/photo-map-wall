// 文档一致性体检（一次性工具，可复跑）：检查 README / docs / TODO / TIPS 里的
// 相对链接是否都指向真实文件、反引号里的路径是否都存在、以及几处容易过期的数字。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MDS = ['README.md', 'TODO.md', 'TIPS.md']
  .concat(fs.readdirSync(path.join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => 'docs/' + f));

const exists = (rel) => fs.existsSync(path.join(ROOT, rel.replace(/\\/g, '/')));
// 文档里合法地引用「还没入库」的文件（TODO 的下一步、备份服务待搬进仓库的测试），不算断链。
const FUTURE = new Set(['test/security.test.mjs']);
let bad = 0;

for (const md of MDS) {
  const text = fs.readFileSync(path.join(ROOT, md), 'utf8');

  // 1) markdown 链接与图片
  const links = [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);
  for (const l of links) {
    if (/^(https?:|mailto:|#)/.test(l)) continue;
    if (!exists(l)) { console.log(`LINK   ${md}: ${l}`); bad++; }
  }

  // 2) 反引号里的仓库内路径。TODO 例外：它写的本来就是**还没做**的文件，不存在是正常的。
  if (md === 'TODO.md') continue;
  const codes = [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
  for (const c of codes) {
    if (!/[/\\]/.test(c)) continue;
    // 命令行：不校验整条命令，但把它指向的仓库文件拿出来校验。
    // （以前这里直接 continue，于是 README 列了两个早就不存在的测试脚本，体检照样通过。）
    const cmd = /^(node|npm|npx|python|git|cd|docker|wrangler)\s+(.+)$/.exec(c);
    const target = cmd ? cmd[2].trim().split(/\s+/)[0] : c;
    if (cmd && /^(--|run$|run\s|install|test$|pages|deploy|--yes)/.test(target)) continue;   // 子命令不是路径
    if (!/\.(mjs|js|md|jpg|png|json|html|py|geojson|ps1|txt)$/.test(target)) continue;
    if (/^[A-Za-z]:/.test(target) || target.startsWith('<') || target.includes('*')) continue;
    if (FUTURE.has(target)) continue;
    if (!exists(target)) { console.log(`PATH   ${md}: ${target}${cmd ? '（命令行里引用）' : ''}`); bad++; }
  }
}

// 3) 容易过期的数字：只有 README 是「当前事实」，必须等于实际产物；
//    worklog / acceptance 里写死的字节数是**当时那一轮**的记录，保留不改。
//    注意：README 不强制标注字节数（每轮都会变），但**一旦标了就必须对**；
//    以前这里在正则一条都没匹配到时也打 ✓，等于空转，已改成显式 SKIP。
const actual = fs.statSync(path.join(ROOT, 'index.html')).size;
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const sizes = [...readme.matchAll(/index\.html[^\n]{0,40}?([\d]{1,3}(?:,\d{3})+|\d{6,})\s*B/g)].map((m) => Number(m[1].replace(/,/g, '')));
const stale = [...new Set(sizes)].filter((n) => n !== actual);
if (!sizes.length) console.log(`SIZE   README 未标注 index.html 字节数（跳过；实际 = ${actual}）`);
else console.log(`SIZE   README 提到的 index.html 字节数 = ${JSON.stringify([...new Set(sizes)])}，实际 = ${actual}${stale.length ? '  ← 对不上' : '  ✓'}`);
bad += stale.length;

// 3b) 城市表条数：README 说了个数就必须等于代码里的
const tpl = fs.readFileSync(path.join(ROOT, 'src/index.template.html'), 'utf8');
const cityM = /const CITIES\s*=\s*\[([\s\S]*?)\n\];/.exec(tpl);
const cityN = cityM ? (cityM[1].match(/\[\s*'/g) || []).length : -1;
const cityClaim = /(\d+)\s*个城市/.exec(readme);
if (cityClaim && Number(cityClaim[1]) !== cityN) {
  console.log(`CITY   README 说 ${cityClaim[1]} 个城市，代码里有 ${cityN} 个  ← 不一致`);
  bad++;
} else if (cityM) {
  console.log(`CITY   城市表 ${cityN} 条，README ${cityClaim ? '说 ' + cityClaim[1] + ' 个  ✓' : '未标数（跳过）'}`);
}

// 4) 占位符数量：build.mjs 里实际替换几个，README 说几个
const build = fs.readFileSync(path.join(ROOT, 'src/build.mjs'), 'utf8');
const ph = [...new Set([...build.matchAll(/'(\/\/__[A-Z_]+__|"__[A-Z_]+__"|\/\*__[A-Z_]+__\*\/\[\])/g)].map((m) => m[1]))];
const claim = /把([一二三四五六七八九十])个占位符/.exec(readme);
const cn = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
console.log(`PLACE  build.mjs 里 ${ph.length} 个：${ph.join(' ')}；README 说「${claim ? claim[1] : '?'}个」${claim && cn[claim[1]] === ph.length ? '  ✓' : '  ← 不一致'}`);
if (!claim || cn[claim[1]] !== ph.length) bad++;

console.log(bad ? `\n有问题 ${bad} 处` : '\n文档体检通过');
process.exit(bad ? 1 : 0);
