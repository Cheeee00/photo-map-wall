# TIPS · 这个项目里踩过的坑

> 都是「当时很懵、知道原因后很傻」的那种。按主题分组，新坑往后加。

---

## GitHub 推送

### gh_push.ps1 的 summary 不能当验收

它最后打印 `summary: added=N updated=M skipped=K`，但：

- N+M+K **常常不等于** staged 文件数（出现过 42 vs 57）；
- 说 `updated=2` 也可能**根本没落地**（第一轮推完 README 在 remote 上还是旧字节数）。

**唯一可信的验收是重拉 tree API 逐文件比大小** —— 已经固化成 `tools/check_github.mjs`。这次就是靠它发现 `functions/api/wall/[[path]].js`（文件名含方括号）压根没上传上去。

发现不一致就原样再推一次（接口是幂等的），第二轮通常才带上。

### `.gitignore` 写了不等于从没入库

`dist/`、`.wrangler/`、`test/shots/` 都在 `.gitignore` 里，但它们**早于那条规则**就已被提交过，
之后一直躺在远端。本地新 clone 看不到、`git status` 也干净，只有拉 tree API 逐条比才暴露：
一次比对显示 GitHub 522 个文件 vs 本地 87 个，多出来的是 435 个 `.wrangler` 状态库与截图。
`tools/check_github.mjs` 现在把这类路径归入「残留的应删路径，不计入结论」——
否则 435 行噪音会把「业务文件到底同步没同步」的答案埋掉。清理用
`tools/stage_push.ps1 -DeleteOnly -Delete @('<路径>')`。

### 文件名含方括号时 Copy-Item 会当通配符

`functions/api/wall/[[path]].js` 里的 `[[path]]` 在 `-Path` 参数下被当通配符匹配（匹配 `p`/`a`/`t`/`h` 中任一字符），于是文件被静默跳过。**必须用 `-LiteralPath`**。

### 用 fetch 的脚本退出码会被 libuv 断言污染

Node 24 的全局 `fetch` 走 keep-alive 连接池，进程退出时会在 libuv 里断言失败：
`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`，退出码被改成 1（或 `0xC0000409`）——
**跟「核对失败」的退出码一模一样**，极易误判。`tools/check_github.mjs` 改走 `curl.exe` 才干净。

****`! FAILED` 也可能是假的** —— 报 `"sha" wasn't supplied` 时，多半是读远端元信息的那次 GET 没回来，于是它带着空的 sha 去 PUT（必然 400），而**文件内容其实早就一致**。所以两边都不能信：不信 summary，也不信 FAILED，只信 `node tools/check_github.mjs`。

**复核不能只看 summary 行****：`gh_push.ps1` 对失败的单个文件会打一行 `  ! <path> FAILED: <msg>`，而 `summary: added/updated/skipped` 里**不包含失败数**。`Select-Object -Last 4` 之类只看尾巴就会把失败吃掉——2026-10-28 就这么让 `src/index.template.html`（157 KB）连着两轮没上去，而 summary 看着正常。判据永远是 `node tools/check_github.mjs`；典型失败信息还有 ``"sha" wasn't supplied``（读远端元信息的 GET 没拿到 sha，PUT 就必然 400）和 ``does not match <sha>``（并发写冲突）。真卡住时用 ``curl -X PUT --data-binary @body.json`` 单文件推一次就能过 —— 2026-10-28 就是这样把 ``src/index.template.html`` 与三张 demo 图片补上去的。

## Windows / Node

**`.NET` 的 `[IO.File]` 不吃 PowerShell 的当前目录**：`cd` 之后写 `[IO.File]::ReadAllText('README.md')` 仍按进程初始目录解析，报 `Could not find file 'D:\DSH\创业项目\README.md'`。要么传绝对路径，要么干脆用 edit/write 工具改文件。

### PowerShell 5.1 没有 `Get-ChildItem -File` / `-Directory` 按类型过滤

那是 pwsh 6+ 才有的参数。本机 `pwsh` 实为 PS 5.1，写成 `Get-ChildItem -Recurse -File` 会直接
`A parameter cannot be found that matches parameter name 'File'`。
而且**它藏在执行路径深处** —— `tools/stage_push.ps1` 只在带 `-Delete` 时才走到这一行，
所以「平时跑得好好的脚本，某天传了新参数就崩」。改成
`Get-ChildItem -Path $d -Recurse | Where-Object { Test-Path -LiteralPath $_.FullName -PathType Leaf }`。

### `[string[]]` 参数从命令行传单个字符串会被当数组的一个元素

`-Delete 'dist/index.html'` 与 `-Delete @('dist/index.html')` 在「只有一个文件」时恰好等价，
但**语义完全不同**；一旦有人写成 `-Delete 'a,b'` 就变成一个叫 `a,b` 的文件名，静默不删。
脚本里凡是 `[string[]]` 都应在注释里写清「必须用 `@(...)`」。

### 删「刚被浏览器写完的图片」会让 node 硬崩

`fs.rmSync()` 一个刚下载完的 PNG，node 进程会以 **`0xC0000409`（`__fastfail`）** 退出，**没有任何堆栈、没有任何输出**。

- 表现：脚本一行输出都没有，退出码是个负数（PowerShell 里显示 `exit=-1073740791`）。
- 更坑的是：如果 stdout 走的是管道，`console.log` 的内容是异步缓冲的，**崩溃时整段丢失** —— 你会以为脚本连第一步都没跑到。
- 定位方法：把每一步用 `fs.appendFileSync(marker, '阶段名\n')` 同步写进一个标记文件，崩完看最后一条。
- 修法：别删。**每轮下载换一个新的子目录**，谁也不用删。

### `try / finally` 里报结果会吞掉异常

```js
// ✗ 错的：中途抛错时 pass 仍是 true，退出码 0，看起来「全绿」
try { ... } finally { const pass = t.report(); process.exit(pass ? 0 : 1); }

// ✓ 对的
let fatal = null;
try { ... } catch (e) { fatal = e; }
finally { const pass = t.report(); process.exit(pass && !fatal ? 0 : 1); }
```

这个坑让一份测试白跑了 19 项就报「全部通过」，后面的用例根本没执行。

### `pwsh` 工具其实是 Windows PowerShell 5.1

- 读文件必须 `-Encoding UTF8`，否则中文乱码、行数也错。
- **不要用 `Get-Content -Raw | -replace | Set-Content -Encoding UTF8` 改 UTF-8 源码** —— PS 5.1 默认按 GBK 读，中文注释会和下一行粘成一行，直接把代码注释掉。改源码一律用编辑工具。
- 提权脚本一律纯 ASCII。

---

## Chrome DevTools Protocol

### 响应是两层 result

```js
const m = await send('Runtime.evaluate', { expression, returnByValue: true });
m.result.result.value      // ← 值在这里
m.result.exceptionDetails  // ← 异常在这里
```

写成一层时所有 `evaluate` 都返回 `undefined`，看起来像「页面里没有这个变量」，很容易往页面代码上怀疑。

### `DOM.getDocument` 之前必须 `DOM.enable`

不调的话返回空，接着就是 `Cannot read properties of undefined (reading 'root')`。

### `Emulation.setDeviceMetricsOverride` 之后要等防抖

页面 resize 响应有 150 ms 防抖 + 重建，紧接着读数据会读到旧状态。测试里统一等 420 ms（或显式传 `settle`）。

### headless Chrome 往 `X:` 盘下载一律 canceled

换到 `C:` 的临时目录就正常。`Page.setDownloadBehavior` 已废弃，用 `Browser.setDownloadBehavior`。

---

## SVG / 画布

### `getBBox()` 给的是元素自身坐标系

判断照片重叠时直接比 `getBBox()` 全都是 `{x:0,y:0}` —— 必须用 `getCTM()` 把四角变换到画布坐标。

更隐蔽的是：`getCTM()` 是「元素 → 屏幕」，含窗口缩放，所以还得再乘 `board.getCTM().inverse()` 才落回画布坐标。另外 `getCTM().toString()` 得到的是 `[object SVGMatrix]`，不能 `parse`，要自己取 `a/b/c/d/e/f` 构造 `new DOMMatrix([...])`。

### `defs` 里的 id 在重建后会失效

重建画布时如果 `defsEl` 是 `const`，旧的渐变/滤镜会被一起清掉，之后的元素引用到不存在的 id → 直接变成纯黑或透明。`defsEl` 必须是 `let` 并在 `rebuildCanvas()` 里重建。

### 放大后地图被卡片边界硬裁

`clipPath` 裁出来的直边很显眼。改成在四边各叠一层「边缘不透明 → 内部透明」的渐变。

---

## 投影与地理

### 墨卡托里纬度越高 `v` 越**负**

`v = -ln(tan(π/4 + lat·π/360))·180/π`，所以 bbox 的 `v0` 是**最北**、`v1` 是**最南**。用 `v1` 判断「这块是不是南海诸岛」会把整个中国大陆判进去 —— 表现是主图上中国消失了，反而在小图里出现一个中国。

### Douglas-Peucker 容差比要素本身还大时，要素会整个消失

简化 35 个省级面时澳门被抹掉了（容差 0.055°，澳门比这还小）。修法：先记下每个要素面积最大的环，面积过滤后若为空就用该环并以 `TOL/12` 重新简化。

### 宁可显示省名，也不编一个不存在的城市

40 个城市之外的地方，`locateLabel()` 返回省名而不是「最近城市」—— 把一张那曲的照片标成「拉萨」是撒谎。

---

## 排布算法

### 「按方位角排序」在多列时天然交错

照片沿走廊排布时，只要一列放不下需要第二列，按角度排序的两列会互相穿越。正确的条件是**照片顺序匹配图钉的位置顺序**（右侧/左侧按纬度、上侧/下侧按经度），不是匹配地图上的角度。

### 自检和排布必须用同一个求交函数

排布用 16 段采样 + `t>0.002`，自检用 14 段 + `t>0.001` —— 同一对线，一边判交叉一边判不交叉，于是「内部算出 0 交叉，实测却报 1」。自检要直接调排布用的那个函数。

### 2-opt 的 delta 必须是同一量纲

用「涉及 i/j 的线对交叉数」当作 delta，和全局交叉数比，单调性不成立，会来回震荡永不收敛。必须每轮全量评估。

---

## 触屏 / iOS

### `touch-action:none` 是拖拽的前提

画布要能 pointer 拖动就必须禁掉浏览器默认手势，否则手指一动页面就滚。

### `100vh` 在 iOS Safari 上比可视区高

地址栏和 home 条会压住底部内容。用 `100dvh` 并给 `100vh` 兜底，底部再加 `env(safe-area-inset-bottom)`。

### 桌面那条 `translateX(-50%)` 在窄屏会跳

窄屏把 `#ui` 改成 `left/right:8px` + `transform:none` 之后，如果还有 `#ui.hidden{transform:translateX(-50%)...}` 这种规则，淡出时整条会往右跳半屏。
