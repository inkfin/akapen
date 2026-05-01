"""``X-API-Key`` 鉴权。

设计：每个请求带 ``X-API-Key: <secret>``，后端反查 ``BackendSettings.api_keys``，
命中就把对应的 ``api_key_id`` 注入到请求里（路由 / repo 用它做隔离）。

使用方式（路由签名）：

    from fastapi import Depends
    from .auth import require_api_key

    @router.post("/grading-tasks")
    async def create_task(api_key_id: str = Depends(require_api_key), ...):
        ...

不命中、不带、或者服务还没就绪都返 401 / 503。

为什么不用 OAuth / JWT：单校单 / 单租户场景，API key 已经够。多租户隔离靠
``api_key_id`` 在每张查询里多一个 WHERE 条件即可。
"""
from __future__ import annotations

import logging
from typing import Annotated

from fastapi import Header, HTTPException, Request, status

logger = logging.getLogger("backend.auth")


async def require_api_key(
    request: Request,
    x_api_key: Annotated[str | None, Header(alias="X-API-Key")] = None,
) -> str:
    """FastAPI dependency：校验并返回 ``api_key_id``。"""
    state = getattr(request.app.state, "akapen", None)
    if state is None or not getattr(state, "ready", False):
        # 还没起完 / 正在 shutdown：拒收，让上游 LB 重试
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="service not ready",
        )

    if not x_api_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="missing X-API-Key header",
            headers={"WWW-Authenticate": "ApiKey"},
        )

    rev = state.settings.reverse_api_keys()
    api_key_id = rev.get(x_api_key)
    if api_key_id is None:
        # 不打印 secret，只打日志说明哪个 IP 的 401
        client_host = request.client.host if request.client else "?"
        logger.warning(f"unauthorized request from {client_host}")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid X-API-Key",
            headers={"WWW-Authenticate": "ApiKey"},
        )
    return api_key_id


def api_key_id_from_request(request: Request) -> str | None:
    """slowapi key_func / metrics 用：直接从 header 拿 secret 反查 id，缺失返回 None。

    不抛异常——slowapi 在请求处理前会被调用，那时还没经过 require_api_key。
    """
    secret = request.headers.get("X-API-Key", "")
    if not secret:
        return None
    state = getattr(request.app.state, "akapen", None)
    if state is None:
        return None
    return state.settings.reverse_api_keys().get(secret)
