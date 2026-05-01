"""异步图片拉取：URL → 标准化 JPEG bytes（写盘 + 内存缓存）。

设计要点：
- 用 ``httpx.AsyncClient`` 做 HTTP；``connect=10s, read=30s, total=45s``
- 退避重试：5xx / 网络异常重试 3 次（initial 1s, factor 2x，上限 8s）
- mime / size 校验：``Content-Type`` 必须 ``image/*``；下载体积 > ``max_image_bytes``
  直接断流（节省 3 Mbps 入向带宽）
- 边下边校验：用 ``aiter_bytes`` 流式累加，超 limit 主动 close 连接
- 下载完成 → 调 ``standardize_jpeg_bytes`` 重编 JPEG → 写到 ``upload_dir/<task_id>/0X.jpg``
- 返回 ``list[Path]`` 给 worker；worker 也能拿到 bytes（可选，用于 single-shot
  缓存复用）

错误分类：
- ``IMAGE_FETCH_FAILED``：网络 / DNS / 超时 / 5xx 用尽
- ``IMAGE_TOO_LARGE``：单图原始体积超 ``max_image_bytes``
- ``IMAGE_BAD_MIME``：``Content-Type`` 不是 ``image/*``
- ``IMAGE_DECODE_FAILED``：PIL 打不开（不是合法图片）

mime 校验只 best-effort——服务端不带 ``Content-Type`` 时改用 PIL 自检兜底。
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from pathlib import Path

import httpx

from core.imageproc import standardize_jpeg_bytes

logger = logging.getLogger("backend.fetcher")


# ---- 错误类型 ---- #


class FetcherError(RuntimeError):
    """图片拉取或校验失败。``code`` 用于 task error_code 落库。"""

    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


# ---- 配置 ---- #


@dataclass
class FetchConfig:
    max_image_bytes: int = 8 * 1024 * 1024
    max_attempts: int = 3
    initial_backoff_sec: float = 1.0
    max_backoff_sec: float = 8.0
    connect_timeout_sec: float = 10.0
    read_timeout_sec: float = 30.0
    total_timeout_sec: float = 45.0


# ---- 单图下载 ---- #


@dataclass
class FetchedImage:
    """单图下载结果。``bytes`` 是已标准化的 JPEG（worker 可直接喂 provider）。"""

    url: str
    local_path: Path
    standardized_bytes: bytes = field(repr=False)


async def fetch_one(
    url: str,
    *,
    dest_path: Path,
    cfg: FetchConfig,
    client: httpx.AsyncClient | None = None,
    max_long_side: int = 1600,
    quality: int = 85,
) -> FetchedImage:
    """异步下载单张图，校验，标准化，落盘到 ``dest_path``。

    ``client`` 留空时本函数自己建一次性的；批量场景请外部建一个长连接客户端复用。
    """
    own_client = client is None
    if own_client:
        client = httpx.AsyncClient(
            timeout=httpx.Timeout(
                cfg.total_timeout_sec,
                connect=cfg.connect_timeout_sec,
                read=cfg.read_timeout_sec,
            ),
            follow_redirects=True,
        )

    try:
        raw = await _download_with_retry(url, client=client, cfg=cfg)
    finally:
        if own_client:
            await client.aclose()

    # PIL 解码 + 标准化重编（同时就把"是不是合法图片"测了）。CPU 密集放 thread。
    try:
        std = await asyncio.to_thread(
            standardize_jpeg_bytes,
            raw,
            max_long_side=max_long_side,
            quality=quality,
            label=url[:80],
        )
    except Exception as e:
        raise FetcherError("IMAGE_DECODE_FAILED", f"图片解码失败 {url}: {e}") from e

    dest_path.parent.mkdir(parents=True, exist_ok=True)
    dest_path.write_bytes(std)
    return FetchedImage(url=url, local_path=dest_path, standardized_bytes=std)


async def fetch_many(
    urls: list[str],
    *,
    dest_dir: Path,
    cfg: FetchConfig,
    max_long_side: int = 1600,
    quality: int = 85,
    concurrency: int = 4,
) -> list[FetchedImage]:
    """批量下载多张图（同任务的多页作文）。在单个 ``AsyncClient`` 上并发 ``concurrency`` 路。

    单图失败直接抛 :class:`FetcherError`，已下完的不回滚（写盘的就留着，反正
    task 整体会被标记 failed，目录最终会被清理任务回收）。
    """
    if not urls:
        return []
    dest_dir.mkdir(parents=True, exist_ok=True)
    sem = asyncio.Semaphore(concurrency)

    async with httpx.AsyncClient(
        timeout=httpx.Timeout(
            cfg.total_timeout_sec,
            connect=cfg.connect_timeout_sec,
            read=cfg.read_timeout_sec,
        ),
        follow_redirects=True,
    ) as client:
        async def _one(idx: int, url: str) -> FetchedImage:
            async with sem:
                dest = dest_dir / f"{idx:02d}.jpg"
                return await fetch_one(
                    url, dest_path=dest, cfg=cfg, client=client,
                    max_long_side=max_long_side, quality=quality,
                )

        return await asyncio.gather(*[_one(i, u) for i, u in enumerate(urls)])


# ---- 内部 helpers ---- #


async def _download_with_retry(
    url: str, *, client: httpx.AsyncClient, cfg: FetchConfig,
) -> bytes:
    """边下边判 size + mime；遇到可重试错误按指数退避；返回 raw bytes。"""
    backoff = cfg.initial_backoff_sec
    last_err: Exception | None = None
    for attempt in range(1, max(1, cfg.max_attempts) + 1):
        try:
            return await _download_once(url, client=client, max_bytes=cfg.max_image_bytes)
        except FetcherError as e:
            # IMAGE_TOO_LARGE / IMAGE_BAD_MIME 不可重试
            if e.code in ("IMAGE_TOO_LARGE", "IMAGE_BAD_MIME"):
                raise
            last_err = e
        except (httpx.TimeoutException, httpx.NetworkError, httpx.HTTPStatusError) as e:
            last_err = e
        except Exception as e:
            last_err = e

        if attempt >= cfg.max_attempts:
            break
        logger.info(
            f"[Fetch ⚠] {url[:60]}... attempt {attempt}/{cfg.max_attempts} 失败: "
            f"{last_err}; 等 {backoff:.1f}s 重试"
        )
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, cfg.max_backoff_sec)

    raise FetcherError(
        "IMAGE_FETCH_FAILED",
        f"重试 {cfg.max_attempts} 次仍失败 {url}: {last_err}",
    )


async def _download_once(
    url: str, *, client: httpx.AsyncClient, max_bytes: int,
) -> bytes:
    async with client.stream("GET", url) as resp:
        if resp.status_code >= 400:
            # 4xx 直接 raise（不走重试）
            if 400 <= resp.status_code < 500:
                raise FetcherError(
                    "IMAGE_FETCH_FAILED",
                    f"HTTP {resp.status_code} {url}",
                )
            # 5xx 走 raise_for_status → httpx.HTTPStatusError → 上层重试
            resp.raise_for_status()

        content_type = resp.headers.get("content-type", "").lower().split(";")[0].strip()
        # mime 缺失允许（很多对象存储不带），但若声明了就必须是 image/*
        if content_type and not content_type.startswith("image/"):
            raise FetcherError(
                "IMAGE_BAD_MIME",
                f"Content-Type {content_type!r} 不是 image/* ({url})",
            )

        # Content-Length 提前判一下，省下载流量
        content_length = resp.headers.get("content-length")
        if content_length and content_length.isdigit() and int(content_length) > max_bytes:
            raise FetcherError(
                "IMAGE_TOO_LARGE",
                f"声明体积 {int(content_length)} 字节超过 {max_bytes} ({url})",
            )

        chunks: list[bytes] = []
        total = 0
        async for chunk in resp.aiter_bytes():
            total += len(chunk)
            if total > max_bytes:
                raise FetcherError(
                    "IMAGE_TOO_LARGE",
                    f"下载超过 {max_bytes} 字节 ({url}, 已读 {total})",
                )
            chunks.append(chunk)
        return b"".join(chunks)
