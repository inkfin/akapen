"""Anthropic Claude provider。

注意：Claude 的 Extended Thinking 暂未在这里实现；调用方传 ``thinking=True/False``
都会被记录但不会改变请求参数。需要的话以后用 ``thinking={"type": "enabled",
"budget_tokens": ...}`` 接入。
"""
from __future__ import annotations

import base64
import logging
import time
from collections.abc import Sequence
from pathlib import Path
from typing import TYPE_CHECKING, ClassVar

from ..imageproc import standardize_jpeg
from .base import Provider, ProviderError

if TYPE_CHECKING:
    from ..config import Settings

logger = logging.getLogger("provider.claude")


class ClaudeProvider(Provider):
    name: ClassVar[str] = "claude"

    def __init__(self, *, api_key: str) -> None:
        self.api_key = api_key

    @classmethod
    def from_settings(cls, settings: "Settings") -> "ClaudeProvider":
        return cls(api_key=settings.anthropic_api_key)

    def is_vision_model(self, model: str) -> bool:
        # 我们 catalog 里挂的 Claude 模型都支持视觉。
        return True

    def supports_thinking_toggle(self, model: str) -> bool:
        return False

    def chat(
        self,
        prompt: str,
        image_paths: Sequence[Path] = (),
        *,
        image_bytes: Sequence[bytes] = (),
        model: str,
        timeout_sec: int = 60,
        max_attempts: int = 2,
        temperature: float = 0.0,
        thinking: bool | None = None,
        label: str = "",
    ) -> str:
        if not self.api_key:
            raise ProviderError("缺少 Anthropic API Key。")
        try:
            from anthropic import Anthropic
        except ImportError as e:
            raise ProviderError("anthropic 包未安装：pip install 'anthropic'") from e

        jpeg_blobs: list[bytes] = []
        if image_bytes:
            jpeg_blobs = [bytes(b) for b in image_bytes]
        elif image_paths:
            paths = [Path(p) for p in image_paths]
            for p in paths:
                if not p.exists():
                    raise ProviderError(f"图片不存在：{p}")
            jpeg_blobs = [standardize_jpeg(p) for p in paths]

        content: list[dict] = []
        total_kb = 0
        for data in jpeg_blobs:
            total_kb += len(data) // 1024
            data_b64 = base64.standard_b64encode(data).decode("ascii")
            content.append({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/jpeg",
                    "data": data_b64,
                },
            })
        content.append({"type": "text", "text": prompt})

        n = len(jpeg_blobs)
        tag = label or model
        if thinking is not None:
            logger.info(
                f"[Claude ▶] {tag} thinking 切换暂未在 Claude provider 实现，"
                f"忽略 thinking={thinking} 设置"
            )
        logger.info(
            f"[Claude ▶] {tag} ({n}图, {total_kb}KB, model={model}, timeout={timeout_sec}s)"
        )

        client = Anthropic(api_key=self.api_key, timeout=timeout_sec, max_retries=max_attempts)
        t0 = time.monotonic()
        try:
            msg = client.messages.create(
                model=model,
                max_tokens=4096,
                temperature=temperature,
                messages=[{"role": "user", "content": content}],
            )
        except Exception as e:
            elapsed = time.monotonic() - t0
            logger.error(f"[Claude ✗] {tag} after {elapsed:.1f}s: {e}")
            raise ProviderError(f"Claude 调用失败：{e}") from e

        elapsed = time.monotonic() - t0
        parts: list[str] = []
        for block in msg.content:
            text = getattr(block, "text", None)
            if text:
                parts.append(text)
        out = "\n".join(parts).strip()
        if not out:
            raise ProviderError("Claude 未返回内容。")
        logger.info(f"[Claude ✓] {tag} {len(out)}字 in {elapsed:.1f}s ({n}图)")
        return out
