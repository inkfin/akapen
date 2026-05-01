"""Google Gemini provider，走 ``google-genai`` SDK。

Thinking 行为（基于 Gemini 2.5+）：
- ``thinking=False`` → ``thinking_config=ThinkingConfig(thinking_budget=0)``，关思考；
- ``thinking=True`` → 不设 budget，让模型用默认值（动态思考）；
- ``thinking=None`` → 同样不设 budget，按模型默认。
"""
from __future__ import annotations

import logging
import time
from collections.abc import Sequence
from pathlib import Path
from typing import TYPE_CHECKING, ClassVar

from ..imageproc import standardize_jpeg
from .base import Provider, ProviderError

if TYPE_CHECKING:
    from ..config import Settings

logger = logging.getLogger("provider.gemini")


class GeminiProvider(Provider):
    name: ClassVar[str] = "gemini"

    def __init__(self, *, api_key: str) -> None:
        self.api_key = api_key

    @classmethod
    def from_settings(cls, settings: "Settings") -> "GeminiProvider":
        return cls(api_key=settings.gemini_api_key)

    def is_vision_model(self, model: str) -> bool:
        # 我们 catalog 里挂的 gemini 模型都是多模态的。
        return True

    def supports_thinking_toggle(self, model: str) -> bool:
        m = model.lower()
        return m.startswith("gemini-2.5") or m.startswith("gemini-3")

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
            raise ProviderError("缺少 Gemini API Key。")
        try:
            from google import genai
            from google.genai import types as genai_types
        except ImportError as e:
            raise ProviderError("google-genai 包未安装：pip install 'google-genai'") from e

        jpeg_blobs: list[bytes] = []
        if image_bytes:
            jpeg_blobs = [bytes(b) for b in image_bytes]
        elif image_paths:
            paths = [Path(p) for p in image_paths]
            for p in paths:
                if not p.exists():
                    raise ProviderError(f"图片不存在：{p}")
            jpeg_blobs = [standardize_jpeg(p) for p in paths]

        client = genai.Client(
            api_key=self.api_key,
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
        total_kb = 0
        for data in jpeg_blobs:
            total_kb += len(data) // 1024
            parts.append(genai_types.Part.from_bytes(data=data, mime_type="image/jpeg"))

        config_kwargs: dict = {"temperature": temperature}
        think_label = "default"
        if thinking is False and self.supports_thinking_toggle(model):
            config_kwargs["thinking_config"] = genai_types.ThinkingConfig(thinking_budget=0)
            think_label = "off"
        elif thinking is True and self.supports_thinking_toggle(model):
            think_label = "on"
        elif thinking is not None and not self.supports_thinking_toggle(model):
            think_label = "fixed-by-model"
            tag = label or model
            logger.info(
                f"[Gemini ▶] {tag} 模型 `{model}` 不支持运行时切换思考模式，"
                f"忽略 thinking={thinking} 设置"
            )

        n = len(jpeg_blobs)
        tag = label or model
        logger.info(
            f"[Gemini ▶] {tag} ({n}图, {total_kb}KB, model={model}, "
            f"thinking={think_label}, timeout={timeout_sec}s)"
        )
        t0 = time.monotonic()
        try:
            resp = client.models.generate_content(
                model=model,
                contents=parts,
                config=genai_types.GenerateContentConfig(**config_kwargs),
            )
        except Exception as e:
            elapsed = time.monotonic() - t0
            logger.error(f"[Gemini ✗] {tag} after {elapsed:.1f}s: {e}")
            raise ProviderError(f"Gemini 调用失败：{e}") from e

        elapsed = time.monotonic() - t0
        text = (resp.text or "").strip()
        if not text:
            logger.warning(f"[Gemini ⚠] {tag} 返回空文本 ({elapsed:.1f}s)")
            raise ProviderError("Gemini 未返回内容。")
        logger.info(f"[Gemini ✓] {tag} {len(text)}字 in {elapsed:.1f}s ({n}图)")
        return text
