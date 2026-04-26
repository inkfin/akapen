"""Provider 注册表。

调用方拿到 :class:`core.config.Settings` 之后，用 ``make_provider(name, settings)``
就能取到一个配置好的 :class:`Provider`，再扔给 ``ocr.transcribe`` / ``grader.grade``。

新增 provider：导入对应 class 并加进 ``_REGISTRY`` 即可。
"""
from __future__ import annotations

from typing import TYPE_CHECKING

from .base import Provider, ProviderError
from .claude import ClaudeProvider
from .gemini import GeminiProvider
from .qwen import QwenProvider

if TYPE_CHECKING:
    from ..config import Settings


_REGISTRY: dict[str, type[Provider]] = {
    QwenProvider.name: QwenProvider,
    GeminiProvider.name: GeminiProvider,
    ClaudeProvider.name: ClaudeProvider,
}


def make_provider(name: str, settings: "Settings") -> Provider:
    """根据名字 + 全局 Settings 构造一个 Provider 实例。

    未知 provider 会抛 ``KeyError``，并把已注册的列表写在异常里方便调试。
    """
    cls = _REGISTRY.get(name)
    if cls is None:
        raise KeyError(
            f"unknown provider: {name!r}（已注册: {sorted(_REGISTRY)})"
        )
    return cls.from_settings(settings)


def registered_providers() -> list[str]:
    """返回当前已注册的 provider 名字列表（按字母序）。仅用于调试 / 日志。"""
    return sorted(_REGISTRY)


__all__ = [
    "Provider",
    "ProviderError",
    "make_provider",
    "registered_providers",
]
