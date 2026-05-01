"""健康检查 / Prometheus metrics 端点。

- ``GET /v1/livez``  ：进程是否还活着（不依赖 DB / provider）。永远 200。
- ``GET /v1/readyz`` ：是否就绪接新流量。lifespan 还没起完 / 正在 shutdown 时 503。
- ``GET /v1/metrics`` ：Prometheus 文本格式指标。
- ``GET /v1/healthz``：``readyz`` 的别名（k8s 习惯）。

具体指标定义在 :mod:`backend.metrics`，本模块只负责把 ``generate_latest()`` 返回。
"""
from __future__ import annotations

from fastapi import APIRouter, Request, Response, status
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

router = APIRouter(prefix="/v1", tags=["health"])


@router.get("/livez")
async def livez() -> dict[str, str]:
    """liveness: 永远 200，除非 Python 进程已经死了。"""
    return {"status": "ok"}


@router.get("/readyz")
async def readyz(request: Request) -> Response:
    """readiness: lifespan 起完才返 200，shutdown 期间返 503 让 LB 摘流量。"""
    state = getattr(request.app.state, "akapen", None)
    if state is None or not getattr(state, "ready", False):
        return Response(
            content='{"status":"not_ready"}',
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            media_type="application/json",
        )
    return Response(content='{"status":"ok"}', media_type="application/json")


@router.get("/healthz")
async def healthz(request: Request) -> Response:
    """``readyz`` 的别名。k8s 默认用这个名字。"""
    return await readyz(request)


@router.get("/metrics")
async def metrics() -> Response:
    """Prometheus 文本格式指标。"""
    return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)
