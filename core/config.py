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
SETTINGS_FILE = DATA_DIR / "settings.json"

# 注意：``core/`` 不再持有任何 prompt 文件路径。
# - demo 模式的默认 prompt 在 ``demo/prompts/`` 下，由 ``demo.app`` 调
#   ``Settings.load_prompts(demo/prompts)`` inject 进来。
# - backend 模式的 fallback prompt 在 ``backend/prompts/`` 下，由 ``BackendSettings.load``
#   调 ``Settings.load_prompts(backend/prompts)`` inject 进来。
# - web 老师端的"通用框架 + ``{rubric}`` 占位符"模板在
#   ``web/lib/model-catalog.ts:DEFAULT_PROMPT_*``，由 web 直接走 HTTP 传给 backend，
#   完全不经过本模块。
# 三条路径的 prompt 文件互相独立、彼此可随便演化；详见 ``Settings.load_prompts`` docstring。

DEFAULT_DASHSCOPE_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
# 阿里云 ECS 同 region 部署时切到这个 endpoint，调 DashScope 不走公网带宽。
# 设置入口：``Settings.use_vpc_endpoint=True``。
DASHSCOPE_VPC_BASE_URL = "https://dashscope-vpc.aliyuncs.com/compatible-mode/v1"
DEFAULT_QWEN_MODEL = "qwen3.6-plus"
DEFAULT_PROVIDER = "qwen"

# 双档画质：OCR / single-shot 用高画质保识别率；两步模式下"批改时再发图"用低画质
# 省带宽（批改不需要逐字看，只是对照原图复核）。
OCR_MAX_LONG_SIDE = 1600
OCR_JPEG_QUALITY = 85
GRADING_MAX_LONG_SIDE = 1280
GRADING_JPEG_QUALITY = 75

# OCR / 批改 catalog —— 这两份只是 UI 下拉的提示，不是 hard 限制。
# 所有 dropdown 都允许 custom value，老师可以贴 catalog 里没列的快照
# （如 ``qwen3.6-plus-2026-04-02``）或申请到的私有 model。
#
# **真实 model ID 必须严格对齐 provider 官方文档**，因为这些 ID 直接被发到 API：
# - 阿里云 Qwen：https://www.alibabacloud.com/help/zh/model-studio/vision-model
#   官方明确"qwen3-vl 系列已不作为首选推荐，新项目建议使用 qwen3.6 / 3.5 系列"，
#   所以 catalog 里 qwen3.6 在前 + 推荐位置；qwen3-vl 留作旧版兼容。
# - Google Gemini：https://ai.google.dev/gemini-api/docs/models
#   注意 ``gemini-3.1-pro`` 真实 API name 是 ``gemini-3.1-pro-preview``（preview
#   阶段），别误填没 -preview 后缀的版本——否则 API 直接 404。
#
# 本文件 catalog 同步源是 ``web/lib/model-catalog.ts``，两边维护时一起改。

# OCR 必须能「看图」，所以只放视觉 / 多模态 model。
OCR_MODEL_CATALOG: dict[str, list[str]] = {
    "qwen": [
        "qwen3.6-plus",
        "qwen3.6-flash",
        "qwen3-vl-plus",
        "qwen3-vl-flash",
    ],
    "gemini": [
        "gemini-3.1-pro-preview",
        "gemini-2.5-pro",
        "gemini-2.5-flash",
        "gemini-2.5-flash-lite",
    ],
}

# 批改：当前主推全多模态系列（qwen3.5 / 3.6 都支持图+视频+文本输入），
# 旧 qwen3-vl 留作兼容。``core.grader.grade`` 按 ``Provider.is_vision_model``
# 决定要不要把图发出去 + 切换 prompt 文案。
GRADING_MODEL_CATALOG: dict[str, list[str]] = {
    "qwen": [
        "qwen3.6-plus",
        "qwen3.6-flash",
        "qwen3.5-plus",
        "qwen3.5-flash",
        "qwen3-vl-plus",
        "qwen3-vl-flash",
    ],
    "gemini": [
        "gemini-3.1-pro-preview",
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
    # 切到阿里云内网 endpoint。仅当本服务部署在阿里云 ECS 且与 DashScope 同 region
    # 时才有意义；跨 region 用了反而会失败。``effective_dashscope_base_url`` 会按这个
    # 开关返回真正的 base_url。
    use_vpc_endpoint: bool = False
    ocr_provider: str = DEFAULT_PROVIDER
    ocr_model: str = DEFAULT_QWEN_MODEL
    grading_provider: str = DEFAULT_PROVIDER
    grading_model: str = DEFAULT_QWEN_MODEL
    # 批改时是否开启思考模式。仅对 Qwen plus/flash 系列生效（同价免费拿推理），
    # 235b-a22b-instruct/-thinking 等固定模式模型会被自动忽略；
    # gemini / claude provider 暂不接入此开关。
    grading_thinking: bool = False
    # Single-shot 模式：一次 vision 调用同时返回 ``{transcription, grading}``，相比
    # 两步模式（先 OCR 后批改）省一半带宽。后端默认走这条路径。
    enable_single_shot: bool = True
    # 两步模式下"批改阶段是否再发一次图"。``False`` = 纯 text 批改（只读 OCR 草稿，
    # 0 图发出），最省带宽；``True`` = 再发一次图给批改模型对照原稿复核，质量更高
    # 但带宽 ×2。仅在 ``enable_single_shot=False`` 时才用得上。
    grading_with_image: bool = False
    ocr_prompt: str = ""
    grading_prompt: str = ""
    single_shot_prompt: str = ""
    ocr_concurrency: int = 8
    grading_concurrency: int = 6
    ocr_timeout_sec: int = 60
    grading_timeout_sec: int = 120
    max_attempts: int = 2

    @property
    def effective_dashscope_base_url(self) -> str:
        """根据 ``use_vpc_endpoint`` 开关挑公网 / 内网 endpoint。"""
        if self.use_vpc_endpoint:
            return DASHSCOPE_VPC_BASE_URL
        return self.dashscope_base_url or DEFAULT_DASHSCOPE_BASE_URL

    @classmethod
    def load(cls) -> "Settings":
        """从 ``.env`` + ``data/settings.json`` 加载基础配置。

        ⚠ **不会**自动加载任何 prompt 文件——``ocr_prompt`` / ``grading_prompt`` /
        ``single_shot_prompt`` 默认是空串。各入口必须在 ``load()`` 之后显式调用
        :meth:`load_prompts` 把自家路径下的 prompt 文件灌进来：

        - ``demo/app.py``       → ``s.load_prompts(DEMO_PROMPTS_DIR)``
        - ``backend/config.py`` → ``s.load_prompts(BACKEND_PROMPTS_DIR)``

        ``data/settings.json`` 里 user 在 Gradio 设置 Tab 改过的 prompt 会**覆盖**
        本方法返回的空串；后续 :meth:`load_prompts` 只填空字段，不会反向覆盖
        user 的持久化值。
        """
        load_dotenv(ROOT / ".env")
        s = cls(
            gemini_api_key=os.getenv("GEMINI_API_KEY", ""),
            anthropic_api_key=os.getenv("ANTHROPIC_API_KEY", ""),
            dashscope_api_key=os.getenv("DASHSCOPE_API_KEY", ""),
            dashscope_base_url=os.getenv("DASHSCOPE_BASE_URL", DEFAULT_DASHSCOPE_BASE_URL),
            use_vpc_endpoint=os.getenv("USE_VPC_ENDPOINT", "").lower() in ("1", "true", "yes"),
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

    def load_prompts(self, prompts_dir: Path) -> None:
        """从 ``prompts_dir`` 把 ocr.md / grading.md / single_shot.md 灌到对应字段。

        **只填空字段**——如果 :meth:`load` 阶段已经从 ``data/settings.json`` 读到
        非空值（user 在 Gradio 改过的持久化值），这里不会反向覆盖它。

        各入口拿自己模块下的目录传进来，互不干扰：

        - demo（模式 A）       : ``demo/prompts``    ── Gradio 默认 / user 可改
        - backend（模式 B）    : ``backend/prompts`` ── 中台 worker 的 fallback
          （web 没传 ``providerOverrides.{ocr,grading,single_shot}_prompt`` 时才用）
        - web（模式 C）**不**走本方法 ── web 有自己一套 ``DEFAULT_PROMPT_*`` 在
          ``web/lib/model-catalog.ts``，每次 POST 直接传给 backend，不经过 Settings。

        三个路径的 prompt 文件**完全独立**，可以各自演化。改全局 JSON schema /
        输出格式 / 通用要求时**三边都要同步**——它们对应同一份
        :class:`core.schemas.GradingResult`。
        """
        for attr, name in (
            ("ocr_prompt", "ocr.md"),
            ("grading_prompt", "grading.md"),
            ("single_shot_prompt", "single_shot.md"),
        ):
            if getattr(self, attr):
                continue  # 已经被 settings.json 填了，不动
            path = prompts_dir / name
            if path.exists():
                setattr(self, attr, path.read_text(encoding="utf-8"))

    def save(self) -> None:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        SETTINGS_FILE.write_text(
            json.dumps(asdict(self), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
