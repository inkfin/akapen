"""图片预处理：标准化方向、按长边缩放、再编 JPEG，保证清晰度的同时尽量减小体积。

用法：

    # 从磁盘文件标准化（Gradio / 一次性脚本）
    data = standardize_jpeg(Path("foo.jpg"))

    # 从内存字节标准化（backend fetcher 拉到的远程图片）
    data = standardize_jpeg_bytes(downloaded_bytes)

`max_long_side` / `quality` 默认是 OCR 档（1600/85）。批改如果想压更多带宽可以传
``GRADING_MAX_LONG_SIDE`` / ``GRADING_JPEG_QUALITY``（见 :mod:`core.config`）。
"""
from __future__ import annotations

import logging
from io import BytesIO
from pathlib import Path

import pillow_heif
from PIL import Image, ImageOps

# 注册 HEIC/HEIF 解码到 PIL —— 注册之后 Image.open() 自动识别 ftypheic / ftypmif1
# 等容器（iPhone 默认相片格式）。下游 OCR / grading / agent 全部透明受益，不需要
# 改任何业务代码。需要 Dockerfile 装 libheif1 + libde265-0 才能动态链接成功。
pillow_heif.register_heif_opener()

logger = logging.getLogger("img")

DEFAULT_MAX_LONG_SIDE = 1600
DEFAULT_QUALITY = 85


def standardize_jpeg(
    path: str | Path,
    *,
    max_long_side: int = DEFAULT_MAX_LONG_SIDE,
    quality: int = DEFAULT_QUALITY,
) -> bytes:
    """读图片 → EXIF 旋转 → 长边缩放 → 编码 JPEG，返回字节。"""
    path = Path(path)
    with Image.open(path) as img:
        return _standardize_pil(
            img, max_long_side=max_long_side, quality=quality, label=path.name,
            orig_size=path.stat().st_size,
        )


def standardize_jpeg_bytes(
    data: bytes,
    *,
    max_long_side: int = DEFAULT_MAX_LONG_SIDE,
    quality: int = DEFAULT_QUALITY,
    label: str = "<bytes>",
) -> bytes:
    """从内存字节做同样的标准化。后端从 URL 拉下来的图直接走这条路径，不落临时文件。"""
    with Image.open(BytesIO(data)) as img:
        return _standardize_pil(
            img, max_long_side=max_long_side, quality=quality, label=label,
            orig_size=len(data),
        )


def _standardize_pil(
    img: Image.Image, *, max_long_side: int, quality: int,
    label: str, orig_size: int,
) -> bytes:
    img = ImageOps.exif_transpose(img)
    if img.mode != "RGB":
        img = img.convert("RGB")

    w, h = img.size
    long_side = max(w, h)
    if long_side > max_long_side:
        scale = max_long_side / long_side
        new_size = (max(1, int(w * scale)), max(1, int(h * scale)))
        img = img.resize(new_size, Image.LANCZOS)
        scaled = True
    else:
        scaled = False

    buf = BytesIO()
    img.save(buf, format="JPEG", quality=quality, optimize=True, progressive=True)
    data = buf.getvalue()

    logger.debug(
        "%s %dx%d→%dx%d %s %d→%dKB (q=%d, max=%d)",
        label, w, h, *img.size,
        "(scaled)" if scaled else "(no-resize)",
        orig_size // 1024, len(data) // 1024, quality, max_long_side,
    )
    return data
