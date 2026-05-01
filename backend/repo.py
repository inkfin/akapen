"""任务表的 CRUD 层。

业务层（routes / worker / webhook）只跟本模块打交道，不直接拼 SQL。所有函数都
是 async，统一用 :class:`backend.db.Database` 的共享 connection。

幂等模型：(api_key_id, idempotency_key) 唯一。:func:`create_task` 先 INSERT OR
IGNORE，再 SELECT 拿任务行——既能识别"是新建还是命中已有"，也能避免双线程
race。

时间戳一律用 ISO-8601 with 'Z' UTC，sqlite 的 TEXT 字段存储；查询时让 pydantic
直接 datetime parse（接受带 Z 的 ISO 字符串）。
"""
from __future__ import annotations

import json
import logging
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from core.schemas import GradingResult

from .db import Database, row_to_dict
from .schemas import (
    CANCELLABLE_STATUSES,
    RETRYABLE_STATUSES,
    TERMINAL_STATUSES,
    TaskError,
    TaskListResponse,
    TaskProgress,
    TaskStatus,
)

logger = logging.getLogger("backend.repo")


# ---- 输入参数（routes / worker 用） ---- #


@dataclass
class CreateTaskInput:
    """从请求层归一化后的任务入参。multipart 和 JSON 路径都先转成这个再调 repo。"""

    api_key_id: str
    student_id: str
    student_name: str
    image_sources: list[str]            # URL 列表 或 multipart 上传相对路径
    image_paths: list[str]              # 已经落到本地磁盘的标准化 JPEG 路径
    idempotency_key: str | None = None
    callback_url: str | None = None
    rubric_id: str | None = None
    rubric_version: str | None = None
    provider: str | None = None
    model: str | None = None
    mode: str | None = None             # 'single_shot' / 'two_step_text' / 'two_step_vision'
    # 题目上下文（题干 + 可选参考答案），由 grader 拼到 prompt 顶部
    question_context: str | None = None
    # v3：前端递过来的整套 override（prompts / thinking / ocr_provider 等）。
    # 不传 = 沿用 backend Settings；传了 worker 跑任务时优先用这里。
    overrides: dict | None = None


# ---- helpers ---- #


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _row_to_status(row: dict | None) -> TaskStatus | None:
    if row is None:
        return None

    progress_payload = TaskProgress(
        fetching_images=row["status"] not in ("queued",),
        preprocessing=row["status"] not in ("queued", "fetching_images"),
        ocr=row["status"] in ("ocr_running", "grading_running", "succeeded")
        or (row["status"] == "succeeded" and row.get("transcription")),
        grading=row["status"] == "succeeded",
    )

    error: TaskError | None = None
    if row["error_code"]:
        error = TaskError(
            code=row["error_code"],
            message=row.get("error_message") or "",
            attempts=int(row.get("attempts") or 0),
        )

    result: GradingResult | None = None
    if row.get("grading_json"):
        try:
            result = GradingResult.model_validate_json(row["grading_json"])
        except Exception as e:
            logger.warning(
                f"task {row['task_id']} grading_json 反序列化失败: {e}; 当作没结果返回"
            )

    image_sources = json.loads(row["image_sources_json"] or "[]")

    return TaskStatus(
        task_id=row["task_id"],
        status=row["status"],
        student_id=row["student_id"],
        student_name=row["student_name"],
        idempotency_key=row.get("idempotency_key"),
        image_count=len(image_sources),
        image_sources=image_sources,
        progress=progress_payload,
        result=result,
        error=error,
        rubric_id=row.get("rubric_id"),
        rubric_version=row.get("rubric_version"),
        provider=row.get("provider"),
        model=row.get("model"),
        mode=row.get("mode"),
        callback_url=row.get("callback_url"),
        callback_status=row.get("callback_status"),
        callback_attempts=int(row.get("callback_attempts") or 0),
        upload_bytes=int(row.get("upload_bytes") or 0),
        attempts=int(row.get("attempts") or 0),
        created_at=row["created_at"],
        started_at=row.get("started_at"),
        finished_at=row.get("finished_at"),
        updated_at=row["updated_at"],
    )


# ---- create / get ---- #


async def create_task(db: Database, inp: CreateTaskInput) -> tuple[str, bool]:
    """创建任务，幂等。

    返回 ``(task_id, idempotent)``：
    - ``idempotent=True`` 表示命中已有 idempotency_key，原 task_id 直接复用；
    - ``idempotent=False`` 表示新建。
    """
    now = _now_iso()
    new_id = uuid4().hex

    if inp.idempotency_key:
        # 先 SELECT，命中就直接返；否则 INSERT OR IGNORE，命中竞态再 SELECT 一次
        existing = await db.conn.execute(
            "SELECT task_id FROM grading_tasks "
            "WHERE api_key_id = ? AND idempotency_key = ?",
            (inp.api_key_id, inp.idempotency_key),
        )
        row = await existing.fetchone()
        await existing.close()
        if row is not None:
            return row["task_id"], True

    overrides_json = (
        json.dumps(inp.overrides, ensure_ascii=False) if inp.overrides else None
    )

    await db.conn.execute(
        """
        INSERT OR IGNORE INTO grading_tasks (
            task_id, idempotency_key, api_key_id,
            student_id, student_name,
            status,
            image_sources_json, image_paths_json,
            review_flag, callback_attempts,
            callback_url, rubric_id, rubric_version,
            provider, model, mode,
            question_context,
            overrides_json,
            attempts, upload_bytes,
            created_at, updated_at
        ) VALUES (
            ?, ?, ?,
            ?, ?,
            'queued',
            ?, ?,
            0, 0,
            ?, ?, ?,
            ?, ?, ?,
            ?,
            ?,
            0, 0,
            ?, ?
        )
        """,
        (
            new_id, inp.idempotency_key, inp.api_key_id,
            inp.student_id, inp.student_name,
            json.dumps(inp.image_sources, ensure_ascii=False),
            json.dumps(inp.image_paths, ensure_ascii=False),
            inp.callback_url, inp.rubric_id, inp.rubric_version,
            inp.provider, inp.model, inp.mode,
            inp.question_context,
            overrides_json,
            now, now,
        ),
    )

    # 回查一次：如果 INSERT OR IGNORE 因为 idempotency_key UNIQUE 冲突没插进去，
    # 这里就会拿到原 task_id；正常情况下拿到 new_id。
    if inp.idempotency_key:
        cur = await db.conn.execute(
            "SELECT task_id FROM grading_tasks "
            "WHERE api_key_id = ? AND idempotency_key = ?",
            (inp.api_key_id, inp.idempotency_key),
        )
        row = await cur.fetchone()
        await cur.close()
        if row and row["task_id"] != new_id:
            # 竞态命中，捡掉了别人的 task_id；真要清理上面已经 INSERT OR IGNORE
            # 的那条空记录吗？—— UNIQUE 约束保证 INSERT 没生效，所以不用清理。
            return row["task_id"], True
    return new_id, False


async def get_task(db: Database, task_id: str, *, api_key_id: str | None = None) -> TaskStatus | None:
    """读单条任务。``api_key_id`` 不为空时做隔离：拿不到就当不存在（避免泄露 task_id 列表）。"""
    if api_key_id is None:
        cur = await db.conn.execute(
            "SELECT * FROM grading_tasks WHERE task_id = ?", (task_id,)
        )
    else:
        cur = await db.conn.execute(
            "SELECT * FROM grading_tasks WHERE task_id = ? AND api_key_id = ?",
            (task_id, api_key_id),
        )
    row = await cur.fetchone()
    await cur.close()
    return _row_to_status(row_to_dict(row))


async def list_tasks(
    db: Database, *,
    api_key_id: str,
    status: str | None = None,
    student_id: str | None = None,
    since: str | None = None,
    limit: int = 50,
    cursor: str | None = None,  # task_id of last seen item; we paginate by created_at desc
) -> TaskListResponse:
    """按 ``api_key_id`` 隔离的任务列表，按 created_at desc。"""
    sql = ["SELECT * FROM grading_tasks WHERE api_key_id = ?"]
    params: list[Any] = [api_key_id]

    if status:
        sql.append("AND status = ?")
        params.append(status)
    if student_id:
        sql.append("AND student_id = ?")
        params.append(student_id)
    if since:
        sql.append("AND created_at >= ?")
        params.append(since)
    if cursor:
        cur = await db.conn.execute(
            "SELECT created_at FROM grading_tasks WHERE task_id = ? AND api_key_id = ?",
            (cursor, api_key_id),
        )
        cursor_row = await cur.fetchone()
        await cur.close()
        if cursor_row:
            sql.append("AND created_at < ?")
            params.append(cursor_row["created_at"])

    sql.append("ORDER BY created_at DESC LIMIT ?")
    params.append(min(max(1, limit), 200))

    cur = await db.conn.execute(" ".join(sql), tuple(params))
    rows = await cur.fetchall()
    await cur.close()

    items = [s for s in (_row_to_status(row_to_dict(r)) for r in rows) if s is not None]
    next_cursor = items[-1].task_id if len(items) == int(params[-1]) else None
    return TaskListResponse(items=items, next_cursor=next_cursor)


# ---- 状态机转换 ---- #


async def transition_status(
    db: Database, task_id: str, new_status: str, *,
    started: bool = False, finished: bool = False,
    error_code: str | None = None, error_message: str | None = None,
) -> bool:
    """更新状态字段。返回是否真的修改了行。

    可选 ``started=True`` 写 ``started_at``、``finished=True`` 写 ``finished_at``。
    错误信息一并写入；状态非 error/failed 时调用方应传 ``error_code=None, error_message=None``。
    """
    now = _now_iso()
    sets = ["status = ?", "updated_at = ?"]
    vals: list[Any] = [new_status, now]
    if started:
        sets.append("started_at = COALESCE(started_at, ?)")
        vals.append(now)
    if finished:
        sets.append("finished_at = ?")
        vals.append(now)
    sets.append("error_code = ?")
    vals.append(error_code)
    sets.append("error_message = ?")
    vals.append(error_message)

    vals.append(task_id)
    cur = await db.conn.execute(
        f"UPDATE grading_tasks SET {', '.join(sets)} WHERE task_id = ?",
        tuple(vals),
    )
    return cur.rowcount > 0


async def increment_attempts(db: Database, task_id: str) -> int:
    """attempts + 1，返回新值。"""
    cur = await db.conn.execute(
        "UPDATE grading_tasks SET attempts = attempts + 1, updated_at = ? "
        "WHERE task_id = ? RETURNING attempts",
        (_now_iso(), task_id),
    )
    row = await cur.fetchone()
    await cur.close()
    return int(row["attempts"]) if row else 0


async def add_upload_bytes(db: Database, task_id: str, n: int) -> None:
    """累加这条任务总共上传到 LLM 的字节数（指标用）。"""
    if n <= 0:
        return
    await db.conn.execute(
        "UPDATE grading_tasks SET upload_bytes = upload_bytes + ?, updated_at = ? "
        "WHERE task_id = ?",
        (n, _now_iso(), task_id),
    )


async def save_grading_result(
    db: Database, task_id: str, *,
    transcription: str,
    grading: GradingResult,
    provider: str, model: str, mode: str,
) -> None:
    """成功完成时一次性写入所有结果字段，并把状态推到 ``succeeded``。"""
    now = _now_iso()
    await db.conn.execute(
        """
        UPDATE grading_tasks SET
            status = 'succeeded',
            transcription = ?,
            grading_json = ?,
            final_score = ?,
            confidence = ?,
            review_flag = ?,
            review_reasons_json = ?,
            provider = ?,
            model = ?,
            mode = ?,
            error_code = NULL,
            error_message = NULL,
            finished_at = ?,
            updated_at = ?
        WHERE task_id = ?
        """,
        (
            transcription,
            grading.model_dump_json(),
            float(grading.final_score) if grading.final_score is not None else None,
            float(grading.confidence),
            int(grading.review_flag),
            json.dumps(grading.review_reasons, ensure_ascii=False),
            provider, model, mode,
            now, now,
            task_id,
        ),
    )


# ---- callback 状态 ---- #


async def set_callback_pending(db: Database, task_id: str, *, next_at: str) -> None:
    """初始化回调投递为 pending（任务成功 / 失败时调一次）。"""
    await db.conn.execute(
        "UPDATE grading_tasks SET callback_status = 'pending', "
        "callback_attempts = 0, callback_next_at = ?, updated_at = ? "
        "WHERE task_id = ? AND callback_url IS NOT NULL",
        (next_at, _now_iso(), task_id),
    )


async def update_callback_after_attempt(
    db: Database, task_id: str, *,
    delivered: bool, error: str | None, next_at: str | None,
) -> None:
    """回调投递一次后更新 attempts / status / next_at。"""
    if delivered:
        await db.conn.execute(
            "UPDATE grading_tasks SET callback_status = 'delivered', "
            "callback_attempts = callback_attempts + 1, "
            "callback_last_error = NULL, callback_next_at = NULL, "
            "updated_at = ? WHERE task_id = ?",
            (_now_iso(), task_id),
        )
        return

    new_status = "pending" if next_at else "dead"
    await db.conn.execute(
        "UPDATE grading_tasks SET callback_status = ?, "
        "callback_attempts = callback_attempts + 1, "
        "callback_last_error = ?, callback_next_at = ?, "
        "updated_at = ? WHERE task_id = ?",
        (new_status, (error or "")[:500], next_at, _now_iso(), task_id),
    )


async def list_due_callbacks(db: Database, *, now_iso: str, limit: int = 50) -> list[dict]:
    """列出到点了的 pending 回调。"""
    cur = await db.conn.execute(
        "SELECT * FROM grading_tasks WHERE callback_status = 'pending' "
        "AND callback_next_at IS NOT NULL AND callback_next_at <= ? "
        "ORDER BY callback_next_at ASC LIMIT ?",
        (now_iso, limit),
    )
    rows = await cur.fetchall()
    await cur.close()
    return [row_to_dict(r) or {} for r in rows]


# ---- 取消 / 重试 ---- #


async def cancel_task(db: Database, task_id: str, *, api_key_id: str) -> str:
    """把任务推到 ``cancelled``。返回结果："ok" / "terminal" / "not_found"。"""
    cur = await db.conn.execute(
        "SELECT status FROM grading_tasks WHERE task_id = ? AND api_key_id = ?",
        (task_id, api_key_id),
    )
    row = await cur.fetchone()
    await cur.close()
    if row is None:
        return "not_found"
    if row["status"] in TERMINAL_STATUSES:
        return "terminal"
    if row["status"] not in CANCELLABLE_STATUSES:
        return "terminal"
    now = _now_iso()
    await db.conn.execute(
        "UPDATE grading_tasks SET status='cancelled', "
        "error_code='CANCELLED', error_message='cancelled by user', "
        "finished_at = ?, updated_at = ? WHERE task_id = ?",
        (now, now, task_id),
    )
    return "ok"


async def retry_task(db: Database, task_id: str, *, api_key_id: str) -> str:
    """重置失败任务回 ``queued``。返回结果："ok" / "not_failed" / "not_found"。"""
    cur = await db.conn.execute(
        "SELECT status FROM grading_tasks WHERE task_id = ? AND api_key_id = ?",
        (task_id, api_key_id),
    )
    row = await cur.fetchone()
    await cur.close()
    if row is None:
        return "not_found"
    if row["status"] not in RETRYABLE_STATUSES:
        return "not_failed"
    await db.conn.execute(
        "UPDATE grading_tasks SET status='queued', "
        "error_code=NULL, error_message=NULL, finished_at=NULL, updated_at=? "
        "WHERE task_id = ?",
        (_now_iso(), task_id),
    )
    return "ok"


# ---- 启动时 reclaim ---- #

_STUCK_STATUSES: tuple[str, ...] = (
    "fetching_images", "preprocessing", "ocr_running", "grading_running",
)


async def reclaim_stuck_tasks(db: Database) -> int:
    """启动时把所有"运行中"任务重置成 queued + attempts+1，返回受影响行数。

    崩溃 / 强行重启场景下避免任务永远卡在 running。
    """
    placeholders = ",".join(["?"] * len(_STUCK_STATUSES))
    cur = await db.conn.execute(
        f"UPDATE grading_tasks SET status='queued', "
        f"attempts = attempts + 1, updated_at = ? "
        f"WHERE status IN ({placeholders})",
        (_now_iso(), *_STUCK_STATUSES),
    )
    return cur.rowcount


async def list_queued_task_ids(db: Database) -> list[str]:
    """startup 时把所有 queued 状态的任务 ID 拉出来塞回内存队列。"""
    cur = await db.conn.execute(
        "SELECT task_id FROM grading_tasks WHERE status='queued' "
        "ORDER BY created_at ASC"
    )
    rows = await cur.fetchall()
    await cur.close()
    return [r["task_id"] for r in rows]


# ---- worker 用：拿任务详细数据跑 ---- #


@dataclass
class TaskRunData:
    """worker 跑一条任务时需要的完整字段。"""
    task_id: str
    api_key_id: str
    student_id: str
    student_name: str
    image_paths: list[str]
    image_sources: list[str]
    callback_url: str | None
    provider_override: str | None
    model_override: str | None
    mode_override: str | None
    rubric_id: str | None
    rubric_version: str | None
    attempts: int
    status: str
    question_context: str | None = None
    # v3：前端递来的 overrides（prompts / thinking / ocr_*）；worker 优先用，没传退到 Settings
    overrides: dict | None = None


async def get_task_run_data(db: Database, task_id: str) -> TaskRunData | None:
    cur = await db.conn.execute(
        "SELECT * FROM grading_tasks WHERE task_id = ?", (task_id,)
    )
    row = await cur.fetchone()
    await cur.close()
    if row is None:
        return None
    overrides_raw = row["overrides_json"]
    overrides: dict | None = None
    if overrides_raw:
        try:
            overrides = json.loads(overrides_raw)
            if not isinstance(overrides, dict):
                overrides = None
        except json.JSONDecodeError:
            logger.warning(
                f"task {row['task_id']} overrides_json 不是合法 JSON，按 None 处理"
            )
            overrides = None
    return TaskRunData(
        task_id=row["task_id"],
        api_key_id=row["api_key_id"],
        student_id=row["student_id"],
        student_name=row["student_name"],
        image_paths=json.loads(row["image_paths_json"] or "[]"),
        image_sources=json.loads(row["image_sources_json"] or "[]"),
        callback_url=row["callback_url"],
        provider_override=row["provider"],
        model_override=row["model"],
        mode_override=row["mode"],
        rubric_id=row["rubric_id"],
        rubric_version=row["rubric_version"],
        attempts=int(row["attempts"] or 0),
        status=row["status"],
        # v2 起加了这列；ALTER ADD COLUMN 后老行该列是 NULL，取出来就是 None
        question_context=row["question_context"],
        overrides=overrides,
    )
