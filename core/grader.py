"""批改模块：vision / text 两种模式自动切换 + 严格 JSON 输出 + single-shot 模式。

三种调用形式（按调用方需求挑）：

- :func:`grade`        —— 老接口，返回 markdown 字符串。Gradio "修改"Tab 仍在用。
- :func:`grade_json`   —— 新接口，返回 :class:`core.schemas.GradingResult`。
                          自动 JSON 校验 + 失败重试，后端 API 主路径用这条。
- :func:`single_shot`  —— 一次 vision 调用同时返回 ``{transcription, grading}``，
                          相比两步模式省一半带宽。后端默认走这条。

模式判定（``grade`` / ``grade_json``）：

- vision 模式：``provider.is_vision_model(model)`` 为真，**且**调用方传了至少一张图
  → 把图和 OCR 草稿一起送给模型，让模型先看图核对再评分。
- text 模式：其他情况（纯文本模型、或者视觉模型但没图）
  → 图不会送出去，prompt 也会自动切到「无图版本」以避免模型幻觉看图。

prompt 模板里的 ``{ocr_review_block}`` 占位符由本模块按当前模式替换；
对没有占位符的老 prompt，会用 regex 把老的「重要：OCR 校对说明」段一次性迁移。
"""
from __future__ import annotations

import json
import logging
import re
import time
from collections.abc import Sequence
from pathlib import Path

from pydantic import ValidationError

from .schemas import GradingResult, SingleShotResult
from .providers import Provider, ProviderError

logger = logging.getLogger("grade")


class GradingError(RuntimeError):
    pass


VISION_REVIEW_BLOCK = """# 重要：OCR 校对说明

附带的图片是该学生的**手写作文原稿**。上面给出的转写草稿来自机器 OCR，**可能存在以下问题**：
- 误识、漏字、把潦草字猜错
- `[?]` 表示 OCR 无法辨认的字，请你看图补全
- 可能误把试卷上印刷的题干、边距说明、页码等转写进来
- 可能把被划掉的字也写进来了

**请按以下顺序工作**：
1. **先看图**：以原图为准，对 OCR 草稿做必要的校对，得到学生作文的真实文本（去掉印刷干扰、补全 `[?]`、剔除被划掉的字）。
2. **再评分**：基于校对后的文本进行评分。**OCR 错误一律不算学生扣分**，只对学生真正写错的地方扣分。
3. 如果校对后的文本与 OCR 草稿差别明显，请把校对后的最终文本写到输出 JSON 的 `transcription` 字段里（让老师能复核）。"""


TEXT_REVIEW_BLOCK = """# 重要：本次批改没有附带原图

下面那份 OCR 草稿就是你能看到的**全部内容**——这是一个纯文本批改模型，**没有学生的手写原图可对照**。请按以下方式工作：

- `[?]` 表示 OCR 无法辨认的字，请结合上下文做合理推断；推断不出就视为「该处疑似错字」。
- 如果某行/某段在语义上明显是 OCR 误识（与上下文极不连贯、出现奇怪的非常用字组合等），请在输出 JSON 的 `notes` 字段里说明你的判断；正文评分以你校对后的合理推断为准。
- **不要假设有图、不要写「看了图」「原稿显示」「我能看到」之类的话**——你确实看不到图。
- **OCR 误识、`[?]` 占位符一律不算学生扣分**，只对在你合理推断后**仍然错**的地方扣分。
- 因为没图可看，``confidence`` 应当压低（建议 ≤ 0.7）；如果 OCR 草稿质量很差，请把 ``review_flag`` 设为 true 并在 ``review_reasons`` 加上 "poor_ocr"。"""


# 老版本 prompt（没有占位符）里 "# 重要：OCR 校对说明" 整段的 regex，
# 用来对历史 prompt 做一次性自动迁移。匹配从该标题开始到下一个 "---" 分隔行
# （或文件结尾）之前。
_LEGACY_VISION_BLOCK = re.compile(
    r"#\s*重要：OCR\s*校对说明.*?(?=\n---|\Z)",
    re.DOTALL,
)

# 边界分数列表：触碰这些就建议人工复核（影响档位定级 / 等次的关键分数）。
_BOUNDARY_SCORES: tuple[int, ...] = (4, 5, 9, 10, 14, 15, 19, 20, 25, 26, 29, 30)
# 模型自评 confidence 低于这个值 → 进复核池
_LOW_CONFIDENCE_THRESHOLD = 0.65


# ---------------- 老接口（markdown）：保留向后兼容 ---------------- #


def grade(
    *,
    transcription: str,
    student_id: str,
    student_name: str,
    provider: Provider,
    model: str,
    prompt_template: str,
    image_paths: Sequence[str | Path] | None = None,
    image_bytes: Sequence[bytes] | None = None,
    thinking: bool = False,
    timeout_sec: int = 120,
    max_attempts: int = 2,
    question_context: str | None = None,
) -> str:
    """根据 OCR 草稿（+ 可选原图）让模型给出 markdown 批改报告。

    返回 markdown 字符串。这是给 Gradio "修改"Tab 用的兼容接口；后端 API 主路径
    走 :func:`grade_json` 拿严格 JSON。
    """
    rendered, paths_to_send, bytes_to_send, mode_label, n_img = _prepare_grade_call(
        transcription=transcription,
        student_id=student_id,
        student_name=student_name,
        provider=provider,
        model=model,
        prompt_template=prompt_template,
        image_paths=image_paths,
        image_bytes=image_bytes,
        question_context=question_context,
    )

    label = f"{student_name}({student_id})"
    logger.info(
        f"[Grade ▶] {label} (provider={provider.name}, model={model}, "
        f"mode={mode_label}, 附图={n_img}页, output=markdown)"
    )

    t0 = time.monotonic()
    try:
        out = provider.chat(
            rendered,
            paths_to_send,
            image_bytes=bytes_to_send,
            model=model,
            timeout_sec=timeout_sec,
            max_attempts=max_attempts,
            temperature=0.2,
            thinking=thinking,
            label=label,
        )
    except ProviderError as e:
        elapsed = time.monotonic() - t0
        logger.error(f"[Grade ✗] {label} after {elapsed:.1f}s: {e}")
        raise GradingError(str(e)) from e

    elapsed = time.monotonic() - t0
    logger.info(f"[Grade ✓] {label} {len(out)}字 in {elapsed:.1f}s")
    return out


# ---------------- 新接口（严格 JSON）：后端主路径 ---------------- #


def grade_json(
    *,
    transcription: str,
    student_id: str,
    student_name: str,
    provider: Provider,
    model: str,
    prompt_template: str,
    image_paths: Sequence[str | Path] | None = None,
    image_bytes: Sequence[bytes] | None = None,
    thinking: bool = False,
    timeout_sec: int = 120,
    max_attempts: int = 3,
    question_context: str | None = None,
) -> GradingResult:
    """JSON 严格输出版批改：解析失败 / pydantic 校验失败按 ``max_attempts`` 重试。

    成功时返回经过校验 + 质量闸门后处理的 :class:`GradingResult`。
    所有重试都失败时抛 :class:`GradingError`。
    """
    rendered, paths_to_send, bytes_to_send, mode_label, n_img = _prepare_grade_call(
        transcription=transcription,
        student_id=student_id,
        student_name=student_name,
        provider=provider,
        model=model,
        prompt_template=prompt_template,
        image_paths=image_paths,
        image_bytes=image_bytes,
        question_context=question_context,
    )

    label = f"{student_name}({student_id})"
    logger.info(
        f"[Grade ▶] {label} (provider={provider.name}, model={model}, "
        f"mode={mode_label}, 附图={n_img}页, output=json)"
    )

    last_err: Exception | None = None
    for attempt in range(1, max(1, int(max_attempts)) + 1):
        t0 = time.monotonic()
        try:
            raw = provider.chat(
                rendered,
                paths_to_send,
                image_bytes=bytes_to_send,
                model=model,
                timeout_sec=timeout_sec,
                max_attempts=1,  # provider 内部的 retry 我们关掉，由本函数掌控
                temperature=0.2,
                thinking=thinking,
                label=label,
            )
        except ProviderError as e:
            last_err = e
            elapsed = time.monotonic() - t0
            logger.warning(
                f"[Grade ⚠] {label} provider 调用失败 ({elapsed:.1f}s, "
                f"attempt={attempt}/{max_attempts}): {e}"
            )
            continue

        elapsed = time.monotonic() - t0
        try:
            data = _extract_json(raw)
            result = GradingResult.model_validate(data)
        except (json.JSONDecodeError, ValidationError) as e:
            last_err = e
            preview = raw[:200].replace("\n", " ")
            logger.warning(
                f"[Grade ⚠] {label} JSON 校验失败 ({elapsed:.1f}s, "
                f"attempt={attempt}/{max_attempts}): {e}; preview={preview!r}"
            )
            continue

        result = _apply_quality_gates(result)
        logger.info(
            f"[Grade ✓] {label} score={result.final_score}/{result.max_score} "
            f"conf={result.confidence:.2f} review={result.review_flag} in {elapsed:.1f}s"
        )
        return result

    raise GradingError(
        f"批改 JSON 校验连续失败 {max_attempts} 次：{last_err}"
    )


# ---------------- Single-shot：转写 + 批改一次完成 ---------------- #


def single_shot(
    *,
    image_paths: Sequence[str | Path] | None = None,
    image_bytes: Sequence[bytes] | None = None,
    student_id: str,
    student_name: str,
    provider: Provider,
    model: str,
    prompt_template: str,
    thinking: bool | None = None,
    timeout_sec: int = 180,
    max_attempts: int = 3,
    question_context: str | None = None,
) -> SingleShotResult:
    """一次 vision 调用同时输出 transcription + grading。

    必须有图（``image_paths`` 或 ``image_bytes`` 至少一个非空）且 model 是 vision。
    JSON 校验失败按 ``max_attempts`` 重试；都失败抛 :class:`GradingError`。
    """
    if not prompt_template.strip():
        raise GradingError("single-shot prompt 为空。")

    n_img = _effective_image_count(image_paths, image_bytes)
    if n_img == 0:
        raise GradingError("single-shot 模式必须至少 1 张图。")
    if not provider.is_vision_model(model):
        raise GradingError(
            f"single-shot 必须用视觉模型；当前 model `{model}` 在 {provider.name} 是纯文本。"
        )

    rendered = (
        prompt_template
        .replace("{student_name}", student_name)
        .replace("{student_id}", student_id)
    )
    rendered = _prepend_question_context(rendered, question_context)
    paths_to_send = [Path(p) for p in (image_paths or [])]
    bytes_to_send = list(image_bytes or [])

    label = f"{student_name}({student_id})"
    logger.info(
        f"[Single-shot ▶] {label} (provider={provider.name}, model={model}, "
        f"图={n_img}页, output=json, ctx={'yes' if question_context else 'no'})"
    )

    last_err: Exception | None = None
    for attempt in range(1, max(1, int(max_attempts)) + 1):
        t0 = time.monotonic()
        try:
            raw = provider.chat(
                rendered,
                paths_to_send,
                image_bytes=bytes_to_send,
                model=model,
                timeout_sec=timeout_sec,
                max_attempts=1,
                temperature=0.2,
                thinking=thinking,
                label=label,
            )
        except ProviderError as e:
            last_err = e
            elapsed = time.monotonic() - t0
            logger.warning(
                f"[Single-shot ⚠] {label} provider 失败 ({elapsed:.1f}s, "
                f"attempt={attempt}/{max_attempts}): {e}"
            )
            continue

        elapsed = time.monotonic() - t0
        try:
            data = _extract_json(raw)
            result = SingleShotResult.model_validate(data)
        except (json.JSONDecodeError, ValidationError) as e:
            last_err = e
            preview = raw[:200].replace("\n", " ")
            logger.warning(
                f"[Single-shot ⚠] {label} JSON 校验失败 ({elapsed:.1f}s, "
                f"attempt={attempt}/{max_attempts}): {e}; preview={preview!r}"
            )
            continue

        # 业务后处理：质量闸门 + transcription 同步
        gated = _apply_quality_gates(result.grading)
        # 如果 grading 块里 transcription 留空，把顶层那份回填进去，让两边一致
        if not gated.transcription.strip():
            gated = gated.model_copy(update={"transcription": result.transcription})
        result = result.model_copy(update={"grading": gated})

        logger.info(
            f"[Single-shot ✓] {label} score={gated.final_score}/{gated.max_score} "
            f"conf={gated.confidence:.2f} review={gated.review_flag} "
            f"transcription={len(result.transcription)}字 in {elapsed:.1f}s"
        )
        return result

    raise GradingError(
        f"single-shot JSON 校验连续失败 {max_attempts} 次：{last_err}"
    )


# ---------------- 内部 helpers ---------------- #


def _prepare_grade_call(
    *,
    transcription: str,
    student_id: str,
    student_name: str,
    provider: Provider,
    model: str,
    prompt_template: str,
    image_paths: Sequence[str | Path] | None,
    image_bytes: Sequence[bytes] | None,
    question_context: str | None = None,
) -> tuple[str, list[Path], list[bytes], str, int]:
    """渲染 prompt + 决定 vision/text 模式，返回 (rendered, paths, bytes, mode, n_img)。"""
    if not transcription.strip():
        raise GradingError("作文转写为空，无法批改。")

    n_img = _effective_image_count(image_paths, image_bytes)
    is_vision_mode = provider.is_vision_model(model) and n_img > 0
    review_block = VISION_REVIEW_BLOCK if is_vision_mode else TEXT_REVIEW_BLOCK

    rendered_template = (
        prompt_template
        .replace("{transcription}", transcription)
        .replace("{student_name}", student_name)
        .replace("{student_id}", student_id)
    )
    rendered, sub_kind = _apply_review_block(rendered_template, review_block)
    rendered = _prepend_question_context(rendered, question_context)

    paths_to_send = [Path(p) for p in (image_paths or [])] if is_vision_mode else []
    bytes_to_send = list(image_bytes or []) if is_vision_mode else []
    mode_label = "vision" if is_vision_mode else "text-only"

    label = f"{student_name}({student_id})"
    if not is_vision_mode and n_img > 0:
        logger.info(
            f"[Grade ▶] {label} 纯文本批改模式，{n_img} 张图不会送到模型，"
            "prompt 已切到无图版本"
        )
    if sub_kind == "no-substitution" and not is_vision_mode:
        logger.warning(
            f"[Grade ⚠] {label} 你的 prompt 既没有 {{ocr_review_block}} 占位符，"
            "也没有可被自动迁移的「重要：OCR 校对说明」段，纯文本模型可能会幻觉看图。"
            "建议在 设置 Tab 点「重置 Prompt 为默认」或手动加 {ocr_review_block} 占位符。"
        )

    return rendered, paths_to_send, bytes_to_send, mode_label, n_img


def _effective_image_count(
    image_paths: Sequence[str | Path] | None,
    image_bytes: Sequence[bytes] | None,
) -> int:
    """图片数量按 ``image_bytes`` 优先（与 Provider.chat 的优先级一致）。"""
    if image_bytes:
        return len(list(image_bytes))
    if image_paths:
        return sum(1 for p in image_paths if Path(p).exists())
    return 0


def _prepend_question_context(prompt: str, question_context: str | None) -> str:
    """在 prompt 顶部插入「本题题目」上下文段。

    设计取舍：
    - 不改 grading.md 也不改 single_shot.md（demo/prompts/ 或 backend/prompts/ 的版本，
      或者 web 端从 ``providerOverrides`` 传过来的版本），原 prompt 当成"评分细则"
      整体放下半段；这样老用户 settings.json 里存着的旧 prompt 也能直接用，无需重置。
    - 上下文为 None / 空白时直接返回原 prompt，老调用方不感知。
    - 截 4000 字防止恶意大 payload 把 token 撑爆（schemas 那边也会校验，这里是兜底）。
    """
    if not question_context or not question_context.strip():
        return prompt
    ctx = question_context.strip()
    if len(ctx) > 4000:
        ctx = ctx[:4000] + " …(truncated)"
    return (
        "本题题目（前端传入）：\n"
        f"{ctx}\n\n"
        "--- 以下是统一评分细则 ---\n"
        f"{prompt}"
    )


def _apply_review_block(prompt: str, block: str) -> tuple[str, str]:
    """把 prompt 里的占位符 / 老校对段替换成 ``block``，返回 (新 prompt, 模式来源)。

    模式来源仅用于日志：
    - ``placeholder``：用户的 prompt 已带 ``{ocr_review_block}``，正常替换。
    - ``legacy-migrated``：老 prompt 没占位符但有老的 vision 校对段，已用 regex 替换。
    - ``no-substitution``：什么都没匹配上，prompt 保持原样（向后兼容）。
    """
    if "{ocr_review_block}" in prompt:
        return prompt.replace("{ocr_review_block}", block), "placeholder"
    if _LEGACY_VISION_BLOCK.search(prompt):
        return _LEGACY_VISION_BLOCK.sub(block, prompt, count=1), "legacy-migrated"
    return prompt, "no-substitution"


# 容忍模型偶尔返回 ```json ... ``` 包裹的输出，把代码块剥掉。
_FENCE_RE = re.compile(r"^\s*```(?:json)?\s*\n?(.*?)\n?```\s*$", re.DOTALL)


def _extract_json(text: str) -> dict:
    """把模型输出的 JSON 抠出来。

    依次尝试：
    1. 整段就是 JSON（最理想情况）；
    2. 整段被 ```json ... ``` 包裹，剥掉代码栅再 parse；
    3. 在 text 里找第一个 ``{`` 到最后一个匹配的 ``}``（兜底，应对模型在 JSON
       前后写了"以下是结果"等额外文字）。
    """
    raw = text.strip()
    if not raw:
        raise json.JSONDecodeError("empty model output", raw, 0)

    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass

    m = _FENCE_RE.match(raw)
    if m:
        inner = m.group(1).strip()
        return json.loads(inner)

    start = raw.find("{")
    end = raw.rfind("}")
    if start != -1 and end > start:
        snippet = raw[start : end + 1]
        return json.loads(snippet)

    raise json.JSONDecodeError("no JSON object found in model output", raw, 0)


def _apply_quality_gates(result: GradingResult) -> GradingResult:
    """根据 confidence / 边界分数 / 字段缺失自动调高 ``review_flag``。

    返回修改后的副本（pydantic v2 ``model_copy``）；调用方应当用返回值覆盖原结果。

    "不打分"模式（``final_score`` is None）：跳过分数相关的闸门检查，confidence 闸门
    仍然适用 —— 对老师"只批注"的题型来说，模型自己说不太确定时仍然值得复核。
    `dimension_scores` 为空在不打分模式下是预期行为（不再触发 missing_dimensions）。
    """
    reasons = list(result.review_reasons)
    flag = bool(result.review_flag)

    def _add(reason: str) -> None:
        nonlocal flag
        flag = True
        if reason not in reasons:
            reasons.append(reason)

    if result.confidence < _LOW_CONFIDENCE_THRESHOLD:
        _add("low_confidence")

    if result.final_score is not None:
        rounded = round(result.final_score)
        if abs(result.final_score - rounded) < 0.01 and rounded in _BOUNDARY_SCORES:
            _add("boundary_score")

        if not result.dimension_scores:
            _add("missing_dimensions")

    return result.model_copy(update={"review_flag": flag, "review_reasons": reasons})
