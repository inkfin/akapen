"""HTTP 路由汇总。具体路由分模块写。

使用方：``backend.app.create_app`` 调 :func:`register_routes` 把 router 挂上去。
"""
from __future__ import annotations

from fastapi import FastAPI

from . import health, tasks


def register_routes(app: FastAPI) -> None:
    """把所有子模块的 router 挂到 ``app``。"""
    app.include_router(tasks.router)
    app.include_router(health.router)
