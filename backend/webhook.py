"""Webhook 投递器：独立的 asyncio 协程从 DB 拉 due 回调，POST 到客户配置的 URL。

设计要点：

- **独立队列**：webhook 不和 LLM worker 抢 3 Mbps 带宽。回调 body 顶多几 KB，
  就算 30 个客户同时回调也只占 ~30 KB/s。
- **HMAC-SHA256 签名**：``X-Akapen-Signature: t=<unix>,v1=<hex>``，签名等于
  ``hmac_sha256(secret, f"{t}.{body}")``。前端用同一个 secret 复算 + 校 ``|now-t|<5min``
  防重放。
- **指数退避 + 死信**：投递失败按 1s, 5s, 30s, 5min, 1h 步进，5 次后入 ``callback_status='dead'``。
  每次失败后写 ``callback_next_at``（DB 字段）让 dispatcher 后续轮询时挑出来。
- **DB 调度**：用 ``callback_status='pending' AND callback_next_at <= now`` 的部分索引
  快速找到 due 回调，dispatcher 每 ``poll_interval_sec`` 轮一次。
- **外部 timeout**：3xx/4xx 不重试；5xx / 网络异常 / 超时重试。

不会发的几种情况：
- 任务没有 ``callback_url`` —— worker 根本没调 ``set_callback_pending``
- ``callback_status`` 已经 ``delivered`` 或 ``dead``
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import time
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING

import httpx

from core.logger import reset_task_id, set_task_id
from core.schemas import GradingResult

from . import metrics
from .repo import (
    list_due_callbacks,
    update_callback_after_attempt,
)
from .schemas import TaskError, WebhookPayload

if TYPE_CHECKING:
    from .app import AppState

logger = logging.getLogger("backend.webhook")


# 失败后下次重试的间隔（秒）：第 1 次失败后等 5s 再试，依此类推。
_RETRY_SCHEDULE_SEC: tuple[int, ...] = (5, 30, 300, 3600, 21600)
# 最大尝试次数（含第一次）。等于 ``len(_RETRY_SCHEDULE_SEC) + 1``。
_MAX_ATTEMPTS = len(_RETRY_SCHEDULE_SEC) + 1
# 单次 POST 总超时
_HTTP_TIMEOUT = 15.0


class WebhookDispatcher:
    def __init__(self, state: "AppState") -> None:
        self.state = state
        self._stopping = asyncio.Event()
        self.poll_interval_sec = 5.0

    def stop(self) -> None:
        self._stopping.set()

    async def run(self) -> None:
        """主循环：每 ``poll_interval_sec`` 拉一批 due 回调并投递。"""
        logger.info("webhook dispatcher started")
        async with httpx.AsyncClient(timeout=httpx.Timeout(_HTTP_TIMEOUT)) as client:
            while not self._stopping.is_set():
                try:
                    await self._tick(client)
                except Exception:
                    logger.exception("webhook tick 异常（继续）")
                try:
                    await asyncio.wait_for(
                        self._stopping.wait(), timeout=self.poll_interval_sec,
                    )
                except asyncio.TimeoutError:
                    pass
        logger.info("webhook dispatcher exiting")

    async def _tick(self, client: httpx.AsyncClient) -> None:
        now_iso = _now_iso()
        rows = await list_due_callbacks(self.state.db, now_iso=now_iso, limit=20)
        if not rows:
            return

        logger.info(f"webhook tick: {len(rows)} due callbacks")
        # 顺序投递；同一 host 反复连接 httpx 会复用连接池
        for row in rows:
            await self._deliver_one(row, client)

    async def _deliver_one(self, row: dict, client: httpx.AsyncClient) -> None:
        task_id: str = row["task_id"]
        url: str | None = row.get("callback_url")
        if not url:
            return

        token = set_task_id(task_id)
        try:
            await self._deliver_one_inner(row, task_id, url, client)
        finally:
            reset_task_id(token)

    async def _deliver_one_inner(
        self, row: dict, task_id: str, url: str, client: httpx.AsyncClient,
    ) -> None:
        attempts_so_far: int = int(row.get("callback_attempts") or 0)

        payload = self._build_payload(row)
        body = payload.model_dump_json()
        timestamp = int(time.time())
        sig = _sign(self.state.settings.webhook_secret, timestamp, body)

        logger.info(
            f"[Webhook ▶] {task_id} → {url[:60]} "
            f"(attempt {attempts_so_far + 1}/{_MAX_ATTEMPTS})"
        )
        t0 = time.monotonic()
        try:
            resp = await client.post(
                url,
                content=body,
                headers={
                    "Content-Type": "application/json",
                    "X-Akapen-Signature": f"t={timestamp},v1={sig}",
                    "X-Akapen-Task-Id": task_id,
                    "User-Agent": "akapen-webhook/0.1",
                },
            )
        except (httpx.TimeoutException, httpx.NetworkError) as e:
            elapsed = time.monotonic() - t0
            logger.warning(
                f"[Webhook ✗] {task_id} 网络/超时 ({elapsed:.1f}s): {e}"
            )
            await self._after_attempt(
                task_id, attempts_so_far, delivered=False, error=str(e)[:500],
            )
            return
        except Exception as e:
            elapsed = time.monotonic() - t0
            logger.exception(f"[Webhook ✗] {task_id} 未预期错误 ({elapsed:.1f}s)")
            await self._after_attempt(
                task_id, attempts_so_far, delivered=False, error=str(e)[:500],
            )
            return

        elapsed = time.monotonic() - t0
        if 200 <= resp.status_code < 300:
            logger.info(f"[Webhook ✓] {task_id} {resp.status_code} ({elapsed:.1f}s)")
            await self._after_attempt(
                task_id, attempts_so_far, delivered=True, error=None,
            )
            return

        # 4xx：客户端拒收（签名错 / URL 失效）→ 不再重试，直接 dead
        if 400 <= resp.status_code < 500:
            logger.warning(
                f"[Webhook ✗] {task_id} {resp.status_code} 4xx，不重试 ({elapsed:.1f}s)"
            )
            await self._after_attempt(
                task_id, attempts_so_far, delivered=False,
                error=f"HTTP {resp.status_code}: {resp.text[:200]}",
                force_dead=True,
            )
            return

        # 5xx：可重试
        logger.warning(
            f"[Webhook ✗] {task_id} {resp.status_code} 5xx，按调度重试 ({elapsed:.1f}s)"
        )
        await self._after_attempt(
            task_id, attempts_so_far, delivered=False,
            error=f"HTTP {resp.status_code}: {resp.text[:200]}",
        )

    async def _after_attempt(
        self, task_id: str, attempts_so_far: int, *,
        delivered: bool, error: str | None, force_dead: bool = False,
    ) -> None:
        if delivered:
            await update_callback_after_attempt(
                self.state.db, task_id, delivered=True, error=None, next_at=None,
            )
            metrics.webhook_attempts_total.labels(result="delivered").inc()
            return

        if force_dead or attempts_so_far + 1 >= _MAX_ATTEMPTS:
            await update_callback_after_attempt(
                self.state.db, task_id, delivered=False, error=error, next_at=None,
            )
            metrics.webhook_attempts_total.labels(result="dead").inc()
            logger.error(f"[Webhook †] {task_id} 进入死信（attempts={attempts_so_far + 1}）")
            return

        delay_sec = _RETRY_SCHEDULE_SEC[min(attempts_so_far, len(_RETRY_SCHEDULE_SEC) - 1)]
        next_at = (
            datetime.now(timezone.utc) + timedelta(seconds=delay_sec)
        ).strftime("%Y-%m-%dT%H:%M:%SZ")
        await update_callback_after_attempt(
            self.state.db, task_id,
            delivered=False, error=error, next_at=next_at,
        )
        metrics.webhook_attempts_total.labels(result="retry").inc()

    def _build_payload(self, row: dict) -> WebhookPayload:
        result: GradingResult | None = None
        gj = row.get("grading_json")
        if gj:
            try:
                result = GradingResult.model_validate_json(gj)
            except Exception as e:
                logger.warning(
                    f"task {row['task_id']} grading_json 反序列化失败 (webhook): {e}"
                )

        error: TaskError | None = None
        if row.get("error_code"):
            error = TaskError(
                code=row["error_code"],
                message=row.get("error_message") or "",
                attempts=int(row.get("attempts") or 0),
            )
        return WebhookPayload(
            task_id=row["task_id"],
            status=row["status"],
            student_id=row["student_id"],
            student_name=row["student_name"],
            result=result,
            error=error,
            timestamp=datetime.now(timezone.utc),
        )


def _sign(secret: str, timestamp: int, body: str) -> str:
    """``hmac_sha256(secret, f"{t}.{body}")`` 输出 lowercase hex。空 secret 也允许（仅本地测试用，会发空签名）。"""
    msg = f"{timestamp}.{body}".encode("utf-8")
    digest = hmac.new(secret.encode("utf-8"), msg, hashlib.sha256).hexdigest()
    return digest


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---- 给前端集成时复用的校验 helper（导出常量）---- #


def verify_signature(secret: str, timestamp: int, body: str, expected_sig: str) -> bool:
    """前端可以 ``from backend.webhook import verify_signature`` 复用一行。"""
    actual = _sign(secret, timestamp, body)
    return hmac.compare_digest(actual, expected_sig)
