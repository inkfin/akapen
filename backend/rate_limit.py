"""按 API key 限流。

slowapi 的 ``Limiter`` 自带内存桶，单进程足够（多进程要 Redis 做共享桶；本服务
就是单进程 2C2G，用不上）。

限流维度：``api_key_id``（命中后是 name；没带或非法时退化为 client IP，避免无
header 探测被判 0 限流）。

默认配置：
- POST /v1/grading-tasks ：30/分钟（保护下游 LLM 配额）
- 其它 GET 路径         ：300/分钟（轮询场景需要高一点）

应用方式（在 app.py 或 routes 里）：

    from .rate_limit import limiter, install_limiter
    install_limiter(app)

    @router.post("/grading-tasks")
    @limiter.limit("30/minute")
    async def create_task(request: Request, ...): ...

注意：slowapi 要求被装饰的端点显式接 ``request: Request`` 参数（用来读 client 信息）。
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from fastapi import Request
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from .auth import api_key_id_from_request

if TYPE_CHECKING:
    from fastapi import FastAPI

logger = logging.getLogger("backend.rate_limit")


def _key_func(request: Request) -> str:
    """slowapi 桶 key：优先用 api_key_id，否则退化到客户端 IP。"""
    api_key_id = api_key_id_from_request(request)
    if api_key_id:
        return f"key:{api_key_id}"
    if request.client:
        return f"ip:{request.client.host}"
    return "anon"


# 默认限制：限流分两档（写入 / 查询），具体路由用 @limiter.limit("xx/minute") 标注。
limiter = Limiter(
    key_func=_key_func,
    default_limits=["300/minute"],
    storage_uri="memory://",
)


def install_limiter(app: "FastAPI") -> None:
    """把 limiter 挂到 app.state，并注册 429 异常处理器。"""
    app.state.limiter = limiter
    # slowapi 要求把它的 RateLimitExceeded handler 注册到 app
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
    logger.info("slowapi limiter installed (memory backend)")


# multipart 入向带宽控制：在 routes/tasks.py 里读 Settings.max_image_bytes 拒绝
# 单图过大 + Settings.max_images_per_task 拒绝过多文件——不在这里全局配。
