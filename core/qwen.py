"""Qwen 多模态调用：通过阿里云百炼 / DashScope 的 OpenAI 兼容接口。

设计要点：
- 用 ``openai`` 包 + 自定义 ``base_url`` 即可，不依赖 ``dashscope`` SDK。
- 图片以 ``data:image/jpeg;base64,…`` 形式塞进 ``image_url`` part。
- ``qwen3-vl-plus`` 在非流式 chat.completions 下默认 **不开 thinking**，
  对应 Gemini 的 ``thinking_budget=0``，OCR 转写更稳；批改要更准的话可以
  在 UI 把模型换成 ``qwen3-vl-235b-a22b-thinking``。
"""
from __future__ import annotations

import base64
import logging
import time
from pathlib import Path

from .imageproc import standardize_jpeg

logger = logging.getLogger("qwen")

DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"


class QwenError(RuntimeError):
    pass


def chat_with_images(
    prompt: str,
    image_paths: list[str | Path],
    *,
    api_key: str,
    base_url: str = DEFAULT_BASE_URL,
    model: str,
    timeout_sec: int = 60,
    max_attempts: int = 2,
    temperature: float = 0.0,
    label: str = "",
) -> str:
    """单轮多模态 chat：prompt + 多张图，返回纯文本。"""
    if not api_key:
        raise QwenError("缺少 DashScope API Key（阿里云百炼）。")
    try:
        from openai import OpenAI
    except ImportError as e:
        raise QwenError("openai 包未安装：pip install 'openai>=1.50'") from e

    paths = [Path(p) for p in image_paths]
    for p in paths:
        if not p.exists():
            raise QwenError(f"图片不存在：{p}")

    client = OpenAI(
        api_key=api_key,
        base_url=base_url or DEFAULT_BASE_URL,
        timeout=float(timeout_sec),
        max_retries=max_attempts,
    )

    content: list[dict] = []
    total_kb = 0
    for p in paths:
        data = standardize_jpeg(p)
        total_kb += len(data) // 1024
        b64 = base64.b64encode(data).decode("ascii")
        content.append({
            "type": "image_url",
            "image_url": {"url": f"data:image/jpeg;base64,{b64}"},
        })
    content.append({"type": "text", "text": prompt})

    n = len(paths)
    tag = label or model
    logger.info(
        f"[Qwen ▶] {tag} ({n}图, {total_kb}KB, model={model}, timeout={timeout_sec}s)"
    )
    t0 = time.monotonic()
    try:
        resp = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": content}],
            temperature=temperature,
        )
    except Exception as e:
        elapsed = time.monotonic() - t0
        logger.error(f"[Qwen ✗] {tag} after {elapsed:.1f}s: {e}")
        raise QwenError(_translate_qwen_error(e, model)) from e

    elapsed = time.monotonic() - t0
    if not resp.choices:
        raise QwenError("Qwen 未返回任何 choice。")
    text = (resp.choices[0].message.content or "").strip()
    if not text:
        logger.warning(f"[Qwen ⚠] {tag} 返回空文本 ({elapsed:.1f}s)")
        raise QwenError("Qwen 未返回文本。")

    logger.info(f"[Qwen ✓] {tag} {len(text)}字 in {elapsed:.1f}s ({n}图)")
    return text


def _translate_qwen_error(exc: Exception, model: str) -> str:
    """把 DashScope / OpenAI SDK 抛出来的英文报错翻成短中文提示。"""
    msg = str(exc)
    if "Model.AccessDenied" in msg or "AccessDenied" in msg:
        return (
            f"百炼账号没有调用 `{model}` 的权限。"
            f"去 https://bailian.console.aliyun.com/ → 模型广场 → 找到该模型点「开通」，"
            f"或确认主账号已同意服务协议、子账号 / RAM 角色已授予 AliyunBailianFullAccess。"
        )
    if "InvalidApiKey" in msg or "AuthenticationError" in msg or "401" in msg.split(" ", 2)[0:2]:
        return f"百炼 API Key 无效或被禁用：{msg[:200]}"
    if "Throttling" in msg or "429" in msg or "RateLimit" in msg:
        return f"百炼限流（QPS / 配额超限）：{msg[:200]}"
    if "Model.NotFound" in msg or "InvalidParameter" in msg and "model" in msg.lower():
        return f"百炼上没有 `{model}` 这个模型 ID，请在「设置」里换一个："
    return f"Qwen 调用失败：{exc}"
