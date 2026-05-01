"""API 边界的 pydantic 模型：请求体、响应体、webhook payload。

域模型（评分结果本体）放在 :mod:`core.schemas`，本模块只把它包成 API 出参。
multipart/form-data 路径不走 pydantic 模型——FastAPI 用 ``Form()`` 直接绑定
每个字段，省 Content-Type 适配的麻烦。
"""
from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl

from core.schemas import GradingResult


# ---- 任务状态机 ---- #

TaskStatusLiteral = Literal[
    "queued",
    "fetching_images",
    "preprocessing",
    "ocr_running",
    "grading_running",
    "succeeded",
    "failed",
    "cancelled",
]
TERMINAL_STATUSES: frozenset[str] = frozenset({"succeeded", "failed", "cancelled"})
RETRYABLE_STATUSES: frozenset[str] = frozenset({"failed"})
CANCELLABLE_STATUSES: frozenset[str] = frozenset({
    "queued", "fetching_images", "preprocessing", "ocr_running", "grading_running",
})


# ---- 创建任务（JSON 路径） ---- #


class ProviderOverrides(BaseModel):
    """允许前端为某条任务临时覆盖 provider / model（高级用法，可选）。

    未传则用 ``Settings`` 里的默认值。后端会校验覆盖值是否合法，不合法直接 422。
    """

    model_config = ConfigDict(extra="forbid")

    provider: str | None = Field(default=None, description="qwen / gemini / claude")
    model: str | None = Field(default=None, description="模型 id")
    enable_single_shot: bool | None = Field(
        default=None,
        description="该任务是否走 single-shot；None = 用 settings 默认",
    )
    grading_with_image: bool | None = Field(
        default=None,
        description="两步模式下批改阶段是否再发图；None = 用 settings 默认",
    )


class TaskCreateRequestJSON(BaseModel):
    """JSON 入参（``Content-Type: application/json``）。

    使用场景：前端图片在自己服务器 / 对象存储上，直接传 URL 让后端拉。
    """

    model_config = ConfigDict(extra="forbid")

    idempotency_key: Annotated[str, Field(min_length=1, max_length=128)] | None = None
    student_id: Annotated[str, Field(min_length=1, max_length=64)]
    student_name: Annotated[str, Field(min_length=1, max_length=64)]

    image_urls: Annotated[list[HttpUrl], Field(min_length=1, max_length=8)]

    callback_url: HttpUrl | None = None
    rubric_id: str | None = None
    rubric_version: str | None = None
    provider_overrides: ProviderOverrides | None = None


# ---- 创建任务响应 ---- #


class TaskLinks(BaseModel):
    self: str
    result: str


class TaskCreateResponse(BaseModel):
    """``POST /v1/grading-tasks`` 的响应。HTTP 202 + 这个 body。"""

    task_id: str
    status: TaskStatusLiteral
    idempotent: bool = Field(
        default=False,
        description="True 表示这次 POST 命中了已有 idempotency_key，没有真的新建任务",
    )
    created_at: datetime
    links: TaskLinks


# ---- 查询任务 ---- #


class TaskProgress(BaseModel):
    """状态机里 5 个中间步骤完成度（仅指示性，前端展示进度条用）。"""

    fetching_images: bool = False
    preprocessing: bool = False
    ocr: bool = False
    grading: bool = False


class TaskError(BaseModel):
    code: str = Field(description="错误代码：TIMEOUT / IMAGE_FETCH_FAILED / PROVIDER_ERROR / "
                                  "JSON_VALIDATION_FAILED / CANCELLED 等")
    message: str
    attempts: int = Field(description="到目前为止已经重试的次数")


class TaskStatus(BaseModel):
    """``GET /v1/grading-tasks/{task_id}`` 的响应。"""

    model_config = ConfigDict(extra="ignore")

    task_id: str
    status: TaskStatusLiteral
    student_id: str
    student_name: str
    idempotency_key: str | None = None

    image_count: int = 0
    image_sources: list[str] = Field(
        default_factory=list, description="原始 URL 或 multipart 文件名"
    )

    progress: TaskProgress = Field(default_factory=TaskProgress)
    result: GradingResult | None = None
    error: TaskError | None = None

    rubric_id: str | None = None
    rubric_version: str | None = None
    provider: str | None = None
    model: str | None = None
    mode: str | None = Field(default=None, description="single_shot / two_step_text / two_step_vision")

    callback_url: str | None = None
    callback_status: str | None = None
    callback_attempts: int = 0

    upload_bytes: int = 0
    attempts: int = 0

    created_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None
    updated_at: datetime


class TaskListResponse(BaseModel):
    items: list[TaskStatus]
    next_cursor: str | None = None


# ---- Webhook payload ---- #


class WebhookPayload(BaseModel):
    """中台 → 前端的回调 body。

    HMAC 签名走 header（``X-Akapen-Signature``），body 本身就是这份 JSON。
    """

    task_id: str
    status: TaskStatusLiteral
    student_id: str
    student_name: str
    result: GradingResult | None = None
    error: TaskError | None = None
    timestamp: datetime
