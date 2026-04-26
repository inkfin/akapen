"""日语作文批改 Demo —— Gradio 单文件 Web 应用。

输入结构：
    data/input/
    ├── 2024001_王伟/
    │   ├── 1.jpg
    │   └── 2.jpg
    └── 2024002_李娜/
        └── 1.jpg

启动：
    python app.py
浏览器打开 http://127.0.0.1:7860
"""
from __future__ import annotations

import html
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import gradio as gr

from core.config import (
    GRADING_PROVIDERS,
    OCR_PROVIDERS,
    PROMPTS_DIR,
    Settings,
    models_for,
)
from core.filenames import scan_folder
from core.grader import GradingError, grade
from core.logger import LOG_FILE, clear_log, setup_logging, tail_log
from core.ocr import OCRError, transcribe
from core.providers import make_provider
from core.storage import StudentRecord, extract_score, make_key

logger = setup_logging()


# ---------- 设置 / 扫描 ---------- #

def save_settings(
    gemini_key, anthropic_key, dashscope_key, dashscope_base_url,
    ocr_provider, ocr_model,
    grading_provider, grading_model, grading_thinking,
    ocr_prompt, grading_prompt,
    ocr_concurrency, grading_concurrency,
    ocr_timeout, grading_timeout, max_attempts,
):
    s = Settings.load()
    s.gemini_api_key = gemini_key.strip()
    s.anthropic_api_key = anthropic_key.strip()
    s.dashscope_api_key = dashscope_key.strip()
    s.dashscope_base_url = (dashscope_base_url or "").strip() or s.dashscope_base_url
    s.ocr_provider = ocr_provider
    s.ocr_model = (ocr_model or "").strip()
    s.grading_provider = grading_provider
    s.grading_model = (grading_model or "").strip()
    s.grading_thinking = bool(grading_thinking)
    s.ocr_prompt = ocr_prompt
    s.grading_prompt = grading_prompt
    s.ocr_concurrency = max(1, int(ocr_concurrency))
    s.grading_concurrency = max(1, int(grading_concurrency))
    s.ocr_timeout_sec = max(10, int(ocr_timeout))
    s.grading_timeout_sec = max(10, int(grading_timeout))
    s.max_attempts = max(1, int(max_attempts))
    s.save()
    logger.info(
        f"设置已保存 OCR(并发={s.ocr_concurrency}, timeout={s.ocr_timeout_sec}s) "
        f"批改(并发={s.grading_concurrency}, timeout={s.grading_timeout_sec}s, "
        f"thinking={s.grading_thinking})"
    )
    return "✅ 已保存设置到 data/settings.json"


def reset_prompts():
    ocr = (PROMPTS_DIR / "ocr.md").read_text(encoding="utf-8")
    grading = (PROMPTS_DIR / "grading.md").read_text(encoding="utf-8")
    return ocr, grading


def _on_ocr_provider_change(provider: str):
    """切 OCR provider：模型下拉换成对应那一栏的视觉模型。"""
    choices = models_for(provider, kind="ocr")
    return gr.update(choices=choices, value=choices[0] if choices else "")


def _on_grading_provider_change(provider: str):
    """切批改 provider：含视觉 + 纯文本两类。"""
    choices = models_for(provider, kind="grading")
    return gr.update(choices=choices, value=choices[0] if choices else "")


def scan(folder_path: str):
    if not folder_path.strip():
        return [], "请填写文件夹路径", _task_html(), gr.update(choices=_selection_choices())
    try:
        students = scan_folder(folder_path)
    except FileNotFoundError as e:
        logger.error(f"扫描失败: {e}")
        return [], f"❌ {e}", _task_html(), gr.update(choices=_selection_choices())

    rows = []
    for st in students:
        rec = None
        if st.valid:
            key = make_key(st.student_id, st.student_name)
            rec = StudentRecord.load(key)
            new_paths = [str(p) for p in st.image_paths]
            if rec is None:
                rec = StudentRecord(
                    key=key,
                    student_id=st.student_id,
                    student_name=st.student_name,
                    folder_path=str(st.folder),
                    folder_name=st.folder_name,
                    image_paths=new_paths,
                )
                rec.save()
            else:
                rec.folder_path = str(st.folder)
                rec.folder_name = st.folder_name
                rec.image_paths = new_paths
                rec.save()
        rows.append([
            st.folder_name,
            st.student_id,
            st.student_name,
            len(st.image_paths),
            "✅" if st.valid else f"❌ {st.reason}",
            rec.ocr_status if rec else "-",
            rec.grading_status if rec else "-",
        ])

    valid_n = sum(1 for s in students if s.valid)
    msg = f"扫描完成：共 {len(students)} 个文件夹，其中 {valid_n} 个有效。"
    if valid_n < len(students):
        msg += " ⚠️ 文件夹名应为 `学号_姓名`，里面放 `1.jpg`、`2.jpg`…"
    logger.info(f"扫描 {folder_path}: {valid_n}/{len(students)} 有效")
    return rows, msg, _task_html(), gr.update(choices=_selection_choices())


# ---------- 批量执行 ---------- #

def _resolve_targets(records: list[StudentRecord], selected_keys: list[str] | None,
                    *, only_filter):
    """没选的时候 → 处理 only_filter 通过的所有记录；选了 → 按选择处理。"""
    if selected_keys:
        chosen = set(selected_keys)
        return [r for r in records if r.key in chosen]
    return [r for r in records if only_filter(r)]


def _process_batch(targets, *, work_fn, label, workers, progress):
    if not targets:
        return f"没有待{label}的任务。"
    total = len(targets)
    logger.info(f"=== 开始 {label}：{total} 条，{workers} 并发 ===")
    done_n = err_n = 0
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = {ex.submit(work_fn, r): r for r in targets}
        for i, fut in enumerate(as_completed(futures), 1):
            try:
                ok = fut.result()
            except Exception as e:
                logger.error(f"{label} worker 异常: {e}")
                ok = False
            if ok:
                done_n += 1
            else:
                err_n += 1
            progress(i / total, desc=f"{label} {i}/{total} (✓{done_n} ✗{err_n})")
    logger.info(f"=== 完成 {label}：✓{done_n} ✗{err_n} ===")
    return f"完成 {label}：✓{done_n}  ✗{err_n}"


def run_ocr_batch(selected_keys, progress=gr.Progress(track_tqdm=False)):
    s = Settings.load()
    records = [r for r in StudentRecord.load_all() if r.existing_image_paths()]
    targets = _resolve_targets(
        records, selected_keys,
        only_filter=lambda r: r.ocr_status != "done",
    )
    # Provider 构造一次，在并发的 work 闭包里复用——它本身只是个轻量配置载体，
    # 真正的 SDK client 在每次 chat() 内部按需新建。
    ocr_provider = make_provider(s.ocr_provider, s)

    def work(rec: StudentRecord) -> bool:
        rec.ocr_status = "running"
        rec.error = ""
        rec.save()
        try:
            text = transcribe(
                rec.existing_image_paths(),
                provider=ocr_provider,
                model=s.ocr_model,
                prompt=s.ocr_prompt,
                timeout_sec=s.ocr_timeout_sec,
                max_attempts=s.max_attempts,
                label=rec.folder_name,
            )
        except Exception as e:
            rec.ocr_status = "error"
            rec.error = str(e)[:500]
            rec.save()
            return False
        rec.transcription = text
        rec.ocr_status = "done"
        rec.error = ""
        rec.save()
        return True

    summary = _process_batch(
        targets, work_fn=work, label="OCR",
        workers=s.ocr_concurrency, progress=progress,
    )
    return _task_html(), summary


def run_grading_batch(selected_keys, progress=gr.Progress(track_tqdm=False)):
    s = Settings.load()
    records = StudentRecord.load_all()
    targets = _resolve_targets(
        records, selected_keys,
        only_filter=lambda r: r.transcription and r.grading_status != "done",
    )
    targets = [r for r in targets if r.transcription]
    grading_provider = make_provider(s.grading_provider, s)

    def work(rec: StudentRecord) -> bool:
        rec.grading_status = "running"
        rec.error = ""
        rec.save()
        try:
            md = grade(
                transcription=rec.transcription,
                student_id=rec.student_id,
                student_name=rec.student_name,
                provider=grading_provider,
                model=s.grading_model,
                prompt_template=s.grading_prompt,
                image_paths=rec.existing_image_paths(),
                thinking=s.grading_thinking,
                timeout_sec=s.grading_timeout_sec,
                max_attempts=s.max_attempts,
            )
        except Exception as e:
            rec.grading_status = "error"
            rec.error = str(e)[:500]
            rec.save()
            return False
        rec.grading = md
        rec.score = extract_score(md)
        rec.grading_status = "done"
        rec.error = ""
        rec.save()
        return True

    summary = _process_batch(
        targets, work_fn=work, label="批改",
        workers=s.grading_concurrency, progress=progress,
    )
    return _task_html(), summary


def run_all(selected_keys, progress=gr.Progress(track_tqdm=False)):
    _, log1 = run_ocr_batch(selected_keys, progress)
    table, log2 = run_grading_batch(selected_keys, progress)
    return table, f"{log1}  |  {log2}"


def reset_errors():
    n = 0
    for r in StudentRecord.load_all():
        changed = False
        if r.ocr_status in ("error", "running"):
            r.ocr_status = "pending"
            changed = True
        if r.grading_status in ("error", "running"):
            r.grading_status = "pending"
            changed = True
        if changed:
            r.error = ""
            r.save()
            n += 1
    logger.info(f"重置 error/running 状态：{n} 条")
    return _task_html(), f"已重置 {n} 条记录的状态为 pending"


# ---------- 任务表格 (HTML 渲染 + 错误悬浮) ---------- #

_TABLE_CSS = """
<style>
.task-wrap { font-family: -apple-system, system-ui, "PingFang SC", sans-serif; }
.task-table { width:100%; border-collapse: collapse; font-size: 13px; }
.task-table th, .task-table td {
  border: 1px solid var(--border-color-primary, #e5e7eb);
  padding: 6px 8px; text-align: left; vertical-align: middle;
}
.task-table th { background: var(--background-fill-secondary, #f3f4f6); font-weight: 600; }
.task-table tr:hover td { background: var(--background-fill-secondary, #f9fafb); }
.task-badge { display:inline-block; padding: 2px 8px; border-radius: 10px; font-size: 12px; font-weight: 500; }
.st-pending { background:#e5e7eb; color:#374151; }
.st-running { background:#fef3c7; color:#92400e; }
.st-done    { background:#d1fae5; color:#065f46; }
.st-error   { background:#fee2e2; color:#991b1b; }
.task-err   { color:#b91c1c; cursor: help; max-width: 280px;
              white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
              display: inline-block; vertical-align: bottom; }
.task-summary { margin: 4px 0 8px; font-size: 13px; color: var(--body-text-color); }
</style>
"""


def _badge(status: str) -> str:
    cls = f"st-{status}" if status in ("pending", "running", "done", "error") else "st-pending"
    return f'<span class="task-badge {cls}">{html.escape(status)}</span>'


def _task_html() -> str:
    records = StudentRecord.load_all()
    n = len(records)
    n_ocr_done = sum(1 for r in records if r.ocr_status == "done")
    n_grade_done = sum(1 for r in records if r.grading_status == "done")
    n_running = sum(1 for r in records
                    if r.ocr_status == "running" or r.grading_status == "running")
    n_err = sum(1 for r in records
                if r.ocr_status == "error" or r.grading_status == "error")

    summary = (
        f'<div class="task-summary">共 <b>{n}</b> 位学生 ｜ '
        f'OCR 完成 <b>{n_ocr_done}</b> ｜ 批改完成 <b>{n_grade_done}</b> ｜ '
        f'running <b>{n_running}</b> ｜ '
        f'<span style="color:#b91c1c">error <b>{n_err}</b></span></div>'
    )

    rows = []
    for r in records:
        err_cell = ""
        if r.error:
            err_full = html.escape(r.error)
            err_short = html.escape(r.error[:60] + ("…" if len(r.error) > 60 else ""))
            err_cell = f'<span class="task-err" title="{err_full}">{err_short}</span>'
        score_cell = "-" if r.score is None else str(r.score)
        rows.append(
            f"<tr>"
            f"<td>{html.escape(r.folder_name)}</td>"
            f"<td>{html.escape(r.student_id)}</td>"
            f"<td>{html.escape(r.student_name)}</td>"
            f"<td style='text-align:center'>{r.page_count}</td>"
            f"<td>{_badge(r.ocr_status)}</td>"
            f"<td>{_badge(r.grading_status)}</td>"
            f"<td style='text-align:center'>{score_cell}</td>"
            f"<td>{err_cell}</td>"
            f"</tr>"
        )

    if not rows:
        body = '<tr><td colspan="8" style="text-align:center;color:#6b7280;padding:20px">'\
               '尚未扫描，先去上方填路径并点 🔍 扫描</td></tr>'
    else:
        body = "\n".join(rows)

    return (
        _TABLE_CSS +
        '<div class="task-wrap">' + summary +
        '<table class="task-table"><thead><tr>'
        '<th>文件夹</th><th>学号</th><th>姓名</th><th>页数</th>'
        '<th>OCR</th><th>批改</th><th>总分</th>'
        '<th>错误（鼠标悬浮看完整信息）</th>'
        '</tr></thead><tbody>'
        f'{body}</tbody></table></div>'
    )


# ---------- 选择 ---------- #

def _selection_choices() -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for r in StudentRecord.load_all():
        flag = ""
        if r.ocr_status == "error" or r.grading_status == "error":
            flag = " ⚠️"
        elif r.ocr_status == "running" or r.grading_status == "running":
            flag = " ⏳"
        elif r.ocr_status == "done" and r.grading_status == "done":
            flag = " ✓"
        label = (
            f"{r.student_id} {r.student_name}  ·  "
            f"{r.page_count}页  ·  OCR={r.ocr_status} 批改={r.grading_status}{flag}"
        )
        out.append((label, r.key))
    return out


def select_all_keys() -> list[str]:
    return [r.key for r in StudentRecord.load_all()]


def select_unfinished_keys() -> list[str]:
    return [
        r.key for r in StudentRecord.load_all()
        if r.ocr_status != "done" or r.grading_status != "done"
    ]


def select_error_keys() -> list[str]:
    return [
        r.key for r in StudentRecord.load_all()
        if r.ocr_status == "error" or r.grading_status == "error"
    ]


def refresh_selection() -> "gr.update":
    return gr.update(choices=_selection_choices())


# ---------- 修改 Tab ---------- #

def list_students() -> list[str]:
    return [
        f"{r.student_id} · {r.student_name}  [{r.key}]"
        for r in StudentRecord.load_all()
    ]


def _key_from_choice(choice: str) -> str:
    if not choice:
        return ""
    if "[" in choice and choice.endswith("]"):
        return choice.rsplit("[", 1)[1].rstrip("]")
    return choice


def load_student(choice: str):
    key = _key_from_choice(choice)
    rec = StudentRecord.load(key)
    if rec is None:
        return [], "", "", "尚未选择学生"
    info = (
        f"**学号**：{rec.student_id}  \n"
        f"**姓名**：{rec.student_name}  \n"
        f"**文件夹**：`{rec.folder_name}`  \n"
        f"**页数**：{rec.page_count}  \n"
        f"**OCR**：{rec.ocr_status}  \n"
        f"**批改**：{rec.grading_status}  \n"
        f"**总分**：{rec.score if rec.score is not None else '-'}"
    )
    images = [(p, f"第 {i+1} 页") for i, p in enumerate(rec.existing_image_paths())]
    return images, rec.transcription, rec.grading, info


def rerun_ocr_one(choice: str):
    s = Settings.load()
    key = _key_from_choice(choice)
    rec = StudentRecord.load(key)
    if rec is None:
        return "", "未找到记录"
    try:
        rec.transcription = transcribe(
            rec.existing_image_paths(),
            provider=make_provider(s.ocr_provider, s),
            model=s.ocr_model,
            prompt=s.ocr_prompt,
            timeout_sec=s.ocr_timeout_sec,
            max_attempts=s.max_attempts,
            label=rec.folder_name,
        )
        rec.ocr_status = "done"
        rec.transcription_edited = False
        rec.error = ""
        rec.save()
        return rec.transcription, "✅ OCR 完成"
    except OCRError as e:
        rec.ocr_status = "error"
        rec.error = str(e)
        rec.save()
        return rec.transcription, f"❌ {e}"


def rerun_grading_one(choice: str, edited_text: str):
    s = Settings.load()
    key = _key_from_choice(choice)
    rec = StudentRecord.load(key)
    if rec is None:
        return "", "未找到记录"
    if edited_text.strip() != (rec.transcription or "").strip():
        rec.transcription = edited_text
        rec.transcription_edited = True
    try:
        md = grade(
            transcription=rec.transcription,
            student_id=rec.student_id,
            student_name=rec.student_name,
            provider=make_provider(s.grading_provider, s),
            model=s.grading_model,
            prompt_template=s.grading_prompt,
            image_paths=rec.existing_image_paths(),
            thinking=s.grading_thinking,
            timeout_sec=s.grading_timeout_sec,
            max_attempts=s.max_attempts,
        )
        rec.grading = md
        rec.score = extract_score(md)
        rec.grading_status = "done"
        rec.grading_edited = False
        rec.error = ""
        rec.save()
        return md, f"✅ 批改完成，总分 {rec.score}"
    except GradingError as e:
        rec.grading_status = "error"
        rec.error = str(e)
        rec.save()
        return rec.grading, f"❌ {e}"


def save_edits(choice: str, edited_text: str, edited_grading: str):
    key = _key_from_choice(choice)
    rec = StudentRecord.load(key)
    if rec is None:
        return "未找到记录"
    if edited_text.strip() != (rec.transcription or "").strip():
        rec.transcription = edited_text
        rec.transcription_edited = True
    if edited_grading.strip() != (rec.grading or "").strip():
        rec.grading = edited_grading
        rec.grading_edited = True
        rec.score = extract_score(edited_grading)
    rec.save()
    return f"✅ 已保存（OCR 修改：{rec.transcription_edited}，批改修改：{rec.grading_edited}）"


# ---------- 结果 Tab ---------- #

def overview_table() -> list[list]:
    rows = []
    for r in StudentRecord.load_all():
        rows.append([
            r.student_id, r.student_name, r.page_count,
            r.score if r.score is not None else "-",
            r.ocr_status, r.grading_status,
            "✏️" if r.transcription_edited or r.grading_edited else "",
        ])
    return rows


def export_markdown_all() -> str | None:
    out_dir = Path("data/exports")
    out_dir.mkdir(parents=True, exist_ok=True)
    bundle = out_dir / "all_results.md"
    parts = ["# 日语作文批改汇总\n"]
    for r in StudentRecord.load_all():
        parts.append(f"\n---\n\n## {r.student_id} · {r.student_name}\n")
        parts.append(f"**文件夹**：`{r.folder_name}` （{r.page_count} 页）  \n")
        if r.score is not None:
            parts.append(f"**总分**：{r.score} / 30\n\n")
        parts.append("### 转写\n\n")
        parts.append((r.transcription or "_（未转写）_") + "\n\n")
        parts.append("### 批改\n\n")
        parts.append((r.grading or "_（未批改）_") + "\n")
    bundle.write_text("".join(parts), encoding="utf-8")
    return str(bundle)


def export_markdown_per_student() -> list[str]:
    out_dir = Path("data/exports/per_student")
    out_dir.mkdir(parents=True, exist_ok=True)
    paths: list[str] = []
    for r in StudentRecord.load_all():
        path = out_dir / f"{r.student_id}_{r.student_name}.md"
        content = (
            f"# {r.student_name}（{r.student_id}）日语作文批改\n\n"
            f"**文件夹**：`{r.folder_name}` （{r.page_count} 页）  \n"
            f"**总分**：{r.score if r.score is not None else '-'} / 30\n\n"
            "## 转写\n\n"
            f"{r.transcription or '_（未转写）_'}\n\n"
            "## 批改\n\n"
            f"{r.grading or '_（未批改）_'}\n"
        )
        path.write_text(content, encoding="utf-8")
        paths.append(str(path))
    return paths


def view_student_detail(choice: str):
    key = _key_from_choice(choice)
    rec = StudentRecord.load(key)
    if rec is None:
        return "", "", []
    images = [(p, f"第 {i+1} 页") for i, p in enumerate(rec.existing_image_paths())]
    return rec.transcription or "（未转写）", rec.grading or "（未批改）", images


# ---------- UI ---------- #

def build_ui() -> gr.Blocks:
    s = Settings.load()

    with gr.Blocks(title="日语作文批改 Demo") as demo:
        gr.Markdown(
            "# 📝 日语作文批改 Demo\n"
            "本地批量 OCR + AI 批改流水线。**输入格式**：每位学生一个子文件夹，"
            "文件夹名 `学号_姓名`，里面放页码命名的图片如 `1.jpg`、`2.jpg`…"
        )

        with gr.Tab("⚙️ 设置"):
            gr.Markdown("### API Key")
            with gr.Row():
                dashscope_key = gr.Textbox(
                    label="DashScope / 阿里云百炼 API Key（推荐，OCR + 批改默认走它）",
                    value=s.dashscope_api_key, type="password",
                )
                dashscope_base_url = gr.Textbox(
                    label="DashScope Base URL",
                    value=s.dashscope_base_url,
                )
            with gr.Row():
                gemini_key = gr.Textbox(label="Gemini API Key（备选）", value=s.gemini_api_key, type="password")
                anthropic_key = gr.Textbox(label="Anthropic API Key（备选）", value=s.anthropic_api_key, type="password")

            gr.Markdown(
                "### Provider & 模型（选 provider 后模型下拉会自动跟着切）\n"
                "- **OCR**：默认 `qwen3-vl-plus`（百炼 Qwen3-VL 旗舰，日语手写实测稳），"
                "省钱选 `qwen3-vl-flash`。OCR 必须用视觉模型。\n"
                "- **批改**：默认同 OCR，可对照原图二次复核；想省钱可以选 `qwen3.6-plus` "
                "等纯文本模型，会自动跳过附图、只读 OCR 草稿。\n"
                "- 模型框是「可输入下拉」：百炼上单独申请到的快照 / `qwen3-vl-235b-a22b-*` / "
                "`qwen-vl-max-latest` 等都可以直接粘贴 ID。"
            )
            with gr.Row():
                ocr_provider = gr.Dropdown(
                    OCR_PROVIDERS, value=s.ocr_provider, label="OCR 提供方",
                )
                ocr_model = gr.Dropdown(
                    choices=models_for(s.ocr_provider, kind="ocr"),
                    value=s.ocr_model, label="OCR 模型",
                    allow_custom_value=True,
                )
                grading_provider = gr.Dropdown(
                    GRADING_PROVIDERS, value=s.grading_provider,
                    label="批改提供方",
                )
                grading_model = gr.Dropdown(
                    choices=models_for(s.grading_provider, kind="grading"),
                    value=s.grading_model, label="批改模型",
                    allow_custom_value=True,
                )

            ocr_provider.change(
                _on_ocr_provider_change, inputs=ocr_provider, outputs=ocr_model,
            )
            grading_provider.change(
                _on_grading_provider_change, inputs=grading_provider, outputs=grading_model,
            )

            with gr.Row():
                grading_thinking = gr.Checkbox(
                    value=s.grading_thinking,
                    label="批改时开启思考模式（仅 Qwen plus / flash 系列生效，同价免费拿推理）",
                    info="对 235b-a22b-instruct/-thinking 等固定模式模型自动忽略；"
                         "Gemini / Claude provider 暂不接入此开关。",
                )

            gr.Markdown("### 性能（并发 / 超时 / 重试）")
            with gr.Row():
                ocr_concurrency = gr.Slider(1, 32, step=1, value=s.ocr_concurrency, label="OCR 并发数")
                grading_concurrency = gr.Slider(1, 32, step=1, value=s.grading_concurrency, label="批改并发数")
            with gr.Row():
                ocr_timeout = gr.Slider(15, 300, step=5, value=s.ocr_timeout_sec, label="OCR 单次超时（秒）")
                grading_timeout = gr.Slider(30, 600, step=10, value=s.grading_timeout_sec, label="批改单次超时（秒）")
                max_attempts = gr.Slider(1, 5, step=1, value=s.max_attempts, label="最多重试次数")

            gr.Markdown("### Prompt")
            ocr_prompt = gr.Textbox(label="OCR Prompt", value=s.ocr_prompt, lines=8)
            grading_prompt = gr.Textbox(
                label="批改 Prompt（支持 {transcription} {student_name} {student_id} 占位符）",
                value=s.grading_prompt, lines=20,
            )

            with gr.Row():
                save_btn = gr.Button("💾 保存设置", variant="primary")
                reset_btn = gr.Button("🔄 重置 Prompt 为默认")
            save_msg = gr.Markdown()

            save_btn.click(
                save_settings,
                inputs=[gemini_key, anthropic_key, dashscope_key, dashscope_base_url,
                        ocr_provider, ocr_model,
                        grading_provider, grading_model, grading_thinking,
                        ocr_prompt, grading_prompt,
                        ocr_concurrency, grading_concurrency,
                        ocr_timeout, grading_timeout, max_attempts],
                outputs=save_msg,
            )
            reset_btn.click(reset_prompts, outputs=[ocr_prompt, grading_prompt])

        with gr.Tab("📋 任务"):
            gr.Markdown(
                "### 1. 选择输入根目录并扫描\n"
                "目录里每个子文件夹代表一位学生。文件夹名为 `学号_姓名`，"
                "文件夹内放图片，按文件名里的数字（页码）排序。"
            )
            with gr.Row():
                default_input = Path("data/input")
                default_input.mkdir(parents=True, exist_ok=True)
                folder = gr.Textbox(
                    label="作文图片根目录",
                    value=str(default_input.resolve()),
                    scale=4,
                )
                scan_btn = gr.Button("🔍 扫描", variant="secondary", scale=1)
            scan_msg = gr.Markdown()
            scan_table = gr.Dataframe(
                headers=["文件夹", "学号", "姓名", "页数", "校验", "OCR", "批改"],
                interactive=False, wrap=True, row_count=(0, "dynamic"),
                show_search=False, show_row_numbers=False,
            )

            gr.Markdown("### 2. 选择要执行的学生")
            task_select = gr.CheckboxGroup(
                choices=_selection_choices(),
                value=[], label="勾选要操作的学生（不选 = 操作所有未完成）",
            )
            with gr.Row():
                sel_all_btn = gr.Button("✅ 全选")
                sel_none_btn = gr.Button("⬜ 取消全选")
                sel_unf_btn = gr.Button("⏳ 仅未完成")
                sel_err_btn = gr.Button("⚠️ 仅 error")
                sel_refresh_btn = gr.Button("🔁 刷新名单")

            gr.Markdown("### 3. 批量执行")
            with gr.Row():
                ocr_btn = gr.Button("🔡 批量 OCR", variant="primary")
                grade_btn = gr.Button("📝 批量批改", variant="primary")
                all_btn = gr.Button("🚀 一键全跑")
                reset_btn2 = gr.Button("🧹 重置 error/running 状态")
            run_log = gr.Textbox(label="本次运行结果摘要", lines=2, interactive=False)

            gr.Markdown("### 4. 任务总览（每 2 秒自动刷新；错误悬浮可看完整信息）")
            task_html = gr.HTML(value=_task_html())
            task_timer = gr.Timer(value=2.0, active=True)

            gr.Markdown("### 5. 实时日志（自动刷新；持久化在 `data/logs/app.log`）")
            log_box = gr.Textbox(
                label=f"日志 ({LOG_FILE})", lines=14,
                interactive=False, value=tail_log(200), autoscroll=True,
            )
            log_timer = gr.Timer(value=2.0, active=True)
            with gr.Row():
                log_refresh_btn = gr.Button("🔁 刷新日志")
                log_clear_btn = gr.Button("🗑️ 清空日志文件")

            scan_btn.click(
                scan, inputs=[folder],
                outputs=[scan_table, scan_msg, task_html, task_select],
            )
            ocr_btn.click(run_ocr_batch, inputs=[task_select], outputs=[task_html, run_log])
            grade_btn.click(run_grading_batch, inputs=[task_select], outputs=[task_html, run_log])
            all_btn.click(run_all, inputs=[task_select], outputs=[task_html, run_log])
            reset_btn2.click(reset_errors, outputs=[task_html, run_log])

            sel_all_btn.click(select_all_keys, outputs=task_select)
            sel_none_btn.click(lambda: [], outputs=task_select)
            sel_unf_btn.click(select_unfinished_keys, outputs=task_select)
            sel_err_btn.click(select_error_keys, outputs=task_select)
            sel_refresh_btn.click(refresh_selection, outputs=task_select)

            task_timer.tick(lambda: _task_html(), outputs=task_html)
            log_timer.tick(lambda: tail_log(200), outputs=log_box)
            log_refresh_btn.click(lambda: tail_log(500), outputs=log_box)
            log_clear_btn.click(
                lambda: (clear_log(), "(日志已清空)")[1], outputs=log_box,
            )

        with gr.Tab("✏️ 修改"):
            gr.Markdown("逐个学生查看 / 修改转写与批改结果。")
            with gr.Row():
                student_dd = gr.Dropdown(
                    choices=list_students(), label="选择学生", scale=4,
                )
                refresh_dd = gr.Button("🔁 刷新名单", scale=1)
            with gr.Row():
                edit_gallery = gr.Gallery(
                    label="原始图片（按页码顺序）", columns=3, height=420,
                    show_label=True, preview=True, object_fit="contain",
                )
                edit_info = gr.Markdown()
            edit_text = gr.Textbox(label="OCR 转写（可编辑）", lines=10)
            with gr.Row():
                rerun_ocr_btn = gr.Button("🔡 重新 OCR")
                rerun_grade_btn = gr.Button("📝 用当前转写重新批改", variant="primary")
                save_edit_btn = gr.Button("💾 保存修改")
            edit_grading = gr.Textbox(label="批改结果（Markdown，可编辑）", lines=20)
            edit_msg = gr.Markdown()

            student_dd.change(
                load_student, inputs=student_dd,
                outputs=[edit_gallery, edit_text, edit_grading, edit_info],
            )
            refresh_dd.click(
                lambda: gr.update(choices=list_students()), outputs=student_dd,
            )
            rerun_ocr_btn.click(rerun_ocr_one, inputs=student_dd, outputs=[edit_text, edit_msg])
            rerun_grade_btn.click(
                rerun_grading_one, inputs=[student_dd, edit_text],
                outputs=[edit_grading, edit_msg],
            )
            save_edit_btn.click(
                save_edits, inputs=[student_dd, edit_text, edit_grading],
                outputs=edit_msg,
            )

        with gr.Tab("📊 结果"):
            gr.Markdown("### 全部学生总览")
            ov_table = gr.Dataframe(
                headers=["学号", "姓名", "页数", "总分", "OCR", "批改", "已编辑"],
                interactive=False, wrap=True, row_count=(0, "dynamic"),
                show_search=False, show_row_numbers=False,
                value=overview_table(),
            )
            with gr.Row():
                ov_refresh = gr.Button("🔁 刷新")
                exp_all_btn = gr.Button("📦 导出汇总 Markdown")
                exp_each_btn = gr.Button("📂 导出每位学生单独文件")
            exp_msg = gr.Markdown()
            exp_all_file = gr.File(label="汇总文件")
            exp_each_files = gr.File(label="每位学生文件", file_count="multiple")

            gr.Markdown("### 单人详情")
            with gr.Row():
                detail_dd = gr.Dropdown(choices=list_students(), label="选择学生", scale=4)
                detail_refresh = gr.Button("🔁 刷新名单", scale=1)
            with gr.Row():
                detail_gallery = gr.Gallery(
                    label="原图（多页）", columns=3, height=420,
                    show_label=True, preview=True, object_fit="contain",
                )
                detail_text = gr.Textbox(label="转写", lines=20, interactive=False)
            detail_grading = gr.Markdown(label="批改")

            ov_refresh.click(lambda: overview_table(), outputs=ov_table)
            exp_all_btn.click(
                lambda: (export_markdown_all(), "✅ 已导出汇总到 data/exports/all_results.md"),
                outputs=[exp_all_file, exp_msg],
            )
            exp_each_btn.click(
                lambda: (export_markdown_per_student(), "✅ 已导出每位学生到 data/exports/per_student/"),
                outputs=[exp_each_files, exp_msg],
            )
            detail_refresh.click(
                lambda: gr.update(choices=list_students()), outputs=detail_dd,
            )
            detail_dd.change(
                view_student_detail, inputs=detail_dd,
                outputs=[detail_text, detail_grading, detail_gallery],
            )

        demo.load(lambda: tail_log(200), outputs=log_box)

    return demo


if __name__ == "__main__":
    import os
    port = int(os.getenv("GRADIO_SERVER_PORT", "7860"))
    try:
        ui = build_ui()
        logger.info(f"Gradio 启动 http://127.0.0.1:{port}")
        ui.launch(
            server_name=os.getenv("GRADIO_SERVER_NAME", "127.0.0.1"),
            server_port=port,
            inbrowser=False,
            theme=gr.themes.Soft(),
        )
    except Exception:
        traceback.print_exc()
        raise
