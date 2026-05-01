"""集中式日志：写入 data/logs/app.log（rotating），同时输出到 stdout。

- 文件持久化：刷新浏览器或重启 Gradio 不会丢失历史
- UI 通过 tail_log(n) 取最近 N 行展示
- ``task_id`` 上下文：worker 在跑一条任务时调 ``bind_task_id(tid)``，本进程内
  所有日志（含 provider / fetcher / webhook）都会自动带上 ``[task=xxxxxxxx]`` 前缀，
  方便在日志里 grep 一个 task 的全链路。退出 ``with`` 块自动清掉。
"""
from __future__ import annotations

import contextvars
import logging
import logging.handlers
from contextlib import contextmanager
from pathlib import Path

from .config import DATA_DIR

LOG_DIR = DATA_DIR / "logs"
LOG_FILE = LOG_DIR / "app.log"

# 当前协程的 task_id（None = 不是任务上下文，比如 routes / health endpoint）
_task_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "akapen_task_id", default=None,
)


@contextmanager
def bind_task_id(task_id: str | None):
    """把 ``task_id`` 绑到当前 asyncio 上下文。

    用法：

        async with bind_task_id(tid):  # ❌ contextmanager 不支持 async
            ...
        # 改用 with；asyncio task 通过 contextvars 的 copy_context 自动继承
        with bind_task_id(tid):
            ...

    实际我们在 worker.py 里这样用：

        token = _task_id_var.set(tid)
        try:
            await self._do_task(tid)
        finally:
            _task_id_var.reset(token)
    """
    token = _task_id_var.set(task_id)
    try:
        yield
    finally:
        _task_id_var.reset(token)


class _TaskIdFilter(logging.Filter):
    """每条 log record 注入 ``record.task_id``（None / 8 char prefix）。"""

    def filter(self, record: logging.LogRecord) -> bool:
        tid = _task_id_var.get()
        # 把 task_id 转成 record 字段，formatter 用 %(task_id)s 拿
        record.task_id = (tid[:8] if tid else "--------")
        return True


_FMT = logging.Formatter(
    fmt="%(asctime)s | %(levelname)-5s | %(name)-12s | [task=%(task_id)s] %(message)s",
    datefmt="%H:%M:%S",
)

_initialized = False


def setup_logging(level: int = logging.INFO) -> logging.Logger:
    """幂等：多次调用只初始化一次。"""
    global _initialized
    root = logging.getLogger()
    if not _initialized:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        file_handler = logging.handlers.RotatingFileHandler(
            LOG_FILE,
            maxBytes=5_000_000,
            backupCount=3,
            encoding="utf-8",
        )
        file_handler.setFormatter(_FMT)
        console = logging.StreamHandler()
        console.setFormatter(_FMT)

        # 把 task_id filter 装到 root logger，所有子 logger 都能继承
        root.addFilter(_TaskIdFilter())
        # 同时给 handler 加一份（filter 在 logger / handler 两级都需要）
        file_handler.addFilter(_TaskIdFilter())
        console.addFilter(_TaskIdFilter())

        root.handlers = [file_handler, console]
        root.setLevel(level)
        logging.getLogger("httpx").setLevel(logging.WARNING)
        logging.getLogger("httpcore").setLevel(logging.WARNING)
        logging.getLogger("urllib3").setLevel(logging.WARNING)
        _initialized = True

    return logging.getLogger("app")


def set_task_id(task_id: str | None):
    """直接设置当前协程的 task_id；返回 token，调用方负责 ``_task_id_var.reset(token)``。

    asyncio 友好版本（``contextlib.contextmanager`` 不能跨 await）。
    """
    return _task_id_var.set(task_id)


def reset_task_id(token) -> None:
    _task_id_var.reset(token)


def tail_log(n: int = 200) -> str:
    """读取日志文件的最后 N 行。"""
    if not LOG_FILE.exists():
        return "(暂无日志)"
    try:
        with LOG_FILE.open("rb") as f:
            f.seek(0, 2)
            size = f.tell()
            block = 8192
            data = b""
            pos = size
            while pos > 0 and data.count(b"\n") <= n:
                read = min(block, pos)
                pos -= read
                f.seek(pos)
                data = f.read(read) + data
            text = data.decode("utf-8", errors="replace")
        lines = text.splitlines()
        return "\n".join(lines[-n:])
    except Exception as e:
        return f"(读取日志失败: {e})"


def clear_log() -> None:
    if LOG_FILE.exists():
        LOG_FILE.write_text("", encoding="utf-8")
