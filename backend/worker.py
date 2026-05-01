"""异步任务 worker：消费 ``state.task_queue`` 并跑 OCR + 批改。

并发模型（2C2G + 3 Mbps 专项）：

1. 主循环单协程拉队列，拉到一条就 ``asyncio.create_task`` 派发，**不阻塞**主循环。
2. 每个派发出去的子任务在进真正的工作前先 ``await semaphore.acquire()``——
   这就是 ``Semaphore(8)``：保证同时在跑的任务数 ≤ 8，剩下的会等。
3. 真正调 LLM 之前再 ``await bucket.acquire(payload_bytes)``——令牌桶按
   ``bandwidth_kbps × 0.8`` 限速，防止 8 个连接同时把 3 Mbps 打满触发 stall。

模式选择：

- ``run_data.mode_override == 'single_shot'``：强制 single-shot
- 否则按 ``settings.enable_single_shot`` + ``provider.is_vision_model(model)`` 决定
- 不能 single-shot → 退化为两步（OCR + 批改）；批改是 vision 还是 text 由
  ``settings.grading_with_image`` 决定

错误分类（写入 ``error_code``）：

- ``TIMEOUT``：单任务 wall-clock 超 ``task_timeout_sec``
- ``IMAGE_FETCH_FAILED`` / ``IMAGE_TOO_LARGE`` / ``IMAGE_BAD_MIME`` / ``IMAGE_DECODE_FAILED``：fetcher 抛出
- ``OCR_FAILED`` / ``GRADING_FAILED`` / ``SINGLE_SHOT_FAILED``：core 业务层抛出
- ``UNEXPECTED``：兜底
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import TYPE_CHECKING

from core.config import (
    GRADING_JPEG_QUALITY,
    GRADING_MAX_LONG_SIDE,
    OCR_JPEG_QUALITY,
    OCR_MAX_LONG_SIDE,
)
from core.grader import GradingError, grade_json, single_shot
from core.imageproc import standardize_jpeg_bytes
from core.logger import reset_task_id, set_task_id
from core.ocr import OCRError, transcribe
from core.providers import Provider, ProviderError, make_provider

from . import metrics
from .fetcher import FetchConfig, FetcherError, fetch_many
from .repo import (
    TaskRunData,
    add_upload_bytes,
    get_task_run_data,
    increment_attempts,
    save_grading_result,
    set_callback_pending,
    transition_status,
)
from .token_bucket import TokenBucket

if TYPE_CHECKING:
    from .app import AppState

logger = logging.getLogger("backend.worker")


class Worker:
    def __init__(self, state: "AppState") -> None:
        self.state = state
        self._stopping = asyncio.Event()
        self._semaphore = asyncio.Semaphore(state.settings.max_concurrency)
        self._bucket = TokenBucket.from_kbps(
            state.settings.bandwidth_kbps, burst_seconds=2.0,
        )
        self._provider_cache: dict[str, Provider] = {}
        self._inflight: set[asyncio.Task] = set()

    def stop(self) -> None:
        self._stopping.set()

    async def run(self) -> None:
        """主循环：从 queue 拉 task_id，create_task 派发，不阻塞。

        stop 后会等所有 in-flight task 完成（最多 ``task_timeout_sec`` 由 lifespan 控）。
        """
        logger.info(
            f"worker started: max_concurrency={self.state.settings.max_concurrency}, "
            f"bandwidth_kbps={self.state.settings.bandwidth_kbps}"
        )
        while not self._stopping.is_set():
            try:
                tid = await asyncio.wait_for(
                    self.state.task_queue.get(), timeout=1.0,
                )
            except asyncio.TimeoutError:
                continue

            t = asyncio.create_task(self._dispatch(tid), name=f"task-{tid[:8]}")
            self._inflight.add(t)
            t.add_done_callback(self._inflight.discard)

        logger.info(f"worker stopping; waiting on {len(self._inflight)} in-flight tasks")
        if self._inflight:
            try:
                await asyncio.gather(*self._inflight, return_exceptions=True)
            except Exception:
                pass
        logger.info("worker exited")

    # ---- 单任务派发 ---- #

    async def _dispatch(self, tid: str) -> None:
        """semaphore + 任务级 timeout 包一层，再调 _do_task 的具体业务。

        本协程整个上下文绑 ``task_id``，让 provider / fetcher / webhook 的日志
        自动带 ``[task=xxxxxxxx]`` 前缀，方便链路 grep。
        """
        token = set_task_id(tid)
        try:
            async with self._semaphore:
                metrics.tasks_in_flight.inc()
                started_mono = time.monotonic()
                outcome = "failed"
                mode_label = "unknown"
                try:
                    await asyncio.wait_for(
                        self._do_task(tid),
                        timeout=self.state.settings.task_timeout_sec,
                    )
                    outcome = "succeeded"
                except asyncio.TimeoutError:
                    logger.error(f"[Task ✗] {tid} TIMEOUT after "
                                 f"{self.state.settings.task_timeout_sec}s")
                    await self._mark_failed(tid, "TIMEOUT", "wall-clock exceeded")
                except Exception as e:
                    logger.exception(f"[Task ✗] {tid} unexpected: {e}")
                    await self._mark_failed(tid, "UNEXPECTED", str(e)[:500])
                finally:
                    elapsed = time.monotonic() - started_mono
                    metrics.tasks_in_flight.dec()
                    metrics.task_duration_seconds.labels(
                        mode=mode_label, status=outcome,
                    ).observe(elapsed)
                    logger.info(
                        f"[Task =] {tid} dispatch finished in {elapsed:.1f}s "
                        f"(outcome={outcome})"
                    )
        finally:
            self.state.task_queue.task_done()
            reset_task_id(token)

    # ---- 真正业务 ---- #

    async def _do_task(self, tid: str) -> None:
        run_data = await get_task_run_data(self.state.db, tid)
        if run_data is None:
            logger.warning(f"[Task ⚠] {tid} 不在 DB（被删除？跳过）")
            return
        if run_data.status == "cancelled":
            logger.info(f"[Task ⚠] {tid} 已被取消，跳过")
            return

        await increment_attempts(self.state.db, tid)
        await transition_status(self.state.db, tid, "fetching_images", started=True)

        # 1. fetching + standardize
        try:
            std_paths, std_bytes_list = await self._prepare_images(run_data)
        except FetcherError as e:
            metrics.fetch_errors_total.labels(code=e.code).inc()
            await self._mark_failed(tid, e.code, e.message)
            return

        # 把标准化后的本地路径写回去（webhook 出参不暴露这个，仅运维/Gradio 用）
        await self._save_image_paths(tid, std_paths)
        await transition_status(self.state.db, tid, "preprocessing")

        # 2. 选模式
        # overrides 优先级：run_data.overrides[k] 显式存在 → settings.core.k 默认 → fallback
        # （web 端老师的 WebSettings 走 overrides 通道；demo Gradio 走 settings.core）
        s = self.state.settings.core
        ov = run_data.overrides or {}
        provider_name = run_data.provider_override or ov.get("provider") or s.grading_provider
        model = run_data.model_override or ov.get("model") or s.grading_model
        provider = self._get_provider(provider_name)

        is_vision = provider.is_vision_model(model)
        # mode 决定：run_data.mode_override（来自 _resolve_overrides）已优先；
        # 否则按 overrides 的 enable_single_shot / grading_with_image 推；
        # 都没传时退到全局 Settings。
        enable_single_shot = ov.get("enable_single_shot")
        if enable_single_shot is None:
            enable_single_shot = s.enable_single_shot
        grading_with_image = ov.get("grading_with_image")
        if grading_with_image is None:
            grading_with_image = s.grading_with_image
        if run_data.mode_override:
            mode = run_data.mode_override
        elif enable_single_shot and is_vision:
            mode = "single_shot"
        elif grading_with_image and is_vision:
            mode = "two_step_vision"
        else:
            mode = "two_step_text"

        # 3. 跑 LLM
        total_bytes = sum(len(b) for b in std_bytes_list)
        try:
            if mode == "single_shot":
                transcription, grading = await self._run_single_shot(
                    run_data, provider, model, std_bytes_list, total_bytes,
                )
            else:
                transcription, grading = await self._run_two_step(
                    run_data, provider_name, model, std_bytes_list, total_bytes,
                    grading_with_image=(mode == "two_step_vision"),
                )
        except OCRError as e:
            await self._mark_failed(tid, "OCR_FAILED", str(e)[:500])
            return
        except GradingError as e:
            await self._mark_failed(tid, "GRADING_FAILED", str(e)[:500])
            return
        except ProviderError as e:
            await self._mark_failed(tid, "PROVIDER_ERROR", str(e)[:500])
            return

        # 4. 落库 + 调度 webhook
        await save_grading_result(
            self.state.db, tid,
            transcription=transcription,
            grading=grading,
            provider=provider_name,
            model=model,
            mode=mode,
        )
        if run_data.callback_url:
            now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            await set_callback_pending(self.state.db, tid, next_at=now)

        # 5. metrics
        metrics.tasks_finished_total.labels(status="succeeded", mode=mode).inc()
        logger.info(
            f"[Task ✓] {tid} succeeded (mode={mode}, score={grading.final_score}, "
            f"conf={grading.confidence:.2f}, review={grading.review_flag})"
        )

    # ---- 子步骤 ---- #

    async def _prepare_images(
        self, run_data: TaskRunData,
    ) -> tuple[list[str], list[bytes]]:
        """根据 ``image_sources`` 决定下载（URL）或读盘（multipart 已落地的 raw）；
        然后把每张图标准化成 1600/85 JPEG，写到 ``upload_dir/<task_id>/std/0X.jpg``。

        返回 ``(local_paths_str, standardized_bytes_list)``。
        """
        upload_root = self.state.settings.upload_dir / run_data.task_id / "std"
        upload_root.mkdir(parents=True, exist_ok=True)

        urls = [s for s in run_data.image_sources if _looks_like_url(s)]
        local = [s for s in run_data.image_sources if not _looks_like_url(s)]

        std_bytes: list[bytes] = []

        # URL 入参：fetch_many 一次性下载 + 标准化
        if urls:
            cfg = FetchConfig(max_image_bytes=self.state.settings.max_image_bytes)
            results = await fetch_many(
                urls, dest_dir=upload_root, cfg=cfg,
                max_long_side=OCR_MAX_LONG_SIDE,
                quality=OCR_JPEG_QUALITY,
                concurrency=4,
            )
            for r in results:
                std_bytes.append(r.standardized_bytes)
                metrics.fetch_bytes_total.inc(len(r.standardized_bytes))

        # 本地入参（multipart 已经落地的 raw 文件）：读盘 + 标准化
        if local:
            std_paths_local = []
            for idx, raw_path_str in enumerate(local):
                raw_path = Path(raw_path_str)
                if not raw_path.exists():
                    raise FetcherError(
                        "IMAGE_FETCH_FAILED",
                        f"multipart 上传的本地图片不存在：{raw_path}",
                    )
                raw = raw_path.read_bytes()
                try:
                    std = await asyncio.to_thread(
                        standardize_jpeg_bytes,
                        raw,
                        max_long_side=OCR_MAX_LONG_SIDE,
                        quality=OCR_JPEG_QUALITY,
                        label=raw_path.name,
                    )
                except Exception as e:
                    raise FetcherError(
                        "IMAGE_DECODE_FAILED",
                        f"multipart 图片解码失败 {raw_path}: {e}",
                    ) from e
                # multipart 路径：std 文件按 url 序列号衔接（先 URL 再 local）
                idx_total = len(urls) + idx
                dest = upload_root / f"{idx_total:02d}.jpg"
                dest.write_bytes(std)
                std_bytes.append(std)
                std_paths_local.append(dest)

        std_paths = sorted(upload_root.glob("*.jpg"))
        return [str(p) for p in std_paths], std_bytes

    async def _save_image_paths(self, tid: str, paths: list[str]) -> None:
        import json as _json
        await self.state.db.conn.execute(
            "UPDATE grading_tasks SET image_paths_json = ?, updated_at = "
            "datetime('now') WHERE task_id = ?",
            (_json.dumps(paths, ensure_ascii=False), tid),
        )

    async def _run_single_shot(
        self,
        run_data: TaskRunData,
        provider: Provider,
        model: str,
        image_bytes_list: list[bytes],
        total_bytes: int,
    ) -> tuple[str, "object"]:
        """跑 single-shot：一次 vision 调用同时返 transcription + grading。"""
        await transition_status(self.state.db, run_data.task_id, "grading_running")
        await self._reserve_bandwidth(total_bytes)

        s = self.state.settings.core
        ov = run_data.overrides or {}
        kind = "single_shot"
        # prompt / thinking 优先用 overrides
        prompt = ov.get("single_shot_prompt") or s.single_shot_prompt
        if not prompt.strip():
            raise GradingError("single_shot_prompt 为空（检查 prompts/single_shot.md）")
        thinking = ov.get("grading_thinking")
        if thinking is None:
            thinking = s.grading_thinking

        t0 = time.monotonic()
        try:
            result = await asyncio.to_thread(
                single_shot,
                image_paths=None,
                image_bytes=image_bytes_list,
                student_id=run_data.student_id,
                student_name=run_data.student_name,
                provider=provider,
                model=model,
                prompt_template=prompt,
                thinking=thinking,
                timeout_sec=s.grading_timeout_sec,
                max_attempts=max(2, s.max_attempts),
                question_context=run_data.question_context,
            )
        except (ProviderError, GradingError) as e:
            metrics.provider_errors_total.labels(
                provider=provider.name, kind=_classify_err(e)
            ).inc()
            raise
        finally:
            elapsed = time.monotonic() - t0
            metrics.llm_call_seconds.labels(provider=provider.name, kind=kind).observe(elapsed)
            metrics.upload_bytes_total.labels(provider=provider.name, model=model).inc(total_bytes)
            await add_upload_bytes(self.state.db, run_data.task_id, total_bytes)

        return result.transcription, result.grading

    async def _run_two_step(
        self,
        run_data: TaskRunData,
        provider_name: str,
        model: str,
        image_bytes_list: list[bytes],
        total_bytes: int,
        *,
        grading_with_image: bool,
    ) -> tuple[str, "object"]:
        """两步：OCR（vision）→ 批改（text 或 vision）。"""
        s = self.state.settings.core
        ov = run_data.overrides or {}

        # OCR 用独立的 ocr_provider / ocr_model（与批改的 provider/model 解耦）
        ocr_provider_name = ov.get("ocr_provider") or s.ocr_provider
        ocr_model = ov.get("ocr_model") or s.ocr_model
        ocr_prompt = ov.get("ocr_prompt") or s.ocr_prompt
        ocr_provider = self._get_provider(ocr_provider_name)

        await transition_status(self.state.db, run_data.task_id, "ocr_running")
        await self._reserve_bandwidth(total_bytes)

        t0 = time.monotonic()
        try:
            transcription = await asyncio.to_thread(
                transcribe,
                image_paths=None,
                image_bytes=image_bytes_list,
                provider=ocr_provider,
                model=ocr_model,
                prompt=ocr_prompt,
                timeout_sec=s.ocr_timeout_sec,
                max_attempts=max(2, s.max_attempts),
                label=f"{run_data.student_name}({run_data.student_id})",
            )
        except (ProviderError, OCRError) as e:
            metrics.provider_errors_total.labels(
                provider=ocr_provider.name, kind=_classify_err(e)
            ).inc()
            raise
        finally:
            elapsed = time.monotonic() - t0
            metrics.llm_call_seconds.labels(
                provider=ocr_provider.name, kind="ocr",
            ).observe(elapsed)
            metrics.upload_bytes_total.labels(
                provider=ocr_provider.name, model=ocr_model,
            ).inc(total_bytes)
            await add_upload_bytes(self.state.db, run_data.task_id, total_bytes)

        # 批改阶段
        grading_provider = self._get_provider(provider_name)
        await transition_status(self.state.db, run_data.task_id, "grading_running")

        # 批改要不要带图：vision 模式带；否则不带
        if grading_with_image:
            # 重新发图（再消耗一次 token）。批改用低画质档省带宽
            grading_bytes = await asyncio.to_thread(
                _restandardize_for_grading, image_bytes_list,
            )
            grading_total = sum(len(b) for b in grading_bytes)
            await self._reserve_bandwidth(grading_total)
        else:
            grading_bytes = []
            grading_total = 0

        # grading prompt / thinking 也走 overrides 优先
        grading_prompt = ov.get("grading_prompt") or s.grading_prompt
        thinking = ov.get("grading_thinking")
        if thinking is None:
            thinking = s.grading_thinking

        t1 = time.monotonic()
        try:
            grading = await asyncio.to_thread(
                grade_json,
                transcription=transcription,
                student_id=run_data.student_id,
                student_name=run_data.student_name,
                provider=grading_provider,
                model=model,
                prompt_template=grading_prompt,
                image_paths=None,
                image_bytes=grading_bytes if grading_with_image else None,
                thinking=thinking,
                timeout_sec=s.grading_timeout_sec,
                max_attempts=max(2, s.max_attempts),
                question_context=run_data.question_context,
            )
        except (ProviderError, GradingError) as e:
            metrics.provider_errors_total.labels(
                provider=grading_provider.name, kind=_classify_err(e)
            ).inc()
            raise
        finally:
            elapsed = time.monotonic() - t1
            metrics.llm_call_seconds.labels(
                provider=grading_provider.name, kind="grading",
            ).observe(elapsed)
            if grading_total > 0:
                metrics.upload_bytes_total.labels(
                    provider=grading_provider.name, model=model,
                ).inc(grading_total)
                await add_upload_bytes(self.state.db, run_data.task_id, grading_total)

        return transcription, grading

    async def _reserve_bandwidth(self, n: int) -> None:
        """走 token bucket。VPC 模式下桶其实可以跳过，简化实现就一起走。"""
        if n <= 0:
            return
        t0 = time.monotonic()
        await self._bucket.acquire(n)
        wait = time.monotonic() - t0
        if wait > 0.05:
            metrics.bucket_wait_seconds.observe(wait)

    def _get_provider(self, name: str) -> Provider:
        """provider 复用：同名 provider 实例缓存（其实就是个轻量 config 载体）。"""
        if name not in self._provider_cache:
            self._provider_cache[name] = make_provider(name, self.state.settings.core)
        return self._provider_cache[name]

    async def _mark_failed(self, tid: str, code: str, message: str) -> None:
        """统一失败落库 + 调度 webhook 失败通知。"""
        try:
            await transition_status(
                self.state.db, tid, "failed",
                finished=True, error_code=code, error_message=message,
            )
            metrics.tasks_finished_total.labels(status="failed", mode="unknown").inc()
            # 失败也通知前端（如果配置了 webhook）
            run_data = await get_task_run_data(self.state.db, tid)
            if run_data and run_data.callback_url:
                now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                await set_callback_pending(self.state.db, tid, next_at=now)
        except Exception:
            logger.exception(f"_mark_failed 自身异常 task={tid}")


# ---- module-level helpers ---- #


def _looks_like_url(s: str) -> bool:
    return s.startswith("http://") or s.startswith("https://")


def _restandardize_for_grading(image_bytes_list: list[bytes]) -> list[bytes]:
    """两步模式 + grading_with_image=True 时，把 OCR 用的 1600/85 重压成 1280/75。"""
    out: list[bytes] = []
    for data in image_bytes_list:
        try:
            out.append(standardize_jpeg_bytes(
                data,
                max_long_side=GRADING_MAX_LONG_SIDE,
                quality=GRADING_JPEG_QUALITY,
                label="<grading>",
            ))
        except Exception:
            # 失败就用原 bytes（兜底，避免 grading 阶段挂掉）
            out.append(data)
    return out


def _classify_err(e: Exception) -> str:
    msg = str(e).lower()
    if "timeout" in msg or "timed out" in msg:
        return "timeout"
    if "json" in msg or "validation" in msg:
        return "json_invalid"
    if "http" in msg or "connection" in msg or "429" in msg or "5xx" in msg:
        return "http_error"
    return "other"
