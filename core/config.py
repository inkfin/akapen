"""配置管理：从 .env 加载默认值，settings.json 持久化用户在 UI 改的内容。

Provider / model 的可选项分两层：
- ``*_MODEL_CATALOG`` —— UI 下拉默认列出的那几个常用 model，按 provider 分组；
- ``Dropdown(allow_custom_value=True)`` —— 用户也可以自己粘贴 ID（如某个快照
  ``qwen3-vl-plus-2025-09-23`` 或单独申请到的 ``qwen-vl-max-latest``）。

provider 名字必须和 ``core.providers`` 注册的 ``Provider.name`` 一致，
``make_provider(name, settings)`` 才能找到对应的实现。
"""
from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
PROMPTS_DIR = ROOT / "prompts"
SETTINGS_FILE = DATA_DIR / "settings.json"

DEFAULT_DASHSCOPE_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
DEFAULT_QWEN_MODEL = "qwen3-vl-plus"
DEFAULT_PROVIDER = "qwen"

# OCR 必须能「看图」，所以只放视觉 / 多模态 model。
OCR_MODEL_CATALOG: dict[str, list[str]] = {
    "qwen": [
        "qwen3-vl-plus",
        "qwen3-vl-flash",
    ],
    "gemini": [
        "gemini-3.1-pro",
        "gemini-2.5-pro",
        "gemini-2.5-flash",
        "gemini-2.5-flash-lite",
    ],
}

# 批改既能用视觉 model 对照原图二次复核，也能用纯文本 model 只读 OCR 草稿。
# 当前 model 是不是视觉的由 :class:`core.providers.Provider.is_vision_model`
# 决定；``core.grader.grade`` 会按此自动决定要不要把图发出去 + 切换 prompt 文案。
GRADING_MODEL_CATALOG: dict[str, list[str]] = {
    "qwen": [
        "qwen3-vl-plus",
        "qwen3-vl-flash",
        "qwen3.6-plus",
        "qwen3.6-flash",
        "qwen3.5-plus",
        "qwen3.5-flash",
    ],
    "gemini": [
        "gemini-3.1-pro",
        "gemini-2.5-pro",
        "gemini-2.5-flash",
        "gemini-2.5-flash-lite",
    ],
    "claude": [
        "claude-sonnet-4-5",
        "claude-opus-4-5",
        "claude-haiku-4-5",
    ],
}

# Catalog 的 keys 就是 UI 提供方下拉的内容，保持顺序（dict 是有序的）。
OCR_PROVIDERS: list[str] = list(OCR_MODEL_CATALOG.keys())
GRADING_PROVIDERS: list[str] = list(GRADING_MODEL_CATALOG.keys())


def models_for(provider: str, kind: str = "ocr") -> list[str]:
    """返回某个 provider 在 ``kind`` 任务下的默认下拉清单。

    ``kind`` 取值：``"ocr"`` 或 ``"grading"``。未知 provider 返回空列表，
    UI 会让用户自己粘贴 ID。
    """
    catalog = OCR_MODEL_CATALOG if kind == "ocr" else GRADING_MODEL_CATALOG
    return catalog.get(provider, [])


@dataclass
class Settings:
    gemini_api_key: str = ""
    anthropic_api_key: str = ""
    dashscope_api_key: str = ""
    dashscope_base_url: str = DEFAULT_DASHSCOPE_BASE_URL
    ocr_provider: str = DEFAULT_PROVIDER
    ocr_model: str = DEFAULT_QWEN_MODEL
    grading_provider: str = DEFAULT_PROVIDER
    grading_model: str = DEFAULT_QWEN_MODEL
    # 批改时是否开启思考模式。仅对 Qwen plus/flash 系列生效（同价免费拿推理），
    # 235b-a22b-instruct/-thinking 等固定模式模型会被自动忽略；
    # gemini / claude provider 暂不接入此开关。
    grading_thinking: bool = False
    ocr_prompt: str = ""
    grading_prompt: str = ""
    ocr_concurrency: int = 8
    grading_concurrency: int = 6
    ocr_timeout_sec: int = 60
    grading_timeout_sec: int = 120
    max_attempts: int = 2

    @classmethod
    def load(cls) -> "Settings":
        load_dotenv(ROOT / ".env")
        s = cls(
            gemini_api_key=os.getenv("GEMINI_API_KEY", ""),
            anthropic_api_key=os.getenv("ANTHROPIC_API_KEY", ""),
            dashscope_api_key=os.getenv("DASHSCOPE_API_KEY", ""),
            dashscope_base_url=os.getenv("DASHSCOPE_BASE_URL", DEFAULT_DASHSCOPE_BASE_URL),
            ocr_prompt=(PROMPTS_DIR / "ocr.md").read_text(encoding="utf-8"),
            grading_prompt=(PROMPTS_DIR / "grading.md").read_text(encoding="utf-8"),
        )
        if SETTINGS_FILE.exists():
            try:
                stored = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
                for k, v in stored.items():
                    if not hasattr(s, k):
                        continue
                    # 跳过 None 和空字符串（让 .env 的默认值兜底），但允许
                    # False / 0 这种合法值正常覆盖。
                    if v is None or v == "":
                        continue
                    setattr(s, k, v)
            except Exception:
                pass
        return s

    def save(self) -> None:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        SETTINGS_FILE.write_text(
            json.dumps(asdict(self), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
