"""把 iPhone 的 HEIC 示例照片转成小尺寸 JPEG，并**保留 EXIF GPS**。

用法：
    python tools/heic2jpg.py [源目录] [输出目录]

默认源目录 C:\\Users\\ChenLong\\Downloads，默认输出 assets/demo5。
需要 pillow-heif：  python -m pip install --user pillow-heif

为什么单独一个脚本：HEIC 是 HEVC 编码，浏览器和 Pillow 都需要插件才能读；
而且 ffmpeg 解 HEIC 只能拿到缩略图。这里用 pillow-heif 解全图。

注意：转出的 JPEG 必须带 EXIF —— 页面里的 parseExifGps 靠它定位。
      只传 quality/size 不传 exif= 的话，GPS 会丢失（曾经踩过这个坑）。
"""
import json
import os
import sys

import pillow_heif
from PIL import Image

pillow_heif.register_heif_opener()

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\ChenLong\Downloads"
DST = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, "assets", "demo5")

FILES = ["IMG_7596_1.heic", "IMG_9010_2.heic", "IMG_8878.heic", "IMG_1786_2.heic", "IMG_7272.heic"]
MAX = 460      # 长边像素；与 src/build.mjs 里 DEMO_META 的 w/h 对应
Q = 88         # JPEG 质量；5 张合计约 140 KB，内联进 index.html 不至于太大


def dms2deg(v):
    d, m, s = v
    return float(d) + float(m) / 60.0 + float(s) / 3600.0


os.makedirs(DST, exist_ok=True)
out = []
for f in FILES:
    im = Image.open(os.path.join(SRC, f))
    w, h = im.size
    exif = im.info.get("exif")          # 整段 APP1 载荷，含 GPS IFD
    rgb = im.convert("RGB")
    k = MAX / float(max(w, h))
    if k < 1.0:
        rgb = rgb.resize((max(1, int(round(w * k))), max(1, int(round(h * k)))), Image.LANCZOS)
    p = os.path.join(DST, f.replace(".heic", ".jpg"))

    kwargs = dict(quality=Q, optimize=True, progressive=False)
    if exif:
        kwargs["exif"] = exif           # ← 关键：带上 GPS，否则定位丢失
    elif im.getexif().get(274) not in (None, 1):
        rgb = rgb.rotate(0)             # 没有 EXIF 时也不留下方向歧义
    rgb.save(p, "JPEG", **kwargs)

    g = im.getexif().get_ifd(0x8825)
    lat = dms2deg(g.get(2))
    lon = dms2deg(g.get(4))
    if g.get(1) == "S":
        lat = -lat
    if g.get(3) == "W":
        lon = -lon
    out.append({"file": os.path.basename(p), "w": rgb.size[0], "h": rgb.size[1],
                "lon": round(lon, 4), "lat": round(lat, 4), "bytes": os.path.getsize(p)})
    print(f"{f}: {w}x{h} -> {rgb.size[0]}x{rgb.size[1]}  {out[-1]['bytes']} B  "
          f"{lon:.4f},{lat:.4f}  exif={len(exif or b'')}B")

print("TOTAL", sum(o["bytes"] for o in out))
print(json.dumps(out, ensure_ascii=False, indent=1))
