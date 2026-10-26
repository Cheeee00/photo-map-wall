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

- **省界简化把澳门整个抹掉了**：Douglas-Peucker 容差（0.055°）比澳门本身还大。修法是先记下每个要素面积最大的环，面积过滤后若为空就用该环并以 `TOL/12` 重简。最终 35 省齐全，70,603 B。
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
| 5 | 合成 9 张带已知经纬度的 EXIF 样本做回归 | `test/gen-exif-cases.mjs`、`test/test-parser.mjs`、`test/cdp-exif2.mjs` |

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

**坑**：示例照片用 700px 转出来是 902 KB，内联后单文件逼近 2 MB。降到 460px / q64 后 143 KB，肉眼几乎无差。

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