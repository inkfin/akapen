"""OCR 模块：把（多页）图片送多模态大模型转写为日语文本。

支持的 provider：
- ``qwen`` —— 阿里云百炼 / DashScope，OpenAI 兼容协议，默认 ``qwen3-vl-plus``。
- ``gemini`` —— Google Gemini，默认 ``thinking_budget=0`` 关思考。

设计要点：
- thinking 关掉，让 OCR 保持「快而傻」：原文转写、不主动纠错、看不清打 [?]。
- 多页一次性送，让模型按页码顺序输出连续作文，避免分次拼接出错。
- 图片在 :pyfunc:`core.imageproc.standardize_jpeg` 里统一旋转 / 压缩。
"""
from __future__ import annotations

import logging
import time
from pathlib import Path

from .qwen import QwenError, chat_with_images as qwen_chat

logger = logging.getLogger("ocr")


class OCRError(RuntimeError):
    pass


def transcribe(
    image_paths: list[str | Path],
    *,
    provider: str = "qwen",
    model: str,
    prompt: str,
    gemini_api_key: str = "",
    dashscope_api_key: str = "",
    dashscope_base_url: str = "",
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

    if n == 1:
        full_prompt = prompt
    else:
        full_prompt = (
            f"{prompt}\n\n"
            f"补充说明：以下共有 {n} 张图片，是同一篇作文的连续页面，"
            f"请按页码顺序（从第 1 页到第 {n} 页）完整转写为一篇连续的文章。"
            f"不要在段落之间插入「第 X 页」之类的标记。"
        )

    if provider == "qwen":
        try:
            return qwen_chat(
                full_prompt, paths,
                api_key=dashscope_api_key,
                base_url=dashscope_base_url,
                model=model,
                timeout_sec=timeout_sec,
                max_attempts=max_attempts,
                temperature=0.0,
                label=label,
            )
        except QwenError as e:
            raise OCRError(str(e)) from e

    if provider == "gemini":
        return _transcribe_gemini(
            full_prompt, paths,
            api_key=gemini_api_key, model=model,
            timeout_sec=timeout_sec, max_attempts=max_attempts,
            label=label, page_count=n,
        )

    raise OCRError(f"未知的 OCR provider：{provider}（可选：qwen / gemini）")


def _transcribe_gemini(
    full_prompt: str,
    paths: list[Path],
    *,
    api_key: str,
    model: str,
    timeout_sec: int,
    max_attempts: int,
    label: str,
    page_count: int,
) -> str:
    if not api_key:
        raise OCRError("缺少 Gemini API Key，请先在「设置」Tab 填写并保存。")

    from google import genai
    from google.genai import types as genai_types

    from .imageproc import standardize_jpeg

    client = genai.Client(
        api_key=api_key,
        http_options=genai_types.HttpOptions(
            timeout=timeout_sec * 1000,
            retry_options=genai_types.HttpRetryOptions(
                attempts=max_attempts,
                initial_delay=2.0,
                max_delay=10.0,
                http_status_codes=[429, 500, 502, 503, 504],
            ),
        ),
    )

    parts: list = [genai_types.Part.from_text(text=full_prompt)]
    total_kb = 0
    for p in paths:
        data = standardize_jpeg(p)
        total_kb += len(data) // 1024
        parts.append(genai_types.Part.from_bytes(data=data, mime_type="image/jpeg"))

    logger.info(
        f"[OCR ▶] {label} ({page_count}页, {total_kb}KB, model={model}, "
        f"timeout={timeout_sec}s, thinking=off, provider=gemini)"
    )
    t0 = time.monotonic()
    try:
        resp = client.models.generate_content(
            model=model,
            contents=parts,
            config=genai_types.GenerateContentConfig(
                temperature=0.0,
                thinking_config=genai_types.ThinkingConfig(thinking_budget=0),
            ),
        )
    except Exception as e:
        elapsed = time.monotonic() - t0
        logger.error(f"[OCR ✗] {label} after {elapsed:.1f}s: {e}")
        raise OCRError(f"Gemini 调用失败：{e}") from e

    elapsed = time.monotonic() - t0
    text = (resp.text or "").strip()
    if not text:
        logger.warning(f"[OCR ⚠] {label} 返回空文本 ({elapsed:.1f}s)")
        raise OCRError("Gemini 未返回文本，请检查图片质量或 prompt。")

    logger.info(f"[OCR ✓] {label} {len(text)}字 in {elapsed:.1f}s ({page_count}页)")
    return text
