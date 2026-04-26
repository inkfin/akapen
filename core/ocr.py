"""OCR 模块：把（多页）图片送多模态大模型转写为日语文本。

OCR 走「快而傻」路线——``thinking=False`` + ``temperature=0`` + 多页一次性送，
让模型只做转写、不主动纠错、按页码顺序输出。具体调用细节由传进来的
:class:`core.providers.Provider` 负责，本模块对 provider 完全无感。

调用方一般这样用：

    from core.providers import make_provider
    from core.ocr import transcribe

    provider = make_provider(settings.ocr_provider, settings)
    text = transcribe(paths, provider=provider, model=settings.ocr_model,
                      prompt=settings.ocr_prompt)
"""
from __future__ import annotations

import logging
import time
from pathlib import Path

from .providers import Provider, ProviderError

logger = logging.getLogger("ocr")


class OCRError(RuntimeError):
    pass


def transcribe(
    image_paths: list[str | Path],
    *,
    provider: Provider,
    model: str,
    prompt: str,
    timeout_sec: int = 60,
    max_attempts: int = 2,
    label: str = "",
) -> str:
    """把一位学生的多张作文图片合并送多模态模型一次，按页码顺序生成完整转写。"""
    if not prompt.strip():
        raise OCRError("OCR prompt 为空。")
    if not image_paths:
        raise OCRError("没有图片可转写。")

    paths = [Path(p) for p in image_paths]
    for p in paths:
        if not p.exists():
            raise OCRError(f"图片不存在：{p}")

    n = len(paths)
    if not label:
        label = paths[0].parent.name
    full_prompt = _build_prompt(prompt, n)

    logger.info(
        f"[OCR ▶] {label} ({n}页, model={model}, provider={provider.name})"
    )
    t0 = time.monotonic()
    try:
        text = provider.chat(
            full_prompt,
            paths,
            model=model,
            timeout_sec=timeout_sec,
            max_attempts=max_attempts,
            temperature=0.0,
            # OCR 一律强制非思考；不支持切换的模型会被 provider 自动忽略。
            thinking=False,
            label=label,
        )
    except ProviderError as e:
        elapsed = time.monotonic() - t0
        logger.error(f"[OCR ✗] {label} after {elapsed:.1f}s: {e}")
        raise OCRError(str(e)) from e

    text = text.strip()
    if not text:
        raise OCRError(f"{provider.name} 未返回文本，请检查图片质量或 prompt。")
    elapsed = time.monotonic() - t0
    logger.info(f"[OCR ✓] {label} {len(text)}字 in {elapsed:.1f}s ({n}页)")
    return text


def _build_prompt(user_prompt: str, n_pages: int) -> str:
    """单页时直接用用户 prompt；多页时追加一段「按页码顺序合并」的说明。"""
    if n_pages == 1:
        return user_prompt
    return (
        f"{user_prompt}\n\n"
        f"补充说明：以下共有 {n_pages} 张图片，是同一篇作文的连续页面，"
        f"请按页码顺序（从第 1 页到第 {n_pages} 页）完整转写为一篇连续的文章。"
        f"不要在段落之间插入「第 X 页」之类的标记。"
    )
