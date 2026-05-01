"""Provider 抽象基类。

每个 provider 是一个 LLM API 的薄封装，暴露统一的 :meth:`Provider.chat` 接口
和能力查询方法。``core/ocr.py`` / ``core/grader.py`` 只依赖这个抽象，所以
增删 provider 不需要动业务代码。

新增一个 provider 三步走：
1. 在 ``core/providers/<name>.py`` 里继承 :class:`Provider` 并实现 :meth:`chat`，
   再加一个 :meth:`from_settings` 类方法把 :class:`core.config.Settings` 里
   的 key / url 抽出来；
2. 在 ``core/providers/__init__.py`` 的 ``_REGISTRY`` 里登记；
3. 在 ``core/config.py`` 的 ``OCR_MODEL_CATALOG`` / ``GRADING_MODEL_CATALOG``
   里加上能用的 model id。

Thinking 语义：
- ``thinking=None``  让模型走默认行为，provider 不加任何 thinking 参数；
- ``thinking=True``  尽量启用思考模式（如 Qwen ``enable_thinking=True``、
  Gemini 给出非零 ``thinking_budget``）；
- ``thinking=False`` 尽量关闭思考（OCR 用这个，避免模型猜字）；
- 不支持切换的模型（如 Qwen ``-235b-a22b-instruct``）会被 provider 自动忽略
  并打日志，**不会报错**。
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Sequence
from pathlib import Path
from typing import TYPE_CHECKING, ClassVar

if TYPE_CHECKING:
    from ..config import Settings


class ProviderError(RuntimeError):
    """Provider 实现内部抛出的 API / 参数错误。

    业务层（``ocr.py`` / ``grader.py``）会再包成 ``OCRError`` / ``GradingError``。
    """


class Provider(ABC):
    """一个 LLM provider 的统一接口（Qwen / Gemini / Claude / ...）。"""

    #: provider 名字，应与 ``core/providers/__init__.py`` 的 ``_REGISTRY`` key 一致。
    name: ClassVar[str] = "base"

    @classmethod
    @abstractmethod
    def from_settings(cls, settings: "Settings") -> "Provider":
        """从全局 :class:`core.config.Settings` 构造一个 Provider 实例。

        各家 provider 在这里挑自己需要的字段（API key / base url 等）。
        这样调用方只需要持有 ``Settings``，不用关心每家 provider 的字段名。
        """

    @abstractmethod
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
        """单轮 chat：``prompt`` + （可选）多张图，返回非空文本。

        图片可以从两个来源传入，**二选一**：

        - ``image_paths``：磁盘上的文件，provider 会调 :func:`core.imageproc.standardize_jpeg`
          做 EXIF 旋正 + 长边缩放 + JPEG 重编码（默认 1600/85）。Gradio 单文件路径用这条。
        - ``image_bytes``：调用方已经标准化好的 JPEG 字节。后端 fetcher 从 URL 拉图后
          一次性 standardize 成 bytes 缓存在 worker 内存里，可以重用同一份 bytes 给
          OCR / 批改 / single-shot 多次调用，避免重复解码 + 重编码。
          **provider 收到 bytes 后不会再做任何处理，直接 base64 / multipart 发出去。**

        两个参数同时传非空时以 ``image_bytes`` 优先；都为空就是纯文本调用。

        失败时抛 :class:`ProviderError`。
        """

    def is_vision_model(self, model: str) -> bool:
        """这个 model 是否能读图。默认 ``True``——大多数我们选的 model 都是多模态。

        Qwen 上有纯文本系列（``qwen3.6-plus`` 等），需要在子类里覆盖。
        """
        return True

    def supports_thinking_toggle(self, model: str) -> bool:
        """这个 model 是否支持运行时切换 thinking 模式。

        默认 ``False``——大多数 model 的思考模式由模型本身决定，无法切换。
        """
        return False
