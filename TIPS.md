# TIPS · 这个项目里踩过的坑

> 都是「当时很懵、知道原因后很傻」的那种。按主题分组，新坑往后加。

---

## Windows / Node

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
