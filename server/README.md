# 照片备份服务（可选）

一个零依赖的 Node HTTP 服务：把网页上传的照片另存一份到自己的机器（NAS / 树莓派 / 任意 VPS），并记下每张照片的来源信息。

**它和 Cloudflare 那套「同一面墙」是两件事，可以只用其中一个：**

| | `functions/api/wall/*`（Cloudflare） | 本目录（自建） |
|---|---|---|
| 存什么 | 长边 1600 的压缩图 + 清单 | **原图** + `meta.json` |
| 干什么用 | 换设备接回同一面墙 | 长期归档、看你朋友传了什么机型 |
| 谁访问 | 浏览器自动，用户无感 | 只由你的机器访问，不对外 |
| 额度 | KV 免费 1 GB / 每天 1000 写 | 自己的硬盘 |

网页本身**不需要**这个服务也能用 —— 不配置就完全不上传。

---

## 起服务

```bash
cd server
BACKUP_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
DATA_DIR=/data PORT=8788 MAX_FILE_MB=25 MAX_PHOTOS_PER_BATCH=30 \
node server.mjs
```

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8788` | `0` 表示让系统分配（启动日志会打印真实端口，测试就是这么做的） |
| `DATA_DIR` | `./data` | 照片与元数据根目录 |
| `BACKUP_TOKEN` | 无（**必填**） | 请求头 `x-backup-token` 的值，缺失或错一个字符都是 401 |
| `MAX_FILE_MB` | `25` | 单张上限 |
| `MAX_PHOTOS_PER_BATCH` | `30` | 单批张数上限 |

或用 Docker：

```bash
docker build -t photo-wall-backup:0.1 .
docker run -d --name photo-wall-backup --restart unless-stopped \
  -p 8788:8788 -v /volume3/docker/photo-wall:/data \
  -e BACKUP_TOKEN=<你的 token> -e MAX_FILE_MB=25 -e MAX_PHOTOS_PER_BATCH=30 \
  --memory 256m photo-wall-backup:0.1
```

> **DSM 上的两个坑**：① 内核对 CPU CFS 的支持不全，`--cpus` 会直接拒绝启动（`NanoCPUs can not be set`），要限 CPU 请用 `--cpuset-cpus`；② 容器以 `node`（uid 1000）跑，宿主机挂载目录必须先 `chown -R 1000:1000`，否则第一张照片就 `EACCES`。

## 接口

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/api/health` | 探活（也要 token） |
| `POST` | `/api/batch` | 开一批，返回 `batchId` |
| `PUT` | `/api/batch/:id/photo/:i` | 传第 i 张（同一 `i` 重复传是幂等的，不会存出两份） |
| `POST` | `/api/batch/:id/finish` | 收尾，写 `index.jsonl` |
| `GET` | `/api/recent` | 最近几批的摘要 |

照片按 magic bytes 归类（内容是 PNG 但名字叫 `.heic` 也能正确识别），不信任扩展名；单张超限先回 413 再关连接，不会让客户端只看到 `ECONNRESET` 而分不清「文件太大」和「网断了」。

## 落了什么

```
$DATA_DIR/uploads/<batchId>/
  photo-0.jpg …
  index.jsonl      # 每张一行：文件名、大小、magic、缺失标记
  meta.json        # 批次：时间、IP、User-Agent（含解析出的机型）、EXIF 的 Make/Model/GPS
```

`meta.json` 里的机型来自 User-Agent 与 EXIF 两处，互相独立；GPS 是照片自带的，抹掉定位的图这里就是空的。

**这是别人的照片和上网痕迹。** 建议：目录权限收到最小（不要 777）、别把服务暴露到公网、定期清理、真要长期留就先跟对方说一声。

## 测试

```bash
node --test test/security.test.mjs   # 10 项：鉴权、路径穿越、幂等、413、magic bytes
```

测试自己 `spawn` 一个 `PORT=0` 的实例，从 stdout 读真实端口 —— 不要在这份测试里写死端口，也不要让它连本机代理（Node 24 的全局 `fetch` 会读系统代理，把 `127.0.0.1` 也送进 7897，所以测试用的是裸 `node:http`）。
