# 工作记录

> 每条需求对应一节，写明「做了什么 + 用了哪个脚本 + 结论」。
> 结论要能被复跑验证，脚本必须随本文件一起提交 —— 指向不出脚本的结论不算数。

---

## R1-R2 · 11:00 2026-10-25 · 从零把墙做出来

**做了什么**

| # | 动作 | 脚本 / 文件 |
|---|---|---|
| 1 | 阿里云 DataV 国界 GeoJSON → Douglas-Peucker 简化成 17 环 1578 点 | `tools/gen_provinces.mjs`（其中 `china_coords.js` 由同源数据一次性生成） |
| 2 | 拉 `100000_full.json`（35 个省级面），逐要素简化，输出 4180 点 | `tools/gen_provinces.mjs` → `data/provinces.js` |
| 3 | 写单文件应用模板（SVG 全量绘制、墨卡托投影、pin/yarn/photo 三层） | `src/index.template.html` |
| 4 | 构建脚本替换占位符产出 `index.html` | `src/build.mjs` |
| 5 | 冒烟测试：双击零异常、`__selfTest()` 断言、导出落盘 | `test/cdp-shot.mjs`、`test/cdp15.mjs` |

**踩到的坑**

- **省界简化把澳门整个抹掉了**：Douglas-Peucker 容差（0.055°）比澳门本身还大。修法是先记下每个要素面积最大的环，面积过滤后若为空就用该环并以 `TOL/12` 重简。最终 35 省齐全，70,603 B（后来 `gen_labels.mjs` 补进省名标注点与内切半径，`provinces.js` 变 71,813 B）。
- **大陆被塞进了南海诸岛的小图**：`v = mercY(lat)`，纬度越高 `v` 越负，所以 bbox 的 `v0` 才是「最北」。原来用 `v1` 判断，把整个中国大陆判成了南海诸岛。改用 `mercLatOf(b.v0)`。
- **CDP 响应是两层 `result`**：`m.result.result.value`。写成一层时所有 evaluate 都返回 `undefined`，排查了很久。

---

## R3 · 2026-10-25 深夜 · 四点重做

**做了什么**

| # | 动作 | 脚本 / 文件 |
|---|---|---|
| 1 | 真实木纹：Openverse 抓 CC0 照片 → 裁 1.6 比例 → 压暗调棕 → JPEG q72 | PowerShell + System.Drawing |
| 2 | 零依赖 EXIF GPS 解析（APP1 → TIFF → GPS IFD → 度分秒） | `src/index.template.html` 内 `parseExifGps()` |
| 3 | 经纬度 → 就近城市（40 城）/ 省级面 PIP 判定 | `nearestCity()` / `provinceOf()` / `locateLabel()` |
| 4 | 排布从「右侧列打包」改成「绕地图一圈的走廊」 | `ringLayout()` → `corridorSlots()` |
| 5 | 合成 9 张带已知经纬度的 EXIF 样本做回归 | `test/gen-exif-cases.mjs`、`test/cdp-exif2.mjs`（解析器的隔离单测随旧工作目录留在本机，没入库） |

**关键结论：红线交叉的真正原因有三个，全都是「两处口径不一致」**

1. **排布用的是旧视图的图钉位置**：`addFiles` 里先 `renderPhotos()`（按当前视图算好零交叉），再 `fitToPins(true)` 用补间把视图挪走 —— 图钉全变了，排布立刻失效。改为「先把视图设成终态 → 排布 → 再动画过去」。
2. **2-opt 的 delta 算错**：局部计数 `c` 与全局 `bestC` 不同量纲，单调性不成立，会来回震荡。改成每轮全量评估所有候选交换、只接受严格改进。
3. **自检和排布用了不同的采样与阈值**：排布用 16 段采样 + `t>0.002`，自检用 14 段 + `t>0.001`，同一对线一边判交叉一边判不交叉。改成自检直接调排布用的 `yarnPath()` / `segCross()`。

另有第四处：同坐标的图钉做了水平错开，但只错开了「画针」，排布和自检仍读未错开的坐标。统一到 `p._pinCard` 之后才彻底归零。

**验证**：15 张 `crossings:0 issues:[]`；9 张 EXIF 全部 `gps:true` 且经纬度与期望一致。

---

## R4-R5 · 2026-10-26 · 毛毡板 + 实心地图件 + 真实示例

| # | 动作 | 脚本 / 文件 |
|---|---|---|
| 1 | ambientCG CC0 `Fabric034` 裁切调色成 1600×1000 毛毡底 | `assets/felt-final.jpg` |
| 2 | 删掉纸卡/白边/框线/四角钉，改成一块带投影与受光切边的芥末黄板件 | `buildCard()` |
| 3 | 省名锚点 + 内切圆半径（35 省），随缩放自动取舍字号 | `tools/gen_labels.mjs` |
| 4 | 5 张 HEIC → JPEG（保留 EXIF GPS），base64 内联为默认示例 | `tools/heic2jpg.py`、`src/build.mjs` |

**坑**：示例照片用 700px 转出来是 902 KB，内联后单文件逼近 2 MB。降到 460px / q64 后 143 KB，肉眼几乎无差。后来入库的 `assets/demo5` 换成更高画质的 5 张，共 281 KB（base64 后 375 KB），单文件仍在 1.2 MB 以内。

---

## R6 · 2026-10-26 · 四项交互（自适应 / 线在上 / 拉直 / 预览）

| # | 动作 | 关键点 |
|---|---|---|
| 1 | 画布随窗口比例 | `BW = BH0 * 可视宽 / 可视高`，写进 `viewBox`；窄屏把宽度钉在 830、改为加高 `BH` 得到竖幅画布 |
| 2 | 红线画在照片之上 | DOM 顺序：先 `layerPhotos` 再 `layerYarn` |
| 3 | 线拉直 | 删掉二次贝塞尔与 `sag`，改 17 点直线采样 |
| 4 | 点照片看大图 | 新增 `#viewer` 覆盖层（拍立得白边大图 + 地点下拉 + 回原位 + 移除） |

**坑**：`rebuildCanvas()` 要清空并重建 `defs`（`defsEl` 从 `const` 改 `let`），否则第二次 resize 后渐变、滤镜 id 全部失效。

---

## R9 · 2026-10-26 · iPhone Safari 三项缺陷

| # | 根因 | 修法 |
|---|---|---|
| 1 | 单张照片 `minSpan = 22` 等于把地图放大 3 倍 | `n===1 ? 58 : n<=3 ? 34 : 11`，并加「不低于基准缩放」的下限 |
| 2 | 窄屏 `BW` 被下限 700 顶住，`viewBox` 比例 ≠ 窗口比例 | 下限改 830，且撞下限时改为加高 `BH` |
| 3 | 工具条单行 465px > 393px | 窄屏折两行，按钮只留图标，`#btnAdd` 保留文字 |

**验证**：`test/cdp-mobile.mjs` 在 393×852 上全 PASS（画布 830×1580、地图占 84% 宽、工具条每个按钮都在视口内）。

---

## R10 · 2026-10-26 · 两档取景 + 不打扰视野

| # | 动作 | 关键点 |
|---|---|---|
| 1 | 顶部两个下拉：地图范围 / 缩放粒度（全部·省·城市） | 只有示例照片时粒度禁用并给出 title 提示 |
| 2 | 首次上传自动全览，之后**不再挪视野** | `isFirst = photos.length===0 或全是示例` |
| 3 | 有新照片在视野外时，「适应全部」亮红点呼吸 | `.btn.hasnew` + `@keyframes fitPulse`，`prefers-reduced-motion` 下关动画 |

**验证**：`test/cdp-ux.mjs` 28 项全 PASS，其中「二次上传视野位移量」实测 **0.00000**。

---

## R12 · 2026-10-27 · 稳定性测试与收尾

| # | 动作 | 脚本 |
|---|---|---|
| 1 | 12 种尺寸 × 示例/15 张 + 改窗抖动 + 增删 + 缩放边界 + 两档导出 | `test/cdp-stability.mjs`（37 项） |
| 2 | 交互契约回归 | `test/cdp-ux.mjs`（28 项） |
| 3 | HEIC 失败文案给出三条出路（Safari / 相机格式 / 分享成 JPEG） | `src/index.template.html` |
| 4 | 导出锚点挂到 DOM 再点（Firefox 对游离节点不生效） | `src/index.template.html` |

**踩到的坑（值得记住）**

- **删「刚被浏览器写完的图片」会让 node 以 `0xC0000409`（`__fastfail`）硬崩**，而且崩溃前 stdout 缓冲全丢 —— 表现为「一行输出都没有、退出码是个负数」。定位方法：把每一步用 `fs.appendFileSync` 同步写进一个标记文件，崩完看最后一条。修法是**每轮导出一个新目录，谁也不用删**。
- **`try/finally` 里报结果会吞掉异常**：`finally { const pass = report(); process.exit(pass?0:1) }` 在抛错时 `pass` 仍是 `true`，退出码 0，看起来全绿。必须 `catch(e){fatal=e}` + `process.exit(pass && !fatal)`。这个坑让一份测试白跑了 19 项就报「全部通过」。

---

## 交付 · 2026-10-27 · 重新部署 + 线上冒烟

| # | 动作 | 命令 / 文件 |
|---|---|---|
| 1 | 用最新源码重建 | `node src/build.mjs` → `index.html` 987,052 B |
| 2 | 同步到发布目录并上线 | `npx wrangler pages deploy dist --project-name=photo-map-wall --branch=main` |
| 3 | 校验「线上字节 == 本地构建」 | 本地 SHA256 `3BF67CE4…CEC4`，`*.pages.dev` 完全一致；自定义域只多出 Cloudflare 自动注入的 Web Analytics beacon（367 B），正文一致 |
| 4 | 新增线上冒烟测试 | `test/cdp-live.mjs`（17 项，直接打公网 URL） |
| 5 | 公开文档脱敏 | 内网 IP、私有目录路径从 `TODO.md` / `docs/acceptance.md` 中移除 |

**踩到的坑**

- **`npx ... | Select-Object` 会把 node 的 stderr 吞成一行 `NativeCommandError`**，看不到真正的失败原因。改成 `cmd /c "npx ... > %TEMP%\log 2>&1"` 才拿到完整输出 —— 而实际是**部署成功**，只是 PowerShell 把 stderr 当异常报了。
- Pages 说「Uploaded 0 files (1 already uploaded)」是**正常去重**（内容哈希未变），不代表没部署；判据要看 `Deployment complete` 的 URL + 线上内容哈希。
---

## R13 · 2026-10-27 · 刷新不丢照片（IndexedDB）

| # | 动作 | 关键点 |
|---|---|---|
| 1 | `src/index.template.html` 新增 IndexedDB 层 | `DB_NAME='photo-map-wall'`、`STORE='photos'`、`keyPath:'uid'`；`openDB()` 单例 + `idbRun(mode, fn)` 统一包装，任何一步失败返回 `null` |
| 2 | 存的是**原图 Blob**，不是 base64 | 省 1/3 体积；复原时用 `FileReader` 读回 dataURL，导出的序列化链路与刚上传时完全一致 |
| 3 | 四个写入点 | 加照片 `savePhotoRec(p, file)` / 拖针 `patchPhotoRec(p)`（只更新经纬度，不重存 Blob）/ 改城市 `patchPhotoRec` / 删照片 `dropPhotoRec(uid)` |
| 4 | 开机复原 | `boot()` 末尾 `restoreFromDB()`：没有记录就继续放示例；有就替换 `photos` 并 `renderPhotos + resetView`，再提示「已恢复上次的 N 张」 |
| 5 | 「示例」按钮 = 清空 | `clearRecs()` 后再 `useDemo()`，避免下次打开又被旧记录复活 |
| 6 | 测试 | `test/cdp-persist.mjs`（自带静态服务器，走 `http://` 才有持久配额） |

**踩到的坑**

- **`file://` 是不透明源，没有 IndexedDB 持久配额**。双击打开时持久化会静默失效，线上 `https://` 正常。所以持久化测试必须自带 HTTP 服务器，不能像其它用例那样直接 `file://`。这也是为什么代码里所有 IDB 调用一律 `catch → null`：不能因为存不了就把页面搞崩。
- **第一个断言就错在 import 上**：`launch/sleep` 在 `test/_cdp.mjs`，`ROOT/IMGS15` 在 `test/_env.mjs`，混在一个 `import` 里会直接 `SyntaxError`（ESM 不给你运行时才发现的余地）。
- 存 Blob 而不是 dataURL 还有一个隐性好处：`patchPhotoRec` 改地点时只需 `get → 改三个字段 → put`，不用把几 MB 的 base64 重新写一遍。

---

## R14 · 2026-10-27 · 世界地图

| # | 动作 | 关键点 |
|---|---|---|
| 1 | 数据源 | Natural Earth 110m `admin_0_countries`（CC0），经 jsDelivr 镜像取回，缓存在 `data/world_raw.geojson`（838,726 B，`--refetch` 可强制更新） |
| 2 | 新脚本 `tools/gen_world.mjs` | 每国只取外环 → 自适应 Douglas-Peucker（`tol = clamp(span/170, 0.04, 0.80)`、`minArea = max(0.02, span²/40000)`）→ 坐标 2 位小数 → `data/world.js`：**175 国 / 7,083 点 / 109,594 B** |
| 3 | 名称规范化 | Natural Earth 的中文名是官方全称（印出来是「中华人民共和国」），加 `SHORT` 表改通称；南极洲、法属南部领地跳过（贴边一圈会把地图拉扁） |
| 4 | 标签字号按「主陆块」定 | `r` 取最大外环的外接框短边 —— 否则法国（含海外省）比德国还大、字号离谱，把德国的名字挤没 |
| 5 | 模板加第二个范围 | `scope='cn'|'world'`、`CN_BOX/WLD_BOX`、`scopeBox()/clampLon()/clampLat()`、`inChina()`、`countryOf()` |
| 6 | 地图件双套地物 | `provUV`（省界，仅中国档）/ `worldUV`（各国轮廓，仅全球档）；全球档 0.9px 画全部陆地轮廓，中国单独 1.8px 加粗 |
| 7 | 地点命名 | `locateLabel()` 先判国界：国外直接用国家名，国内才走「城市 → 省」 |
| 8 | 越界照片不再被裁 | GPS 存真实经纬度；上传时发现国外就自动切「全球」档；只有画针时才 `clampLon/clampLat` |
| 9 | 国名防挤 | 按主陆块面积从大到小占位；撞了**先挪（11 个候选位）→ 再缩（1 / .86 / .74 / .64）→ 才不出** |
| 10 | 测试 | `test/cdp-world.mjs`（22 项）+ `test/_exif.mjs`（EXIF 合成器抽出复用） |

**踩到的坑**

- **第一次跑就抓到「中华人民共和国」印在地图上** —— 断言里查「有『中国』以外的名字」时，全称让地图看起来像一张政区说明书。名称规范化和数据一起生成，不在模板里兜。
- **`r` 用整国外接框是错的**：法国含法属圭亚那，`r` 算成 24.5（中国才 16.6），标签字号被撑到上限，直接压住德国；改成「最大外环」后 `r=4.4`，欧洲才有法/德/英/意四个名字。
- **撞了就删太粗暴**：删掉法国的版本测试也能过（只断言「有中国以外的名字」），是加了一条「常见国家名都还在」的硬断言才暴露。断言要写**具体该有的东西**，不能只写「不空」。
- **测试自己污染了状态**：上一轮跑完在 IndexedDB 里留了 5 张国外照片，下一轮开机自动复原 → 默认档变成「全球」、上传后变 10 张。修法不是关持久化，而是**开跑先点一次「示例」**（既清库又回到已知起点）。
- **`useDemo()` 顺手成了产品修复**：示例照片全在国内，若用户上一轮停在「全球」，点「示例」后范围要跟着回「中国」，否则会看到一张小得可怜的中国地图。

---

## 文档整理 · 2026-10-27 · 交付前对账

这一轮没改产品代码，只把文档和仓库跟代码对齐。

| # | 动作 | 关键点 |
|---|---|---|
| 1 | 核对线上与本地 | `https://4f390500.photo-map-wall.pages.dev` = 1,109,488 B，与本地 `index.html` 字节一致；自定义域多 367 B，是 Cloudflare 注入的 beacon |
| 2 | 核对仓库与本地 | 用 GitHub tree API 逐文件比：**54 个 blob，无「只在本地」、无「只在线上」、无大小差异** |
| 3 | 补第七张截图 | 新增 `test/cdp-docs.mjs` 生成 `docs/07-world.jpg`：拿 `assets/demo5` 的 5 张真照片，用 `_exif.mjs` 新增的 `injectGps()` 各注入一个国外坐标（巴黎/纽约/东京/悉尼/北京），上传后范围自动切全球、地点按国家命名、`crossings:0 issues:0` |
| 4 | 修 README 的过期事实 | ①「四个占位符」漏了 `//__WORLD_DATA__`，实际是五个 ②降档描述写「…, 84」但代码已到 42 且带 `cascadeLayout()` 兜底 ③仓库结构里 `data/`、`tools/` 没提世界国界 |
| 5 | 更新 TODO | 「截图靠手截」那条改成分项：全球档已自动生成，其余 6 张仍是手工，并写清全自动还差什么 |
| 6 | 新增 `tools/check_docs.mjs` | 文档体检：markdown 链接、反引号里的仓库路径、`build.mjs` 占位符数 vs README 的说法、README 里的 `index.html` 字节数 vs 实际产物。首跑抓到 4 类问题（3 个是误报，见下） |

**踩到的坑**

- **测试块截图不能直接进 README**：`test/shots/W3-world-photos.png` 里的照片是合成出来的纯蓝方块（`_exif.mjs` 早期只用 24×24 载体），当配图像坏图。造演示图的正确做法是**真照片 + 注入坐标**，而不是为了配图去伪造拍摄记录 —— 所以先抽出 `buildApp1()`，再加 `injectGps(jpegBuf, lat, lon)` 往真实 JPEG 的 SOI 后插 APP1。
- **PNG→JPG 仍在 Node 之外**：`test/gen-testimg.mjs` 有纯 Node 的 PNG 编码器，但没有 JPEG 编码器，所以转换这一步还是 pwsh + `System.Drawing`。这也是 TODO 里「截图全自动」没做完的原因之一。
- **文档体检的第一版一堆误报**：把 `node src/build.mjs` 这种命令行当成路径、把 worklog / acceptance 里「当时那一轮」的产物字节数当成「当前事实」、把 TODO 里还没创建的 `test/security.test.mjs` 当成缺失文件。逐类收窄判据（命令行前缀白名单、只有 README 参与字节数校验、TODO 跳路径检查）之后才是有用的检查 —— **校验器比被测对象更容易写错**。

---

## R15 · 布局算法重写（40 张以内红线不交叉）

**起因**：用户的要求本来就是「照片绕地图一圈、线与线之间不能交叉」。回归压测把这条承诺打穿了：30 张 6 处交叉、40 张 16 处；20/24 张更是直接掉进 `cascadeLayout()`，照片叠成一坨并且互相重叠、出界。

**做法的四次迭代**
1. **先怀疑优化器**：把局部计数的 delta 换成「每轮全量 `totalX()` 评估候选」，只接受交叉更少（并列时更短）的移动。30/40 张从 6/16 降到 6/16 —— 没用，说明问题在上游。
2. **再查分边**：打印每条走廊的槽位数与「放弃原因」，看到 `corridor 3 (0 slots) full at item 14 ang=299`。窄画布上，二十多张图钉的方位角都落在 40°–200°，右走廊只有 12–20 个槽位，于是有照片被推进**零槽位**的走廊并直接 `fits:false`。改成「连续弧切分」也不行 —— 本质是「按边分组」这个思路在打卡点扎堆时无解。
3. **改为全局保序指派**：把四条走廊的槽位合成一个按方位角排序的序列，照片也按方位角排序，用 O(n·k) DP 挑出等量且**次序完全一致**的槽位（代价 = 方位角差）。几何上的依据写进了代码注释：锚点在外圈、图钉在内圈，两圈点按同一循环次序配对，线段互不相交。30/40 张立刻变成 0。
4. **收尾的三个脏 bug**：① `cascadeLayout()` 还按扁平数组用 `corridorSlots()` 的返回值（早已改成四组）→ 坐标 `NaN`，这是 20/24 张「叠在原点」的真因 ② 档位回退到 cascade 时用了**最大档 200**，摊成一片重叠 ③ 槽位缺 `ang` 字段，DP 代价 `NaN`，回溯带空洞。

**性能**：40 张一度要 **35.7 秒**。三刀砍下来：① `yarnPath()` 从「17 点采样」改成直接返回两点（线本来就是直线，采样让相交判定慢 256 倍）② 档位搜索从「顺序试 19 档」改成**二分找第一个 fits 的档** ③ 候选档先跑 `probe=true`（跳过优化器、只算一次交叉数）排序，再按序真优化，第一个 0 交叉即收工。现在 1.0–1.3 秒。

**还加了一条**：优化器跑完若还有交叉，做**确定性扰动重启**（最多 80 次，扰动 = 交换第 `(k*37)%m` 与 `(k*91+11)%m` 张的槽位，再跑 60 轮优化），用 `snap()/load()` 保存/回滚最好状态。用固定步长伪随机而不是 `Math.random`，保证同一批照片每次排出同一结果。

**手机端连带**：地图卡片比例从固定 0.84 改成 `BW < 900 ? 0.74 : 0.84`。0.74 是实测下限 —— 再宽一点侧走廊就窄到连一列 60px 的照片都放不下，40 张会全挤在上下两条走廊叠成一坨。桌面不受影响。

**验收**：7 种窗口尺寸（2200×1100 / 1600×1000 / 1366×768 / 900×1600 / 820×1180 / 430×932 / 393×852）× 5/15/24/40 张 = 28 组，全部 `crossings: 0`、`issues: []`。

**踩到的坑**
- **诊断脚本自己会把结果测错**：`dbg-perf` / `dbg-lay` 里调 `__dbg.layout()` 会重新执行 `ringLayout` → 内部 `computePinCard()` 重算 `p._pinCard`，导致自检用的针位与渲染时的 `p._pinBoard` 脱钩，测出「30 张 3 处、40 张 6 处」的假交叉。只有不调 layout 的 `dbg-x.mjs` 才是真值。
- **`<script>` 语法错时页面全哑**：`window.__dbg` 全部 `undefined`，测试只会报 `Cannot read properties of undefined (reading 'layoutState')`，看不出根因。固化了定位手法：从 `index.html` 抽出 `<script>` 内容写临时 `.js`，`node --check` 能直接给行号和报错（那次是 `};` 写成 `},`）。
- 改名时踩了 `SyntaxError: Identifier 'slotsAll' has already been declared`（优化器里的同名变量改成了 `slotsAllFlat`）。
- `Start-Process -RedirectStandardOutput` 在本机直接报 `Item has already been added. Key in dictionary: 'NO_PROXY'`，串行跑多尺寸只能用 `node ... | Out-String`。
## R16 · 拖动排序 / 云端压缩 / 世界城市 / 导出 2×

**本轮做了什么**（全部在 `src/index.template.html`，`node src/build.mjs` → `index.html` 1,213,031 B + 同步 `dist/`）

1. **拖动照片 = 换槽位，记名次不记坐标**
   - `makePhoto()` 加 `rank: null`；`applyRanks(list)` 把带 `p.rank` 的照片按名次 splice 进按方位角排好的序列。
   - `ringLayout()` 里把「槽位序列」与「照片指派」拆开：`natural`（纯按方位角）交给 DP 挑槽位得到 `chosenRing`，再用 `order`（插过名次的）去消费 —— 早先把带名次的序列也交给 DP，换一张照片会把整条槽位序列拽偏，虚线框和落点对不上。
   - `ringLayout` 返回值加 `ring`（本次实际用的槽位）与 `dbg`（名次快照，供测试读）。
   - 优化器尊重手动位次：`locked[i] = p.rank != null`，`canMove(i)` 为假的照片不参与单点移动与交换；**但如果名次恰好等于自然位（`rankConsistent`），就当没锁** —— 否则 `rank=0` 这种「本来就在原位」的手动位会把优化器整个关掉，白白丢零交叉。
   - 有锁定时用「整体循环旋转」找交叉最少的摆法（把未锁定的照片在空槽位上整体转 r 个位置，全试一遍取 `totalX()` 最小），实测多数情况下能把交叉消掉，消不掉就如实提示。
   - 拖动 UI：`#slotHint` 虚线框标出会落到哪一格（`nearestRingSlot()` 按锚点距离找），`onPhotoUp` 里 `p.rank = hit.rank` → `patchPhotoRec` → `syncScheduleIndex` → `renderPhotos()`，提示「已排到第 N 位（绕地图一圈数）」。
   - 大图预览里的「回原位」按钮改名「自动排位」，`p.rank = null` 后恢复自动摆布。
   - 持久化：`savePhotoRec` / `patchPhotoRec` / `restoreFromDB` / 云端清单（`syncPushIndex`、`syncPull`）全带上 `rank`。
2. **导出 2× + 像素上限**：`EXPORT_H = 1200`、`EXPORT_SCALE = 2`、`EXPORT_MAX_PX = 3.2e7`（超了等比收）、`EXPORT_SS_MAX_PX = 1.4e7`（成品已很大就不再 2× 超采样，手机不会 OOM）。提示文案随实际走的路径变（有没有超采样如实说）。
3. **HEIC 说法要准**：新增 `isHeicFile()`（读 `ftyp` 盒的 brand：heic/heix/hevc/hevx/heim/heis/mif1/msf1）。解不开时分成两句：`badHeic` 说「是 iPhone 的 HEIC，三个办法任选」，`bad - badHeic` 说「文件可能损坏或格式不支持」。以前把所有解不开的都算成 HEIC，会把一张坏 JPEG 骂成格式问题。
4. **云端只存压缩版**：`shrinkForCloud(p)` —— 长边 1600、JPEG 0.8；`syncPutPhoto` 先试压缩、失败才退回原图。本机、导出、预览仍全部用原图。
5. **世界城市**：`tools/gen_cities.mjs` → `data/cities.js`（1018 城 / 169 国 / 39,916 B，人口 ≥30 万或首都，同国同名取人口最大，每国最多 30 个）。`locateLabel()` 国外分支先按 90 km 找最近城市，找不到才用国家名。
6. **取景粒度四档**：中国档 `全部/省/城市`，全球档 `全部/大洲/国家/城市`（`GRAN_CN`、`GRAN_WORLD`、`buildGranOptions()`）；`p.cc` 记国家名，`granBox()` 新增 `cont`/`country` 分支按大洲/国家并集外接框取景。

**踩的坑（每条都真踩过）**
- `build.mjs` 里 CITIES_W 的占位符必须包含**整行左半**（`const CITIES_W = /*__CITIES__*/[];`），只替换 `/*__CITIES__*/[]` 会拼出 `const CITIES_W = const CITIES_W = […];;` → `SyntaxError: Unexpected token 'const'`。定位手法：从 `index.html` 抽出 `<script>` 正文到 `$env:TEMP\pmw-check.js` 再 `node --check`，能直接拿到行号。
- 测试断言写错过两次：①「国家档比大洲档细」在照片全球撒开时不成立（俄罗斯/美国跨洲，外接框几乎等于全世界），必须用**同一大洲**的三张照片才测得出层级；②「国家档比全部粗」不成立（法国世界边界含海外省，圭亚那在 -53°）。层级只在 大洲 ⊃ 国家 ⊃ 城市 之间成立。
- `test/cdp-sync.mjs` 里「服务端存了原图字节」这句已经是假话（现在存的是压缩版），改成「存的是压过的中等尺寸版本」并加 `≤1.5 MB && t==='image/jpeg'` 判据。
- 诊断脚本必须放 `test/` 目录（放 `%TEMP%` 里 `import './_cdp.mjs'` 会 `ERR_MODULE_NOT_FOUND`）；`launch()` 不导航，清 IndexedDB 前得先 `await t.goto()`。

## R16 收尾 · 2026-10-28 · 导出 2× / 云端压缩 / server 入库 / 截图自动化 / 部署

承接上面 R16 那节（那条只写到第 ④ 项的一半）。这一节补的是后半程：

| 步骤 | 做了什么 | 脚本 / 位置 |
|---|---|---|
| 1 | 导出改成 2× 出厂：`EXPORT_H 1200` × `EXPORT_SCALE 2`，`EXPORT_MAX_PX 3.2e7` 等比兜底，`EXPORT_SS_MAX_PX 1.4e7` 以上不再超采样 | `src/index.template.html` 导出段 |
| 2 | 提示文案跟着实际走的路径变（真做了超采样才说做了） | 同上 |
| 3 | HEIC 说法拆成两句：`isHeicFile()` 认 `ftyp` brand，非 HEIC 的解不开单独说「文件可能损坏或格式不支持」 | `src/index.template.html` |
| 4 | 云端只存压缩版：`shrinkForCloud()` 长边 1600 / JPEG 0.8，`syncPutPhoto` 优先用它 | `src/index.template.html` 云同步模块 |
| 5 | NAS 备份服务收进仓库（含 Dockerfile、package.json、安全测试） | `server/` |
| 6 | 修 `test/security.test.mjs` 在 Windows 上启动超时：`new URL('..', import.meta.url).pathname` 是 percent-encoded（仓库路径含中文），改用 `fileURLToPath` | `server/test/security.test.mjs` |
| 7 | 配图不再手截：`tools/make_docs_shots.mjs` 用 `assets/demo5` 真照片注入演示坐标，自动出 01–07 | `tools/make_docs_shots.mjs` |
| 8 | 体检规则收紧：占位符正则认 `const X = /*__X__*/[];` 整行形态；城市表按「中国 39 / 世界 1018」分开比；跳过 `$env:`/`%TEMP%` 这种 shell 变量 | `tools/check_docs.mjs` |
| 9 | 新增 `tools/check_github.mjs`：重拉 tree API 逐文件比大小，取代「信 gh_push 的 summary」 | `tools/check_github.mjs` |
| 10 | `.gitignore` 把原始快照（`*_raw.geojson` / `china_boundary*.json`）排除，仓库 33 MB → 3.4 MB | `.gitignore` |

**踩的坑（三条，都是这次新踩的）**
- `gh_push.ps1` 的 `summary: added=N updated=M skipped=K` **不能当验收**：N+M+K 常常不等于 staged 文件数，且「updated=2」也可能没真落地。唯一可信的是重拉 tree API 逐文件比大小（`tools/check_github.mjs`）。这次就是这样发现 `functions/api/wall/[[path]].js` 根本没上传。
- 文件名含方括号时，`Copy-Item` 会当通配符把 `[[path]].js` 匹配掉 → 必须 `-LiteralPath`。这就是上一个坑的成因。
- Node 24 的全局 `fetch` 在进程退出时会在 libuv 里断言失败（`UV_HANDLE_CLOSING` / 0xC0000409），**退出码被改成 1**，看起来跟「核对失败」一模一样。`check_github.mjs` 改走 `curl.exe` 后退出码才正常。

**实测**：`tools/check_docs.mjs` 通过；`tools/check_github.mjs` → 82/82 一致 ✅；`test/api-cloud.mjs` 打新部署 20/20；`test/cdp-live.mjs` 打自定义域 17/17；14 个 CDP 脚本全绿（stability 37/37、reorder 17/17、world 26/26、gran 16/16、sync 28/28、persist 21/21、ux 28/28、ux2 21/21、mobile 通过）。

## R17 · 自由摆放（2026-10-28）

**需求**（用户 m06824）：「我希望它是我拖动的话，可以随便拖动位置，而不是只能拖到你固定的位置。」

| # | 做了什么 | 位置 |
|---|---|---|
| 1 | 拖动语义从「换槽位（记名次 `p.rank`）」改成「自由摆放（记相对坐标 `p.pos = {fx, fy}`）」 | `src/index.template.html` 拖动段 + `onPhotoUp` |
| 2 | 去掉槽位吸附：删 `nearestRingSlot()` / `showSlotHint()` / `#slotHint` 虚线框 | 同上 + `buildPhotosLayer()` |
| 3 | `renderPhotos()` 里把 `p.pos` 的照片从自动排布里摘出来（`autoList`），它们只按坐标画，且不占槽位 | `renderPhotos()` |
| 4 | 位置按相对值夹进画布（`clamp(fx*BW, hw, BW-hw)`），换窗口/竖屏都不丢 | `renderPhotos()` |
| 5 | 落位提示改写：说清「就钉在这儿」，交叉时补一句「让 N 根线交叉了，挪一点通常就能错开」 | `onPhotoUp` |
| 6 | 「自动排位」同时清 `p.pos` 与 `p.rank`；按钮可见性判据改 `p.pos || p.rank != null` | `popReset` / `syncPopReset` |
| 7 | 持久化补 `pos`：IndexedDB 写入 / 补丁 / 读回，云端清单推送与拉取 | `savePhotoRec` / `patchPhotoRec` / `restoreFromDB` / `syncPushIndex` / `syncPull` |
| 8 | 服务端清单白名单放行 `cc` 与 `pos`（带 0–1 夹取），修掉「换设备接回丢国家名/丢位置」 | `functions/api/wall/[[path]].js` |
| 9 | 调试钩子：`__dbg.setPos(uid, fx, fy)`、`__dbg.freeOnes()` | `window.__dbg` |
| 10 | 测试整篇重写：从「落到第几个槽位」改成「落点偏差 ≤ 10 px、其他照片 1 px 内不动、刷新后仍在」 | `test/cdp-reorder.mjs` |
| 11 | `test/api-cloud.mjs` 增加两条：手动位置与国名能过白名单再读回 | `test/api-cloud.mjs` |

**踩的坑（三条）**
- 一次性补丁脚本里用 `String.replace(regex, 字符串)` 拼代码，替换串里的 `$&` / `$` 会被当捕获组引用 → 用 `split/join` 或函数式 `replace` 更安全；这次替换串恰好没有 `$`，但 CRLF 必须按 `\r?\n` 匹配（文件是 CRLF 为主、混了 82 行 LF）。
- `.NET` 的 `[IO.File]` API **不吃 PowerShell 的当前目录**：`cd` 之后写 `'README.md'` 仍按进程初始目录解析，报 `Could not find file 'D:\DSH\创业项目\README.md'`。必须传绝对路径（这也是"改文件一律用 edit/write 工具"的又一条理由）。
- 改完 `src/index.template.html` 必须 `node src/build.mjs`，它才会同时写 `index.html` 与 `dist/index.html`；只改一处会让 `wrangler pages dev` 测到旧文件。

**实测**
- `test/cdp-reorder.mjs` **16/16**：落点偏差 `dx=0.0 dy=0.0`、`p.pos={fx:0.4195,fy:0.8575}`、其余 7 张位移 0、刷新后坐标逐像素相同、拖到 (1596,996) 不出界、自动排位后 `pos=null` 且零交叉。
- 全量回归 12 个脚本 exit=0：`cdp-shot` / `cdp15` / `cdp-cross` / `cdp-reflow` / `cdp-persist` 21/21 / `cdp-ux` 28/28 / `cdp-ux2` 21/21 / `cdp-stability` 37/37 / `cdp-mobile` / `cdp-world` 26/26 / `cdp-gran` 16/16 / `cdp-exif2`。
- 部署 `https://2e56bb59.photo-map-wall.pages.dev`；`test/api-cloud.mjs` **22/22**、`test/cdp-live.mjs` **17/17**。
## R17 补充 · 2026-10-28 · 「适应全部」= 视野 + 自动排版

| 步骤 | 做了什么 |
|---|---|
| 1 | 用户反馈：「适应全部好像没有自动排版呀」。原实现只调  + "esetView(true)" + （镜头适应），手摆过的照片还在原地 —— 按钮看起来没生效 |
| 2 | 新增  + "utoLayoutAll()" + ：清掉所有  + "p.pos/p.rank" +  →  + "patchPhotoRec" +  →  + "enderPhotos()" +  →  + "esetView(true)" +  → 延时同步云端 |
| 3 | 摆回之前把原位置存进  + "stash" + ，提示「已按自动排位摆回 N 张。点我撤销」，点提示即恢复（ + "hintUndo" + ） |
| 4 | 没有手摆过照片时行为完全不变（直接  + "esetView" + ），不做多余的写库 |
| 5 | 按钮  + "	itle" +  改为「回到自动排版，并把视野放到全部照片」 |
| 6 |  + "	est/cdp-reorder.mjs" +  增加 6 项：摆到 (0.32,0.78) → 点「适应全部」→ 手动位置清零 / 张数不变 / 零交叉 / 提示可撤销 / 点提示后位置回来 |

**踩坑**：用 node 脚本打补丁时，把中文断言文本写进**单引号 JS 字符串**里，遇到中文引号与嵌套引号直接  + "SyntaxError: Unexpected identifier" + ；改成把待插入片段放在  + ".txt" +  里读进来（不经过 JS 字面量）就干净了。另外  + "[IO.File]::ReadAllLines('src\\...')" +  的相对路径按**进程 CWD** 解析而不是 PowerShell 的  + "cd" + ，必须给绝对路径。
