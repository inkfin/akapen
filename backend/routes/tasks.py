"""``/v1/grading-tasks`` REST 路由。

支持两种 ``Content-Type``：

- ``application/json``：body 是 :class:`TaskCreateRequestJSON`，``image_urls`` 是
  外部 URL 列表，由 worker 异步拉。
- ``multipart/form-data``：``images[]`` 是上传文件，其余字段走 ``Form()``。

multipart 上传**流式落盘**到 ``upload_dir/<task_id>/raw/``——FastAPI ``UploadFile``
本身就是 SpooledTemporaryFile，单文件 > ~1 MB 自动转磁盘，不会全部进内存。我
们再以 8KB chunk copy 到 task 目录，避免一次 ``await file.read()`` 把 8 张大
图同时驻留内存（2GB 机器扛不住）。

幂等：客户端可在 multipart 表单或 JSON 里带 ``idempotency_key``。Repo 层用
``(api_key_id, idempotency_key)`` UNIQUE 索引去重。

队列：成功创建后 ``put_nowait(task_id)`` 进 ``state.task_queue``，worker 自己消费。
启动时已经从 DB reclaim 过 stuck 任务，所以 race-free。
"""
from __future__ import annotations

import json
import logging
import shutil
import uuid
from pathlib import Path
from typing import Annotated

from fastapi import (
    APIRouter,
    Depends,
    Form,
    HTTPException,
    Query,
    Request,
    status,
)
# 注意：用 starlette 的 UploadFile，不是 fastapi 的——starlette form parser 返回的
# 是基类 starlette.datastructures.UploadFile，不是 fastapi.datastructures.UploadFile
# 子类，``isinstance(form_obj, fastapi.UploadFile)`` 会判 False。
from starlette.datastructures import UploadFile

from core.schemas import GradingResult

from ..auth import require_api_key
from ..rate_limit import limiter
from ..repo import (
    CreateTaskInput,
    cancel_task,
    create_task,
    get_task,
    list_tasks,
    retry_task,
)
from ..schemas import (
    TaskCreateRequestJSON,
    TaskCreateResponse,
    TaskLinks,
    TaskListResponse,
    TaskStatus,
)
from .. import metrics

logger = logging.getLogger("backend.routes.tasks")

router = APIRouter(prefix="/v1", tags=["grading-tasks"])


_ALLOWED_UPLOAD_EXTS = {".jpg", ".jpeg", ".png", ".webp"}
# multipart 单文件最大 size，超过的话 stream copy 时主动断流（再让 task 进 failed
# 比硬塞进任务后跑 fetcher 再失败更友好）。
_CHUNK_SIZE = 64 * 1024


# ---- POST ---- #


@router.post(
    "/grading-tasks",
    response_model=TaskCreateResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
@limiter.limit("30/minute")
async def create_task_endpoint(
    request: Request,
    api_key_id: Annotated[str, Depends(require_api_key)],
) -> TaskCreateResponse:
    """提交一条批改任务。

    - ``Content-Type: application/json``  → :func:`_create_from_json`
    - ``Content-Type: multipart/form-data`` → :func:`_create_from_multipart`
    """
    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()

    if content_type == "application/json":
        return await _create_from_json(request, api_key_id)
    if content_type.startswith("multipart/form-data"):
        return await _create_from_multipart(request, api_key_id)

    raise HTTPException(
        status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
        detail=f"Unsupported Content-Type: {content_type!r}; "
               "use application/json or multipart/form-data",
    )


async def _create_from_json(request: Request, api_key_id: str) -> TaskCreateResponse:
    state = request.app.state.akapen
    settings = state.settings

    try:
        raw = await request.json()
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail=f"invalid JSON body: {e}")
    try:
        req = TaskCreateRequestJSON.model_validate(raw)
    except Exception as e:
        # pydantic ValidationError → 422
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(e))

    if len(req.image_urls) > settings.max_images_per_task:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"image_urls 超过单任务上限 {settings.max_images_per_task}",
        )

    # provider override 校验
    provider_override, model_override, mode_override = _resolve_overrides(
        req.provider_overrides, settings,
    )

    inp = CreateTaskInput(
        api_key_id=api_key_id,
        student_id=req.student_id,
        student_name=req.student_name,
        image_sources=[str(u) for u in req.image_urls],
        image_paths=[],
        idempotency_key=req.idempotency_key,
        callback_url=str(req.callback_url) if req.callback_url else None,
        rubric_id=req.rubric_id or settings.default_rubric_id,
        rubric_version=req.rubric_version or settings.default_rubric_version,
        provider=provider_override,
        model=model_override,
        mode=mode_override,
    )
    task_id, idempotent = await create_task(state.db, inp)
    if not idempotent:
        state.task_queue.put_nowait(task_id)
        metrics.tasks_created_total.labels(api_key_id=api_key_id).inc()

    return _make_create_response(task_id, idempotent, request)


async def _create_from_multipart(request: Request, api_key_id: str) -> TaskCreateResponse:
    state = request.app.state.akapen
    settings = state.settings

    # Starlette 1.0 默认 max_part_size=1MB，超了就截断；这里放到 max_image_bytes
    # 让 8MB 真照片也能上来（再由 _stream_to_disk 边走边校验体积）。
    form = await request.form(
        max_files=settings.max_images_per_task + 16,
        max_fields=64,
        max_part_size=settings.max_image_bytes,
    )
    student_id = (form.get("student_id") or "").strip()
    student_name = (form.get("student_name") or "").strip()
    if not student_id or not student_name:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="multipart 必填 student_id / student_name",
        )

    idempotency_key = (form.get("idempotency_key") or "").strip() or None
    callback_url = (form.get("callback_url") or "").strip() or None

    rubric_id = (form.get("rubric_id") or "").strip() or settings.default_rubric_id
    rubric_version = (
        (form.get("rubric_version") or "").strip() or settings.default_rubric_version
    )

    # 收 images[]：FastAPI 把 multiple file 字段映射成多个同名 key
    files: list[UploadFile] = []
    for key in ("images", "images[]", "image"):
        files.extend(v for v in form.getlist(key) if isinstance(v, UploadFile))
    if not files:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="multipart 缺少 images[] 字段",
        )
    if len(files) > settings.max_images_per_task:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"上传图片数 {len(files)} 超过上限 {settings.max_images_per_task}",
        )

    # 我们要的 task_id 在 INSERT 时才生成（带 idempotency 检查），所以先 spool
    # 文件到一个临时目录；INSERT 出真 task_id 后再 mv 过去。
    spool_id = uuid.uuid4().hex
    spool_dir = settings.upload_dir / "_spool" / spool_id
    spool_dir.mkdir(parents=True, exist_ok=True)
    saved_paths: list[Path] = []
    try:
        for idx, f in enumerate(files):
            ext = Path(f.filename or "").suffix.lower()
            if ext not in _ALLOWED_UPLOAD_EXTS:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=f"上传文件 {f.filename!r} 后缀 {ext!r} 不在 "
                           f"{sorted(_ALLOWED_UPLOAD_EXTS)} 之内",
                )
            # 流式 copy 到磁盘 + 边走边算 size
            dest = spool_dir / f"{idx:02d}{ext}"
            total = await _stream_to_disk(
                f, dest, max_bytes=settings.max_image_bytes,
            )
            logger.debug(f"multipart upload {f.filename} → {dest} ({total} bytes)")
            saved_paths.append(dest)

        # 解析 provider_overrides JSON（如果有）
        po_raw = form.get("provider_overrides")
        provider_override = model_override = mode_override = None
        if po_raw:
            try:
                from ..schemas import ProviderOverrides
                po = ProviderOverrides.model_validate_json(po_raw)
                provider_override, model_override, mode_override = _resolve_overrides(
                    po, settings,
                )
            except Exception as e:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=f"provider_overrides 解析失败: {e}",
                )

        # 创建任务
        inp = CreateTaskInput(
            api_key_id=api_key_id,
            student_id=student_id,
            student_name=student_name,
            image_sources=[str(p) for p in saved_paths],
            image_paths=[],
            idempotency_key=idempotency_key,
            callback_url=callback_url,
            rubric_id=rubric_id,
            rubric_version=rubric_version,
            provider=provider_override,
            model=model_override,
            mode=mode_override,
        )
        task_id, idempotent = await create_task(state.db, inp)

        if idempotent:
            # 命中已有任务：丢弃刚刚 spool 的临时文件（已有任务已经持有自己的图）
            shutil.rmtree(spool_dir, ignore_errors=True)
            return _make_create_response(task_id, idempotent, request)

        # 把 spool 目录搬到 <upload_dir>/<task_id>/raw/
        task_dir = settings.upload_dir / task_id / "raw"
        task_dir.parent.mkdir(parents=True, exist_ok=True)
        spool_dir.rename(task_dir)

        # image_sources 在 DB 里现在是 spool 路径，要更新成新的 raw 路径，
        # 否则 worker 找不到文件。
        new_paths = [str(task_dir / p.name) for p in saved_paths]
        await state.db.conn.execute(
            "UPDATE grading_tasks SET image_sources_json = ?, "
            "updated_at = datetime('now') WHERE task_id = ?",
            (json.dumps(new_paths, ensure_ascii=False), task_id),
        )

        state.task_queue.put_nowait(task_id)
        metrics.tasks_created_total.labels(api_key_id=api_key_id).inc()
        return _make_create_response(task_id, idempotent, request)

    except HTTPException:
        # 上面任何一步 422 都到这里——清掉 spool 目录
        shutil.rmtree(spool_dir, ignore_errors=True)
        raise
    except Exception:
        shutil.rmtree(spool_dir, ignore_errors=True)
        raise


async def _stream_to_disk(
    upload: UploadFile, dest: Path, *, max_bytes: int,
) -> int:
    """把 :class:`UploadFile` 的内容流式写入 ``dest``，返回写入字节数。

    超过 ``max_bytes`` 立即停止 + 删半成品 + raise 422。
    """
    total = 0
    with dest.open("wb") as f:
        while True:
            chunk = await upload.read(_CHUNK_SIZE)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                f.close()
                dest.unlink(missing_ok=True)
                raise HTTPException(
                    status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                    detail=f"单图超过上限 {max_bytes} 字节",
                )
            f.write(chunk)
    return total


def _resolve_overrides(po, settings) -> tuple[str | None, str | None, str | None]:
    """:class:`ProviderOverrides` → (provider, model, mode)；不传任何字段返回 (None, None, None)。

    一路上做合法性校验（拒绝未知 provider、空字符串等）。
    """
    if po is None:
        return (None, None, None)

    from core.providers import registered_providers

    provider = po.provider.strip() if po.provider else None
    if provider and provider not in registered_providers():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"未知 provider {provider!r}（已注册: {registered_providers()})",
        )

    model = po.model.strip() if po.model else None

    mode: str | None = None
    if po.enable_single_shot is True:
        mode = "single_shot"
    elif po.enable_single_shot is False:
        if po.grading_with_image is True:
            mode = "two_step_vision"
        else:
            mode = "two_step_text"

    return (provider, model, mode)


def _make_create_response(task_id: str, idempotent: bool, request: Request) -> TaskCreateResponse:
    base = str(request.url).rstrip("/").rsplit("/v1/", 1)[0] + "/v1"
    return TaskCreateResponse(
        task_id=task_id,
        status="queued",
        idempotent=idempotent,
        created_at=__import__("datetime").datetime.now(__import__("datetime").timezone.utc),
        links=TaskLinks(
            self=f"{base}/grading-tasks/{task_id}",
            result=f"{base}/grading-tasks/{task_id}/result",
        ),
    )


# ---- GET 单条 ---- #


@router.get("/grading-tasks/{task_id}", response_model=TaskStatus)
@limiter.limit("300/minute")
async def get_task_endpoint(
    request: Request,
    task_id: str,
    api_key_id: Annotated[str, Depends(require_api_key)],
) -> TaskStatus:
    state = request.app.state.akapen
    t = await get_task(state.db, task_id, api_key_id=api_key_id)
    if t is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                            detail="task not found")
    return t


# ---- GET 仅结果 ---- #


@router.get("/grading-tasks/{task_id}/result", response_model=GradingResult)
@limiter.limit("300/minute")
async def get_task_result_endpoint(
    request: Request,
    task_id: str,
    api_key_id: Annotated[str, Depends(require_api_key)],
) -> GradingResult:
    state = request.app.state.akapen
    t = await get_task(state.db, task_id, api_key_id=api_key_id)
    if t is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                            detail="task not found")
    if t.status != "succeeded" or t.result is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"task is in status={t.status}; result is only available "
                   f"when status=succeeded",
        )
    return t.result


# ---- 列表 ---- #


@router.get("/grading-tasks", response_model=TaskListResponse)
@limiter.limit("300/minute")
async def list_tasks_endpoint(
    request: Request,
    api_key_id: Annotated[str, Depends(require_api_key)],
    status_filter: Annotated[str | None, Query(alias="status")] = None,
    student_id: str | None = None,
    since: str | None = None,
    limit: int = 50,
    cursor: str | None = None,
) -> TaskListResponse:
    state = request.app.state.akapen
    return await list_tasks(
        state.db,
        api_key_id=api_key_id,
        status=status_filter,
        student_id=student_id,
        since=since,
        limit=limit,
        cursor=cursor,
    )


# ---- 取消 ---- #


@router.delete("/grading-tasks/{task_id}", status_code=status.HTTP_200_OK)
@limiter.limit("60/minute")
async def cancel_task_endpoint(
    request: Request,
    task_id: str,
    api_key_id: Annotated[str, Depends(require_api_key)],
) -> dict[str, str]:
    state = request.app.state.akapen
    result = await cancel_task(state.db, task_id, api_key_id=api_key_id)
    if result == "not_found":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                            detail="task not found")
    if result == "terminal":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="task already in terminal status; cannot cancel",
        )
    return {"status": "cancelled", "task_id": task_id}


# ---- 重试 ---- #


@router.post("/grading-tasks/{task_id}/retry", status_code=status.HTTP_202_ACCEPTED)
@limiter.limit("30/minute")
async def retry_task_endpoint(
    request: Request,
    task_id: str,
    api_key_id: Annotated[str, Depends(require_api_key)],
) -> dict[str, str]:
    state = request.app.state.akapen
    result = await retry_task(state.db, task_id, api_key_id=api_key_id)
    if result == "not_found":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                            detail="task not found")
    if result == "not_failed":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="task is not in failed status; only failed tasks can be retried",
        )
    state.task_queue.put_nowait(task_id)
    return {"status": "queued", "task_id": task_id}
