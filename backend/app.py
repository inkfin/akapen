"""FastAPI app 工厂 + lifespan。

启动顺序：
1. 加载 :class:`backend.config.BackendSettings`（API key / 路径 / 并发参数）
2. 起 :class:`backend.db.Database`（建连接 + 跑 schema 迁移）
3. Reclaim 启动时还卡在 ``running``/``queued`` 的任务（重置回 ``queued``，attempts +=1）
4. 起异步 worker 任务（消费 asyncio.Queue，下层调 core.grader）
5. 起 webhook dispatcher 任务（独立队列，单独的协程持续重试）

关闭顺序：
1. ``ready=False``：``/readyz`` 开始返 503，让上游 LB 不再派新流量
2. 关闭新任务接收（POST 路由会返 503）
3. 等 worker 处理完手头任务（最多 ``task_timeout_sec``）
4. 关 DB

为了让 routes / worker / webhook 三处都拿得到 settings + db + queue 等"全局
状态"，统一封装到 :class:`AppState` 里，挂到 ``app.state.akapen``。
"""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from fastapi import FastAPI

from core.logger import setup_logging

from .config import BackendSettings
from .db import Database

if TYPE_CHECKING:
    from .worker import Worker
    from .webhook import WebhookDispatcher

logger = logging.getLogger("backend.app")


@dataclass
class AppState:
    """整个 FastAPI 进程共享的运行时状态。

    挂到 ``app.state.akapen``；路由 / worker / webhook 之间通过它互相找到对方。
    """

    settings: BackendSettings
    db: Database
    # 待执行任务队列：item 是 task_id (str)；worker 拿到 ID 后再去 DB 读完整状态
    task_queue: asyncio.Queue[str] = field(default_factory=asyncio.Queue)
    # 服务"是否就绪"：False 时 /readyz 返 503，POST 路由也拒收
    ready: bool = False
    # 启动后填充
    worker: "Worker | None" = None
    webhook_dispatcher: "WebhookDispatcher | None" = None


def create_app(settings: BackendSettings | None = None) -> FastAPI:
    """构造 FastAPI 实例。

    可注入自定义 settings（测试 / Gradio mount 时方便）。生产用 ``main()`` 走
    :meth:`BackendSettings.load`。
    """
    setup_logging()
    if settings is None:
        settings = BackendSettings.load()

    # state 早一步建好（DB 还没 connect 也行，admin UI 是 closure 拿 state，
    # 实际访问 DB 要到 handler 触发时）。这样 admin UI 可以在 lifespan 之前
    # 挂载——``gr.mount_gradio_app`` 修改的是 FastAPI router，必须在 app 开始
    # 接受请求之前调用。
    state = AppState(settings=settings, db=Database(settings.db_path))

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.akapen = state

        # 1. DB
        await state.db.connect()

        # 2. Reclaim 卡死任务（崩溃后重启场景）
        from .repo import reclaim_stuck_tasks

        reclaimed = await reclaim_stuck_tasks(state.db)
        if reclaimed:
            logger.info(f"启动时 reclaim 了 {reclaimed} 条卡死任务（重置为 queued）")

        # 3. 把 DB 里所有 queued 状态的任务重新塞进内存队列
        from .repo import list_queued_task_ids

        queued_ids = await list_queued_task_ids(state.db)
        for tid in queued_ids:
            state.task_queue.put_nowait(tid)
        logger.info(f"启动时把 {len(queued_ids)} 条 queued 任务排入内存队列")

        # 4. 起 worker
        from .worker import Worker

        state.worker = Worker(state)
        worker_task = asyncio.create_task(state.worker.run(), name="akapen-worker")

        # 5. 起 webhook dispatcher
        from .webhook import WebhookDispatcher

        state.webhook_dispatcher = WebhookDispatcher(state)
        webhook_task = asyncio.create_task(
            state.webhook_dispatcher.run(), name="akapen-webhook"
        )

        # 6. ready
        state.ready = True
        logger.info(
            f"akapen backend ready: concurrency={settings.max_concurrency}, "
            f"bandwidth_kbps={settings.bandwidth_kbps}, "
            f"upload_dir={settings.upload_dir}, db={settings.db_path}"
        )

        try:
            yield
        finally:
            logger.info("akapen backend shutting down...")
            state.ready = False

            # 让 worker 把手头任务做完，最多等一个 task timeout
            if state.worker is not None:
                state.worker.stop()
            if state.webhook_dispatcher is not None:
                state.webhook_dispatcher.stop()

            try:
                await asyncio.wait_for(worker_task, timeout=settings.task_timeout_sec + 30)
            except asyncio.TimeoutError:
                logger.warning("worker 未在超时内退出，强制取消")
                worker_task.cancel()
            except Exception as e:
                logger.error(f"worker 退出异常: {e}")

            try:
                await asyncio.wait_for(webhook_task, timeout=30)
            except asyncio.TimeoutError:
                logger.warning("webhook dispatcher 未在 30s 内退出，强制取消")
                webhook_task.cancel()
            except Exception as e:
                logger.error(f"webhook 退出异常: {e}")

            await state.db.close()
            logger.info("akapen backend shutdown complete")

    app = FastAPI(
        title="Akapen Grading Backend",
        version="0.1.0",
        description=(
            "日语作文批改任务中台。前端通过 REST API 提交批改任务（multipart 上传 "
            "或 JSON+URL），异步 worker 调 LLM 处理，结果通过轮询 / webhook 取回。"
        ),
        lifespan=lifespan,
    )

    # 限流器：要在 add_exception_handler 之前 / 之后都行，但必须在路由 import 前
    # 把 limiter 挂到 app.state（路由的 @limiter.limit 装饰器在 import 时注册）。
    from .rate_limit import install_limiter

    install_limiter(app)

    from .routes import register_routes

    register_routes(app)

    # Gradio 运维后台挂在 /admin。出错也不影响主服务（admin 只是辅助）。
    try:
        from .admin_ui import mount_admin

        mount_admin(app, state, path="/admin")
    except Exception:
        logger.exception("admin_ui 挂载失败（继续启服务，主功能不受影响）")

    return app


def main() -> None:
    """uvicorn 入口。``python -m backend.app`` / ``python -m uvicorn backend.app:app``。"""
    import uvicorn

    settings = BackendSettings.load()
    app = create_app(settings)
    uvicorn.run(
        app,
        host=settings.host,
        port=settings.port,
        # access log 用 uvicorn 自己的，业务日志走 core.logger
        log_level="info",
    )


# 让 uvicorn 直接拿模块级 app（用 lazy 初始化避免在 import 时就读 env）
def _lazy_app() -> FastAPI:
    return create_app()


# 仅供 ``uvicorn backend.app:app`` 使用：模块级 app 实例。
app: Any = None


def __getattr__(name: str) -> Any:
    """模块级 ``app`` 用 lazy 创建，避免 import 阶段触发 settings 加载。"""
    global app
    if name == "app":
        if app is None:
            app = _lazy_app()
        return app
    raise AttributeError(name)


if __name__ == "__main__":
    main()
