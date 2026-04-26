"""批改模块：vision / text 两种模式自动切换。

模式判定逻辑（**只看 provider 能力 + 是否真的有图**，不再硬编码 provider 名字）：

- vision 模式：``provider.is_vision_model(model)`` 为真，**且**调用方传了至少一张图
  → 把图和 OCR 草稿一起送给模型，让模型先看图核对再评分。
- text 模式：其他情况（纯文本模型、或者视觉模型但没图）
  → 图不会送出去，prompt 也会自动切到「无图版本」以避免模型幻觉看图。

prompt 模板里的 ``{ocr_review_block}`` 占位符由本模块按当前模式替换；
对没有占位符的老 prompt，会用 regex 把老的「重要：OCR 校对说明」段一次性迁移。
"""
from __future__ import annotations

import logging
import re
import time
from pathlib import Path

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
3. 如果校对后的文本与 OCR 草稿差别明显，请在「整体评价」末尾用一段话说明你做了哪些校对修正（让老师能复核）。"""


TEXT_REVIEW_BLOCK = """# 重要：本次批改没有附带原图

下面那份 OCR 草稿就是你能看到的**全部内容**——这是一个纯文本批改模型，**没有学生的手写原图可对照**。请按以下方式工作：

- `[?]` 表示 OCR 无法辨认的字，请结合上下文做合理推断；推断不出就视为「该处疑似错字」。
- 如果某行/某段在语义上明显是 OCR 误识（与上下文极不连贯、出现奇怪的非常用字组合等），请在「整体评价」末尾用一句话指出你的判断；正文评分以你校对后的合理推断为准。
- **不要假设有图、不要写「看了图」「原稿显示」「我能看到」之类的话**——你确实看不到图。
- **OCR 误识、`[?]` 占位符一律不算学生扣分**，只对在你合理推断后**仍然错**的地方扣分。"""


# 老版本 prompt（没有占位符）里 "# 重要：OCR 校对说明" 整段的 regex，
# 用来对历史 prompt 做一次性自动迁移。匹配从该标题开始到下一个 "---" 分隔行
# （或文件结尾）之前。
_LEGACY_VISION_BLOCK = re.compile(
    r"#\s*重要：OCR\s*校对说明.*?(?=\n---|\Z)",
    re.DOTALL,
)


def grade(
    *,
    transcription: str,
    student_id: str,
    student_name: str,
    provider: Provider,
    model: str,
    prompt_template: str,
    image_paths: list[str | Path] | None = None,
    thinking: bool = False,
    timeout_sec: int = 120,
    max_attempts: int = 2,
) -> str:
    """根据 OCR 草稿（+ 可选原图）让模型给出 markdown 批改报告。"""
    if not transcription.strip():
        raise GradingError("作文转写为空，无法批改。")

    paths = [Path(p) for p in (image_paths or []) if Path(p).exists()]
    is_vision_mode = provider.is_vision_model(model) and bool(paths)
    review_block = VISION_REVIEW_BLOCK if is_vision_mode else TEXT_REVIEW_BLOCK

    rendered_template = (
        prompt_template
        .replace("{transcription}", transcription)
        .replace("{student_name}", student_name)
        .replace("{student_id}", student_id)
    )
    rendered, sub_kind = _apply_review_block(rendered_template, review_block)

    label = f"{student_name}({student_id})"
    n_img = len(paths)
    mode_label = "vision" if is_vision_mode else "text-only"
    effective = n_img if is_vision_mode else 0
    paths_to_send = paths if is_vision_mode else []

    logger.info(
        f"[Grade ▶] {label} (provider={provider.name}, model={model}, "
        f"mode={mode_label}, 附图={effective}/{n_img}页, prompt_block={sub_kind})"
    )
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

    t0 = time.monotonic()
    try:
        out = provider.chat(
            rendered,
            paths_to_send,
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
