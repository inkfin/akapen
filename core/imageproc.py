"""图片预处理：标准化方向、按长边缩放、再编 JPEG，保证清晰度的同时尽量减小体积。

用法：
    >>> data = standardize_jpeg(Path("foo.jpg"))   # bytes，可直接喂给 Gemini Part.from_bytes
"""
from __future__ import annotations

import logging
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageOps

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
        img = ImageOps.exif_transpose(img)
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")
        elif img.mode == "L":
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

    orig_size = path.stat().st_size
    logger.debug(
        "%s %dx%d→%dx%d %s %d→%dKB",
        path.name, w, h, *img.size,
        "(scaled)" if scaled else "(no-resize)",
        orig_size // 1024, len(data) // 1024,
    )
    return data
