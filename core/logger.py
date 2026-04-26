"""集中式日志：写入 data/logs/app.log（rotating），同时输出到 stdout。

- 文件持久化：刷新浏览器或重启 Gradio 不会丢失历史
- UI 通过 tail_log(n) 取最近 N 行展示
"""
from __future__ import annotations

import logging
import logging.handlers
from pathlib import Path

from .config import DATA_DIR

LOG_DIR = DATA_DIR / "logs"
LOG_FILE = LOG_DIR / "app.log"

_FMT = logging.Formatter(
    fmt="%(asctime)s | %(levelname)-5s | %(name)-12s | %(message)s",
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

        root.handlers = [file_handler, console]
        root.setLevel(level)
        logging.getLogger("httpx").setLevel(logging.WARNING)
        logging.getLogger("httpcore").setLevel(logging.WARNING)
        logging.getLogger("urllib3").setLevel(logging.WARNING)
        _initialized = True

    return logging.getLogger("app")


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
