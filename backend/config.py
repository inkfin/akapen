"""后端 API / Worker 的配置层。

设计：``BackendSettings`` 持有一个 :class:`core.config.Settings` 实例（业务模型 +
prompt + provider key），再叠一层 API 服务相关参数（API key、并发、带宽、超时、
DB / 上传目录）。这样 ``core/`` 不会被后端字段污染，``backend/`` 也能直接拿到
现成的 provider 配置。

API key 解析：环境变量 ``API_KEYS=name1:secret1,name2:secret2``。每个三元组
``(name, secret)`` 在内存里建一个反查表 ``secret → name``，请求时按 secret 命中。
未配置任何 API key 时，**服务拒绝启动**——避免不小心暴露公网 endpoint。

Webhook 共享密钥：环境变量 ``WEBHOOK_SECRET``。回调时用它做 HMAC-SHA256 签名。
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping

from core.config import DATA_DIR, Settings

logger = logging.getLogger("backend.config")

# backend 模式专属的 prompt fallback。core/ 不持有 prompt 文件路径
# （详见 core.config.Settings.load_prompts docstring），各入口自带自己一份。
# 现网 web 总是显式传 providerOverrides.{ocr,grading,single_shot}_prompt，
# 因此这套 fallback 只在 web 端清空了模板才会被读到。
BACKEND_PROMPTS_DIR = Path(__file__).resolve().parent / "prompts"


@dataclass
class BackendSettings:
    core: Settings

    # 多 API key 支持："name → secret"。请求拿 secret 反查 name 并入库做隔离。
    api_keys: dict[str, str] = field(default_factory=dict)
    webhook_secret: str = ""

    # 并发 & 带宽：3 Mbps × 80% = 2400 kbps 给 LLM 上传。8 路并发各分到 ~38 KB/s，
    # 单路 1.5 MB 上传 ~40s——刚好不会触发 LLM 端 60s timeout。
    max_concurrency: int = 8
    bandwidth_kbps: int = 2400
    # 单任务 wall-clock 上限（秒）。包含 fetcher + standardize + LLM 推理。
    task_timeout_sec: int = 300

    # 单图原始体积上限（multipart 上传 / URL 拉取）。超过直接拒收 / 拉取失败。
    max_image_bytes: int = 8 * 1024 * 1024
    # 一个任务最多带几张图（多页作文）。
    max_images_per_task: int = 8

    # 文件 / DB 路径。可被环境变量 ``BACKEND_DATA_DIR`` 覆盖。
    db_path: Path = field(default_factory=lambda: DATA_DIR / "grading.db")
    upload_dir: Path = field(default_factory=lambda: DATA_DIR / "uploads")

    # uvicorn bind。
    host: str = "0.0.0.0"
    port: int = 8000

    # 默认评分规则 id（前端不传 rubric_id 时用这个落库）。
    default_rubric_id: str = "jp-essay-30"
    default_rubric_version: str = "v1"

    @classmethod
    def load(cls) -> "BackendSettings":
        """从 ``core.Settings`` + 环境变量构造。

        失败模式：
        - ``API_KEYS`` 没设 → 抛 ``RuntimeError``，服务不启动；
        - ``API_KEYS`` 格式错（缺 ``:`` / 重复 secret） → 抛 ``RuntimeError``。
        """
        core = Settings.load()
        core.load_prompts(BACKEND_PROMPTS_DIR)
        api_keys = _parse_api_keys(os.getenv("API_KEYS", ""))
        if not api_keys:
            raise RuntimeError(
                "未配置任何 API_KEYS 环境变量；不允许启动空鉴权服务。\n"
                "在 .env 加一行：API_KEYS=akapen:<32+ 随机字符串>"
            )

        webhook_secret = os.getenv("WEBHOOK_SECRET", "").strip()
        if not webhook_secret:
            logger.warning(
                "WEBHOOK_SECRET 未设置；webhook 回调将以空 secret 签名（前端无法校验）。"
            )

        s = cls(
            core=core,
            api_keys=api_keys,
            webhook_secret=webhook_secret,
            max_concurrency=int(os.getenv("MAX_CONCURRENCY", "8")),
            bandwidth_kbps=int(os.getenv("BANDWIDTH_KBPS", "2400")),
            task_timeout_sec=int(os.getenv("TASK_TIMEOUT_SEC", "300")),
            max_image_bytes=int(os.getenv("MAX_IMAGE_BYTES", str(8 * 1024 * 1024))),
            max_images_per_task=int(os.getenv("MAX_IMAGES_PER_TASK", "8")),
            host=os.getenv("BACKEND_HOST", "0.0.0.0"),
            port=int(os.getenv("BACKEND_PORT", "8000")),
        )
        # 允许覆盖数据目录（比如 docker volume 挂在别的位置）
        backend_data_dir = os.getenv("BACKEND_DATA_DIR", "").strip()
        if backend_data_dir:
            base = Path(backend_data_dir)
            s.db_path = base / "grading.db"
            s.upload_dir = base / "uploads"

        s.upload_dir.mkdir(parents=True, exist_ok=True)
        s.db_path.parent.mkdir(parents=True, exist_ok=True)
        return s

    def reverse_api_keys(self) -> Mapping[str, str]:
        """``secret → name`` 反查表。重复 secret 会在 :func:`_parse_api_keys` 里被拦截。"""
        return {v: k for k, v in self.api_keys.items()}


def _parse_api_keys(raw: str) -> dict[str, str]:
    """``API_KEYS=name1:secret1,name2:secret2`` → ``{name: secret}``。

    secret 至少 16 字符；name 必须唯一；secret 也必须唯一（避免反查歧义）。
    """
    out: dict[str, str] = {}
    seen_secrets: set[str] = set()
    for raw_pair in raw.split(","):
        pair = raw_pair.strip()
        if not pair:
            continue
        if ":" not in pair:
            raise RuntimeError(f"API_KEYS 项缺少冒号：{pair!r}（要 name:secret）")
        name, secret = pair.split(":", 1)
        name, secret = name.strip(), secret.strip()
        if not name or not secret:
            raise RuntimeError(f"API_KEYS 项 name 或 secret 为空：{pair!r}")
        if len(secret) < 16:
            raise RuntimeError(
                f"API_KEYS 项 {name!r} secret 太短（{len(secret)} 字符），至少 16"
            )
        if name in out:
            raise RuntimeError(f"API_KEYS 中 name 重复：{name!r}")
        if secret in seen_secrets:
            raise RuntimeError(f"API_KEYS 中 secret 重复（不允许多个 name 共享 secret）")
        out[name] = secret
        seen_secrets.add(secret)
    return out
