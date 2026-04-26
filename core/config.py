"""配置管理：从 .env 加载默认值，settings.json 持久化用户在 UI 改的内容。"""
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

# UI 下拉用的模型清单：选 provider 后，模型下拉会切到对应那一栏。
# Dropdown 都开了 allow_custom_value，想用快照 ID（比如 qwen3-vl-plus-2025-09-23）
# 也可以直接粘贴。
OCR_PROVIDERS: list[str] = ["qwen", "gemini"]
GRADING_PROVIDERS: list[str] = ["qwen", "claude", "gemini"]

MODEL_CATALOG: dict[str, list[str]] = {
    "qwen": [
        "qwen3-vl-plus",
        "qwen3-vl-flash",
        "qwen3-vl-235b-a22b-instruct",
        "qwen3-vl-235b-a22b-thinking",
        "qwen-vl-max-latest",
        "qwen-vl-plus-latest",
        "qwen-vl-ocr-latest",
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


def models_for(provider: str) -> list[str]:
    return MODEL_CATALOG.get(provider, [])


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
                    if hasattr(s, k) and v:
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
