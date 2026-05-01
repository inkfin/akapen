"""核心域模型：批改结果的严格 JSON schema。

模型层（``core/grader.py``）调用 LLM 后用这套 pydantic 模型做强校验，校验失败
触发整个 chat 调用的重试。后端 API 层（``backend/schemas.py``）也直接复用这套
模型作为出参 schema，两者保持一致。

设计说明：
- ``GradingResult``：评分结果。``transcription`` 字段允许 vision 模式的批改模型
  把"看图校对后的最终文本"回写进来，方便审计；如果模型选择不回写就是空串。
- ``SingleShotResult``：single-shot 一次调用的输出 ``{transcription, grading}``，
  把 vision 转写和评分包在一份 JSON 里。``transcription`` 是顶层字段，便于前端
  展示；``grading`` 嵌套一份 ``GradingResult``。
- 所有模型用 ``extra="ignore"``：模型输出多了字段不要报错，让我们能向前兼容。
- 所有模型不允许 ``extra="allow"``：避免脏数据混入数据库。
"""
from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class Deduction(BaseModel):
    """单条扣分点。"""

    model_config = ConfigDict(extra="ignore")

    rule: str = Field(min_length=1, description="扣分规则名（如「语法-助词」「词汇/书写错误」）")
    points: float = Field(ge=0, description="扣的分值，正数")
    evidence: str | None = Field(
        default=None, description="原文中的证据片段，便于老师复核"
    )


class DimensionScore(BaseModel):
    """单个评分维度。"""

    model_config = ConfigDict(extra="ignore")

    name: str = Field(min_length=1, description="维度名（如「内容」「语言表达」「档次基准分」）")
    score: float = Field(ge=0, description="该维度实得分")
    max: float = Field(gt=0, description="该维度满分")
    deductions: list[Deduction] = Field(default_factory=list)


class GradingResult(BaseModel):
    """一份作文的完整批改结果。

    ``confidence`` 与 ``review_flag`` 由模型自评 + 业务层后处理共同决定：
    - 模型给出初判 ``confidence``；
    - ``core/grader.py`` 的后处理会再根据"边界分数 / 必填字段缺失 / 评语情绪"
      调高 ``review_flag``。
    """

    model_config = ConfigDict(extra="ignore")

    final_score: float = Field(ge=0, le=100, description="总分（按 max_score 满分计）")
    max_score: float = Field(default=30, gt=0, le=100, description="满分基准（高考日语作文 30）")
    dimension_scores: list[DimensionScore] = Field(default_factory=list)
    feedback: str = Field(default="", description="老师面向学生的整体评语，markdown 允许")
    confidence: float = Field(
        default=0.5, ge=0, le=1,
        description="模型自评信心：1 = 完全确定，0 = 几乎瞎猜",
    )
    review_flag: bool = Field(
        default=False, description="是否进入人工复核池"
    )
    review_reasons: list[str] = Field(
        default_factory=list,
        description="复核理由（如 'low_confidence' / 'boundary_score' / 'missing_evidence'）",
    )
    rubric_id: str = Field(default="jp-essay-30", description="评分规则 id")
    rubric_version: str = Field(default="v1", description="评分规则版本")
    transcription: str = Field(
        default="",
        description="vision 模式批改时，模型校对后的作文最终文本；text 模式留空",
    )
    notes: str | None = Field(
        default=None,
        description="模型对评分过程的补充说明（如 'OCR 草稿做了大量校对'），可空",
    )


class SingleShotResult(BaseModel):
    """Single-shot 模式的完整输出：一次 vision 调用同时给出转写 + 评分。

    顶层 ``transcription`` 是完整作文转写；嵌套的 ``grading`` 是评分。
    ``grading.transcription`` 通常会被填成跟顶层一致的值（model 校对后的文本），
    也可能为空——业务层不强制对齐，存什么 model 给什么。
    """

    model_config = ConfigDict(extra="ignore")

    transcription: str = Field(
        min_length=1, description="完整作文转写（学生原意，仅做必要的 OCR 校对）"
    )
    grading: GradingResult
