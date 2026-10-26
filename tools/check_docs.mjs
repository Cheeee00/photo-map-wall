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
    if (!/\.(mjs|js|md|jpg|png|json|html|py|geojson|ps1|txt)$/.test(c)) continue;
    if (/^(node|npm|npx|python|git|cd|docker|wrangler)\s/.test(c)) continue;   // 命令行不是路径
    if (/^[A-Za-z]:/.test(c) || c.startsWith('<') || c.includes('*')) continue;
    if (FUTURE.has(c)) continue;
    if (!exists(c)) { console.log(`PATH   ${md}: ${c}`); bad++; }
  }
}

// 3) 容易过期的数字：只有 README 是「当前事实」，必须等于实际产物；
//    worklog / acceptance 里写死的字节数是**当时那一轮**的记录，保留不改。
const actual = fs.statSync(path.join(ROOT, 'index.html')).size;
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const sizes = [...readme.matchAll(/index\.html[^\n]{0,40}?([\d]{1,3}(?:,\d{3})+|\d{6,})\s*B/g)].map((m) => Number(m[1].replace(/,/g, '')));
const stale = [...new Set(sizes)].filter((n) => n !== actual);
console.log(`SIZE   README 提到的 index.html 字节数 = ${JSON.stringify([...new Set(sizes)])}，实际 = ${actual}${stale.length ? '  ← 对不上' : '  ✓'}`);
bad += stale.length;

// 4) 占位符数量：build.mjs 里实际替换几个，README 说几个
const build = fs.readFileSync(path.join(ROOT, 'src/build.mjs'), 'utf8');
const ph = [...new Set([...build.matchAll(/'(\/\/__[A-Z_]+__|"__[A-Z_]+__"|\/\*__[A-Z_]+__\*\/\[\])/g)].map((m) => m[1]))];
const claim = /把([一二三四五六七八九十])个占位符/.exec(readme);
const cn = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
console.log(`PLACE  build.mjs 里 ${ph.length} 个：${ph.join(' ')}；README 说「${claim ? claim[1] : '?'}个」${claim && cn[claim[1]] === ph.length ? '  ✓' : '  ← 不一致'}`);
if (!claim || cn[claim[1]] !== ph.length) bad++;

console.log(bad ? `\n有问题 ${bad} 处` : '\n文档体检通过');
process.exit(bad ? 1 : 0);
