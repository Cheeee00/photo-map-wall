/**
 * 核对 GitHub 上的仓库与本地工作区是否一致（逐文件比大小）。
 *
 *   node tools/check_github.mjs
 *
 * 为什么要这个：gh_push.ps1 会打印 summary: added=N updated=M skipped=K，
 * 但 N+M+K 常常不等于 staged 文件数，而且「updated=2」也可能没真的落地。
 * 唯一可信的验收就是重新拉一次 tree API 逐文件比对。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'Cheeee00/photo-map-wall';
const BRANCH = 'main';

const skipTop = ['.wrangler', 'dist', '.git'];
const skipSub = ['test/shots', 'test/_tmp'];

function walk(dir, rel, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (skipTop.includes(r) || skipSub.includes(r)) continue;
    if (e.isDirectory()) walk(path.join(dir, e.name), r, out);
    else out.push([r, fs.statSync(path.join(dir, e.name)).size]);
  }
}

const localList = [];
walk(ROOT, '', localList);
const local = new Map(localList);

const tokenFile = 'C:/Users/ChenLong/.dsh/secrets/github-token-full.txt';
const token = fs.readFileSync(tokenFile, 'utf8').trim();

const res = await fetch(`https://api.github.com/repos/${REPO}/git/trees/${BRANCH}?recursive=1`, {
  headers: { Authorization: 'Bearer ' + token, 'User-Agent': 'photo-map-wall-check', Accept: 'application/vnd.github+json' },
});
if (!res.ok) throw new Error('tree API ' + res.status + ' ' + (await res.text()).slice(0, 200));
const tree = await res.json();
if (tree.truncated) console.log('注意：tree 被截断，比对可能不全');

const remote = new Map();
for (const n of tree.tree) {
  if (n.type !== 'blob') continue;
  remote.set(n.path, n.size);
}

const onlyLocal = [], onlyRemote = [], diffSize = [];
for (const [p, s] of local) {
  if (!remote.has(p)) onlyLocal.push(p);
  else if (remote.get(p) !== s) diffSize.push(`${p}: 本地 ${s} / GitHub ${remote.get(p)}`);
}
for (const p of remote.keys()) if (!local.has(p)) onlyRemote.push(p);

console.log(`本地 ${local.size} 个文件 / GitHub ${remote.size} 个文件`);
if (onlyLocal.length) console.log('只在本地（未上传）：\n  ' + onlyLocal.join('\n  '));
if (onlyRemote.length) console.log('只在 GitHub（本地已删）：\n  ' + onlyRemote.join('\n  '));
if (diffSize.length) console.log('大小不一致：\n  ' + diffSize.join('\n  '));

const ok = !onlyLocal.length && !onlyRemote.length && !diffSize.length;
console.log(ok ? 'GitHub 与本地一致 ✅' : 'GitHub 与本地不一致 ❌');
process.exit(ok ? 0 : 1);
