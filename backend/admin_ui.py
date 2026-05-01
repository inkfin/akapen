"""轻量 Gradio 运维后台。

挂在 FastAPI 的 ``/admin`` 子路径下（``gr.mount_gradio_app``），与中台 worker
**共用同一份 SQLite + asyncio.Queue**。能力：

- 列任务：按状态 / 学生过滤，分页
- 查看单条任务详情（OCR / 评分 / 错误 / 图片缩略图）
- 重试失败任务（直接复用 :func:`backend.repo.retry_task` + ``state.task_queue.put``）

设计取舍：
- 这是"读为主、轻写"的运维视角，**不重新实现批改流水线**——批改全走中台 worker。
- 老的 ``app.py``（独立 Gradio 批改流程）保留不动，作为离线 / 文件夹模式的工具；
  本模块是"中台时代"的 admin 视图。
- 所有 handler 必须 ``async`` ——Gradio 0.6+ 支持 async；我们要直接读异步 DB。
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import TYPE_CHECKING, Any

import gradio as gr

from .repo import (
    cancel_task as repo_cancel_task,
    list_tasks as repo_list_tasks,
    retry_task as repo_retry_task,
    get_task as repo_get_task,
)

if TYPE_CHECKING:
    from .app import AppState

logger = logging.getLogger("backend.admin_ui")


_STATUS_FILTER_CHOICES = [
    "all", "queued", "fetching_images", "preprocessing",
    "ocr_running", "grading_running", "succeeded", "failed", "cancelled",
]


def build_admin_ui(state: "AppState") -> gr.Blocks:
    """返回一个 :class:`gradio.Blocks`，由调用方挂到 FastAPI app 上。

    state 必须在 build 时已经存在（lifespan 起完）；handler 内只引用 state
    的 ``settings`` / ``db`` / ``task_queue``，这些字段是稳定的。
    """
    api_key_ids = sorted(state.settings.api_keys.keys())
    default_api_key = api_key_ids[0] if api_key_ids else ""

    async def _do_list(api_key_id: str, status_filter: str, student_id: str, limit: int):
        if not api_key_id:
            return [], "（请先选择 API Key）"
        st = None if status_filter == "all" else status_filter
        sid = student_id.strip() or None
        resp = await repo_list_tasks(
            state.db, api_key_id=api_key_id, status=st, student_id=sid,
            limit=int(limit),
        )
        rows = []
        for t in resp.items:
            rows.append([
                t.task_id,
                t.status,
                t.student_id,
                t.student_name,
                t.image_count,
                round(t.result.final_score, 1) if (t.result and t.result.final_score is not None) else None,
                round(t.result.confidence, 2) if t.result else None,
                "✓" if (t.result and t.result.review_flag) else "",
                t.created_at.isoformat() if t.created_at else "",
                t.error.code if t.error else "",
            ])
        summary = (
            f"**共 {len(resp.items)} 条** | api_key={api_key_id} | "
            f"status={status_filter} | student_id={sid or '(all)'}"
        )
        return rows, summary

    async def _do_detail(api_key_id: str, task_id: str):
        if not api_key_id or not task_id.strip():
            return "（请填 task_id）", None, [], ""
        t = await repo_get_task(state.db, task_id.strip(), api_key_id=api_key_id)
        if t is None:
            return "未找到该 task（注意：受 api_key 隔离影响）", None, [], ""

        md_lines: list[str] = [
            f"## {t.student_name} ({t.student_id})",
            f"**task_id**: `{t.task_id}`",
            f"**status**: `{t.status}`",
            f"**provider/model/mode**: {t.provider} / {t.model} / {t.mode}",
            f"**created**: {t.created_at} | **finished**: {t.finished_at or '-'}",
            f"**attempts**: {t.attempts} | **upload_bytes**: {t.upload_bytes}",
            f"**callback**: status={t.callback_status or '(none)'} attempts={t.callback_attempts}",
        ]
        if t.error:
            md_lines.append(f"\n**❌ 错误**: `{t.error.code}` — {t.error.message[:300]}")
        if t.result:
            if t.result.final_score is not None:
                score_line = f"\n**评分**: {t.result.final_score}/{t.result.max_score or '?'} | "
            else:
                score_line = "\n**评分**: 不打分（只批注）| "
            md_lines.append(
                f"{score_line}confidence={t.result.confidence:.2f} | review={t.result.review_flag}"
            )
            if t.result.review_reasons:
                md_lines.append(f"**复核理由**: {', '.join(t.result.review_reasons)}")
            md_lines.append("\n### 评语\n" + t.result.feedback)
            if t.result.transcription:
                md_lines.append("\n### 转写\n```\n" + t.result.transcription + "\n```")

        # 图片：image_paths_json 里有标准化好的本地路径
        gallery: list[str] = []
        # 直接从 DB 拉一行原始记录拿 paths_json（前端字段没暴露）
        cur = await state.db.conn.execute(
            "SELECT image_paths_json FROM grading_tasks WHERE task_id = ?",
            (t.task_id,),
        )
        row = await cur.fetchone()
        await cur.close()
        if row and row["image_paths_json"]:
            try:
                paths = json.loads(row["image_paths_json"])
                gallery = [str(p) for p in paths]
            except Exception:
                pass

        result_json: Any = t.result.model_dump(mode="json") if t.result else None
        return "\n\n".join(md_lines), result_json, gallery, t.task_id

    async def _do_retry(api_key_id: str, task_id: str):
        if not task_id.strip():
            return "（请填 task_id）"
        result = await repo_retry_task(state.db, task_id.strip(), api_key_id=api_key_id)
        if result == "ok":
            state.task_queue.put_nowait(task_id.strip())
            return f"✅ 已重新排队 task_id={task_id.strip()}"
        if result == "not_found":
            return "❌ 未找到该 task（受 api_key 隔离）"
        if result == "not_failed":
            return "⚠️ 该任务不在 failed 状态，不能 retry"
        return f"未知结果：{result}"

    async def _do_cancel(api_key_id: str, task_id: str):
        if not task_id.strip():
            return "（请填 task_id）"
        result = await repo_cancel_task(state.db, task_id.strip(), api_key_id=api_key_id)
        if result == "ok":
            return f"✅ 已取消 task_id={task_id.strip()}"
        if result == "not_found":
            return "❌ 未找到该 task"
        if result == "terminal":
            return "⚠️ 任务已在终态（succeeded/failed/cancelled），无法取消"
        return f"未知结果：{result}"

    with gr.Blocks(title="Akapen 批改运维后台") as demo:
        gr.Markdown("# 🔧 Akapen 批改任务运维后台\n_读同一份 SQLite，与 FastAPI worker 共享状态_")

        with gr.Row():
            api_key = gr.Dropdown(
                label="API Key",
                choices=api_key_ids,
                value=default_api_key,
                interactive=True,
            )
            status_dd = gr.Dropdown(
                label="状态过滤",
                choices=_STATUS_FILTER_CHOICES,
                value="all",
            )
            student_tb = gr.Textbox(label="学号过滤", placeholder="留空 = 不限")
            limit_dd = gr.Dropdown(label="条数", choices=[20, 50, 100, 200], value=50)
            list_btn = gr.Button("🔄 列表", variant="primary")

        list_summary = gr.Markdown()
        task_table = gr.Dataframe(
            headers=[
                "task_id", "status", "student_id", "student_name",
                "图数", "得分", "信心", "复核", "created_at", "error_code",
            ],
            interactive=False,
            wrap=False,
            label="任务列表（点击行复制 task_id，再去下面查看详情）",
        )

        gr.Markdown("---\n## 单任务详情")
        with gr.Row():
            detail_tid = gr.Textbox(
                label="task_id",
                placeholder="从上面表格复制 / 粘贴",
                scale=3,
            )
            view_btn = gr.Button("👀 查看", scale=1)

        detail_md = gr.Markdown()
        with gr.Accordion("评分 JSON", open=False):
            result_json = gr.JSON(value=None)
        gallery = gr.Gallery(label="标准化后的图片", show_label=True, columns=3)

        with gr.Row():
            retry_btn = gr.Button("🔁 重试（仅 failed 可用）", variant="secondary")
            cancel_btn = gr.Button("⛔ 取消（仅未终态可用）", variant="secondary")
        action_status = gr.Markdown()

        # ---- handlers ---- #
        list_btn.click(
            fn=_do_list,
            inputs=[api_key, status_dd, student_tb, limit_dd],
            outputs=[task_table, list_summary],
        )
        view_btn.click(
            fn=_do_detail,
            inputs=[api_key, detail_tid],
            outputs=[detail_md, result_json, gallery, detail_tid],
        )
        retry_btn.click(
            fn=_do_retry, inputs=[api_key, detail_tid], outputs=action_status,
        )
        cancel_btn.click(
            fn=_do_cancel, inputs=[api_key, detail_tid], outputs=action_status,
        )

        # 启动时自动拉一次列表
        demo.load(
            fn=_do_list,
            inputs=[api_key, status_dd, student_tb, limit_dd],
            outputs=[task_table, list_summary],
        )

    return demo


def mount_admin(fastapi_app, state: "AppState", path: str = "/admin") -> None:
    """把 admin UI 挂到给定 FastAPI app 的 ``path``（默认 ``/admin``）。"""
    try:
        ui = build_admin_ui(state)
    except Exception:
        logger.exception("build_admin_ui 失败，跳过 admin 挂载（继续启服务）")
        return
    gr.mount_gradio_app(fastapi_app, ui, path=path)
    logger.info(f"admin UI mounted at {path}")
