"""批改模块：多模态批改（OCR 草稿 + 原图）。

设计要点：
- 同时把 OCR 草稿文本和**学生原图**一起送给批改模型。
- 让批改模型自己看着图核对 OCR 草稿，识别哪些是 OCR 错、哪些是学生真错。
- Qwen / Gemini 默认 thinking 由模型自身策略决定；想强开思考可在 UI 把模型
  换成带 ``-thinking`` 的版本（如 ``qwen3-vl-235b-a22b-thinking``）。
"""
from __future__ import annotations

import base64
import logging
import time
from pathlib import Path

from .imageproc import standardize_jpeg
from .qwen import QwenError, chat_with_images as qwen_chat

logger = logging.getLogger("grade")


class GradingError(RuntimeError):
    pass


def grade(
    *,
    transcription: str,
    student_id: str,
    student_name: str,
    provider: str,
    model: str,
    prompt_template: str,
    image_paths: list[str | Path] | None = None,
    gemini_api_key: str = "",
    anthropic_api_key: str = "",
    dashscope_api_key: str = "",
    dashscope_base_url: str = "",
    timeout_sec: int = 120,
    max_attempts: int = 2,
) -> str:
    if not transcription.strip():
        raise GradingError("作文转写为空，无法批改。")

    rendered = (
        prompt_template
        .replace("{transcription}", transcription)
        .replace("{student_name}", student_name)
        .replace("{student_id}", student_id)
    )

    paths: list[Path] = []
    if image_paths:
        paths = [Path(p) for p in image_paths if Path(p).exists()]

    label = f"{student_name}({student_id})"
    n_img = len(paths)
    logger.info(f"[Grade ▶] {label} (provider={provider}, model={model}, 附图={n_img}页)")
    t0 = time.monotonic()

    try:
        if provider == "qwen":
            out = _grade_qwen(
                rendered, image_paths=paths, model=model,
                api_key=dashscope_api_key, base_url=dashscope_base_url,
                timeout_sec=timeout_sec, max_attempts=max_attempts,
                label=label,
            )
        elif provider == "claude":
            out = _grade_claude(
                rendered, image_paths=paths, model=model,
                api_key=anthropic_api_key,
                timeout_sec=timeout_sec, max_attempts=max_attempts,
            )
        elif provider == "gemini":
            out = _grade_gemini(
                rendered, image_paths=paths, model=model,
                api_key=gemini_api_key,
                timeout_sec=timeout_sec, max_attempts=max_attempts,
            )
        else:
            raise GradingError(f"未知的 provider：{provider}")
    except Exception as e:
        elapsed = time.monotonic() - t0
        logger.error(f"[Grade ✗] {label} after {elapsed:.1f}s: {e}")
        raise

    elapsed = time.monotonic() - t0
    logger.info(f"[Grade ✓] {label} {len(out)}字 in {elapsed:.1f}s")
    return out


def _grade_qwen(
    prompt: str, *, image_paths: list[Path], model: str, api_key: str, base_url: str,
    timeout_sec: int, max_attempts: int, label: str,
) -> str:
    try:
        return qwen_chat(
            prompt, image_paths,
            api_key=api_key, base_url=base_url, model=model,
            timeout_sec=timeout_sec, max_attempts=max_attempts,
            temperature=0.2, label=label,
        )
    except QwenError as e:
        raise GradingError(str(e)) from e


def _grade_claude(
    prompt: str, *, image_paths: list[Path], model: str, api_key: str,
    timeout_sec: int, max_attempts: int,
) -> str:
    if not api_key:
        raise GradingError("缺少 Anthropic API Key。")
    try:
        from anthropic import Anthropic
    except ImportError as e:
        raise GradingError("anthropic 包未安装") from e

    content: list[dict] = []
    for p in image_paths:
        data_b64 = base64.standard_b64encode(standardize_jpeg(p)).decode("ascii")
        content.append({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/jpeg",
                "data": data_b64,
            },
        })
    content.append({"type": "text", "text": prompt})

    client = Anthropic(api_key=api_key, timeout=timeout_sec, max_retries=max_attempts)
    try:
        msg = client.messages.create(
            model=model,
            max_tokens=4096,
            temperature=0.2,
            messages=[{"role": "user", "content": content}],
        )
    except Exception as e:
        raise GradingError(f"Claude 调用失败：{e}") from e

    parts: list[str] = []
    for block in msg.content:
        text = getattr(block, "text", None)
        if text:
            parts.append(text)
    out = "\n".join(parts).strip()
    if not out:
        raise GradingError("Claude 未返回内容。")
    return out


def _grade_gemini(
    prompt: str, *, image_paths: list[Path], model: str, api_key: str,
    timeout_sec: int, max_attempts: int,
) -> str:
    if not api_key:
        raise GradingError("缺少 Gemini API Key。")
    from google import genai
    from google.genai import types as genai_types

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

    parts: list = [genai_types.Part.from_text(text=prompt)]
    for p in image_paths:
        data = standardize_jpeg(p)
        parts.append(genai_types.Part.from_bytes(data=data, mime_type="image/jpeg"))

    try:
        resp = client.models.generate_content(
            model=model,
            contents=parts,
            config=genai_types.GenerateContentConfig(temperature=0.2),
        )
    except Exception as e:
        raise GradingError(f"Gemini 调用失败：{e}") from e

    out = (resp.text or "").strip()
    if not out:
        raise GradingError("Gemini 未返回内容。")
    return out
