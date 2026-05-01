"""Qwen / 阿里云百炼 provider，走 DashScope 的 OpenAI 兼容协议。

实现要点：
- 用 ``openai`` 包 + 自定义 ``base_url``，不依赖 ``dashscope`` SDK；
- 图片以 ``data:image/jpeg;base64,...`` 形式塞进 ``image_url`` part；
- 思考模式通过 ``extra_body={"enable_thinking": ...}`` 切换，仅对
  ``-plus`` / ``-flash`` 系列生效；``-235b-a22b-instruct/-thinking`` 这种固定模式
  模型会自动跳过该参数（强行传会被 DashScope 报 InvalidParameter）。
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

logger = logging.getLogger("provider.qwen")

DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"


class QwenProvider(Provider):
    name: ClassVar[str] = "qwen"

    def __init__(self, *, api_key: str, base_url: str = DEFAULT_BASE_URL) -> None:
        self.api_key = api_key
        self.base_url = base_url or DEFAULT_BASE_URL

    @classmethod
    def from_settings(cls, settings: "Settings") -> "QwenProvider":
        return cls(
            api_key=settings.dashscope_api_key,
            base_url=settings.effective_dashscope_base_url,
        )

    def is_vision_model(self, model: str) -> bool:
        """``-vl-*`` / ``-omni-*`` / ``qvq*`` 才能看图，其他都按纯文本处理。"""
        m = model.lower()
        return "-vl" in m or "-omni" in m or m.startswith("qvq")

    def supports_thinking_toggle(self, model: str) -> bool:
        """``-plus`` / ``-flash`` 系列支持 ``enable_thinking``，固定模式模型不支持。"""
        m = model.lower()
        if "instruct" in m or "thinking" in m:
            return False
        if "qwen-vl-ocr" in m:
            return False
        return "-plus" in m or "-flash" in m

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
            raise ProviderError("缺少 DashScope API Key（阿里云百炼）。")
        try:
            from openai import OpenAI
        except ImportError as e:
            raise ProviderError("openai 包未安装：pip install 'openai>=1.50'") from e

        # 图片来源：image_bytes 优先（已标准化），否则 image_paths（按需标准化）。
        jpeg_blobs: list[bytes] = []
        if image_bytes:
            jpeg_blobs = [bytes(b) for b in image_bytes]
        elif image_paths:
            paths = [Path(p) for p in image_paths]
            for p in paths:
                if not p.exists():
                    raise ProviderError(f"图片不存在：{p}")
            jpeg_blobs = [standardize_jpeg(p) for p in paths]

        client = OpenAI(
            api_key=self.api_key,
            base_url=self.base_url,
            timeout=float(timeout_sec),
            max_retries=max_attempts,
        )

        content: list[dict] = []
        total_kb = 0
        for data in jpeg_blobs:
            total_kb += len(data) // 1024
            b64 = base64.b64encode(data).decode("ascii")
            content.append({
                "type": "image_url",
                "image_url": {"url": f"data:image/jpeg;base64,{b64}"},
            })
        content.append({"type": "text", "text": prompt})

        extra_body, think_label = self._resolve_thinking(model, thinking, label)

        n = len(jpeg_blobs)
        tag = label or model
        logger.info(
            f"[Qwen ▶] {tag} ({n}图, {total_kb}KB, model={model}, "
            f"thinking={think_label}, timeout={timeout_sec}s)"
        )

        kwargs: dict = {
            "model": model,
            "messages": [{"role": "user", "content": content}],
            "temperature": temperature,
        }
        if extra_body:
            kwargs["extra_body"] = extra_body

        # 整体重试：HTTP 错误已经在 OpenAI SDK 内部按 max_retries 退避过了，这里
        # 加一层是为了应对 200 OK 但 message.content 为空的情况——qwen3-vl-plus
        # 开 thinking 时偶发，DashScope 返回空 body，单请求里没有恢复路径。
        max_attempts = max(1, int(max_attempts))
        for attempt in range(1, max_attempts + 1):
            t0 = time.monotonic()
            try:
                resp = client.chat.completions.create(**kwargs)
            except Exception as e:
                elapsed = time.monotonic() - t0
                logger.error(f"[Qwen ✗] {tag} after {elapsed:.1f}s: {e}")
                raise ProviderError(self._translate_error(e, model)) from e

            elapsed = time.monotonic() - t0
            text = ""
            if resp.choices:
                text = (resp.choices[0].message.content or "").strip()
            if text:
                logger.info(f"[Qwen ✓] {tag} {len(text)}字 in {elapsed:.1f}s ({n}图)")
                return text

            if attempt < max_attempts:
                logger.warning(
                    f"[Qwen ⚠] {tag} 返回空文本 ({elapsed:.1f}s)，"
                    f"重试 {attempt + 1}/{max_attempts}"
                )
                continue

            logger.warning(
                f"[Qwen ⚠] {tag} 返回空文本 ({elapsed:.1f}s)，已重试 {max_attempts} 次"
            )
            raise ProviderError(
                "Qwen 多次返回空文本（thinking 模式偶发 bug）；"
                "可在「设置」里关闭思考模式后重试，或调高最多重试次数。"
            )

        # 不会到这里——循环里要么 return 要么 raise——加个 raise 让 mypy 闭嘴。
        raise ProviderError("Qwen 调用结束但未收到任何文本（不应到达此处）。")

    def _resolve_thinking(
        self, model: str, thinking: bool | None, label: str
    ) -> tuple[dict, str]:
        """决定 ``extra_body`` 里要不要传 ``enable_thinking``，并返回 (kwargs, log_tag)。"""
        if thinking is None:
            return {}, "default"
        if self.supports_thinking_toggle(model):
            return {"enable_thinking": bool(thinking)}, ("on" if thinking else "off")
        tag = label or model
        logger.info(
            f"[Qwen ▶] {tag} 模型 `{model}` 思考模式由模型本身决定，"
            f"忽略 thinking={thinking} 设置"
        )
        return {}, "fixed-by-model"

    @staticmethod
    def _translate_error(exc: Exception, model: str) -> str:
        """把 DashScope / OpenAI SDK 的英文报错翻成中文短提示。"""
        msg = str(exc)
        # APIConnectionError 默认 str 只给 "Connection error."，把底层 httpx 异常也带出来，
        # 否则代理 / DNS / SSL 问题完全没法 debug。
        cause = exc.__cause__ or exc.__context__
        if cause and str(cause) and str(cause) != msg:
            msg = f"{msg} | cause: {type(cause).__name__}: {cause}"

        if "Model.AccessDenied" in msg or "AccessDenied" in msg:
            return (
                f"百炼账号没有调用 `{model}` 的权限。"
                f"去 https://bailian.console.aliyun.com/ → 模型广场 → 找到该模型点「开通」，"
                f"或确认主账号已同意服务协议、子账号 / RAM 角色已授予 AliyunBailianFullAccess。"
            )
        if "InvalidApiKey" in msg or "AuthenticationError" in msg:
            return f"百炼 API Key 无效或被禁用：{msg[:200]}"
        if "Throttling" in msg or "429" in msg or "RateLimit" in msg:
            return f"百炼限流（QPS / 配额超限）：{msg[:200]}"
        if "Model.NotFound" in msg or ("InvalidParameter" in msg and "model" in msg.lower()):
            return f"百炼上没有 `{model}` 这个模型 ID，请在「设置」里换一个。"
        if "Connection error" in msg or "ConnectError" in msg or "ProxyError" in msg:
            return (
                f"无法连接百炼（{msg[:200]}）；"
                f"如果设了 HTTP_PROXY / HTTPS_PROXY 但代理白名单里没放 dashscope.aliyuncs.com，"
                f"会全部失败——清掉代理或加白名单再试。"
            )
        return f"Qwen 调用失败：{msg[:300]}"
