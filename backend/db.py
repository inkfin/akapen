"""aiosqlite 异步连接封装 + schema 迁移。

设计：单进程 + 单连接（aiosqlite 的 Connection 自带串行队列，asyncio 多协程共
享一个 connection 是安全的，写入由 SQLite WAL 模式串行化）。我们暴露一个全局
``Database`` 单例，由 FastAPI lifespan 在启动 / 关闭时持有。

不引入正式迁移框架（alembic 等）：表 schema 用 ``CREATE TABLE IF NOT EXISTS``
+ 一张 ``schema_versions`` 表追踪版本，每个版本对应一个 ``apply_vN`` 函数。

写并发模型：SQLite WAL 模式下读不阻塞读、读不阻塞写、写串行化。每个 worker 协
程的写操作都通过共享 connection 串行执行；2C2G + Semaphore(8) 场景下完全够用。
"""
from __future__ import annotations

import logging
from pathlib import Path

import aiosqlite

logger = logging.getLogger("backend.db")


SCHEMA_VERSION = 2


# ---- 表定义 ---- #


CREATE_TASKS_SQL = """
CREATE TABLE IF NOT EXISTS grading_tasks (
    task_id TEXT PRIMARY KEY,
    idempotency_key TEXT,
    api_key_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    student_name TEXT NOT NULL,

    status TEXT NOT NULL,
    error_code TEXT,
    error_message TEXT,

    -- 入参快照：客户端传的 URL 列表 / 或 multipart 上传的相对路径列表
    image_sources_json TEXT,
    -- 标准化后落地的本地路径列表（绝对或相对 upload_dir）
    image_paths_json TEXT,

    -- 业务结果
    transcription TEXT,
    grading_json TEXT,
    final_score REAL,
    confidence REAL,
    review_flag INTEGER NOT NULL DEFAULT 0,
    review_reasons_json TEXT,

    -- 回调相关
    callback_url TEXT,
    callback_status TEXT,
    callback_attempts INTEGER NOT NULL DEFAULT 0,
    callback_last_error TEXT,
    callback_next_at TEXT,

    -- 元信息
    rubric_id TEXT,
    rubric_version TEXT,
    provider TEXT,
    model TEXT,
    mode TEXT,           -- 'single_shot' | 'two_step_text' | 'two_step_vision'
    attempts INTEGER NOT NULL DEFAULT 0,
    upload_bytes INTEGER NOT NULL DEFAULT 0,

    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    updated_at TEXT NOT NULL
);
"""

CREATE_INDEXES_SQL = [
    # 幂等：(api_key_id, idempotency_key) 唯一；NULL idempotency_key 不参与（partial index）
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_idem ON grading_tasks(api_key_id, idempotency_key) "
    "WHERE idempotency_key IS NOT NULL",
    # 按状态 + 时间扫，用于 reclaim、列表
    "CREATE INDEX IF NOT EXISTS idx_status ON grading_tasks(status, created_at)",
    # 按 API key + 时间倒序列表
    "CREATE INDEX IF NOT EXISTS idx_apikey ON grading_tasks(api_key_id, created_at DESC)",
    # webhook 重试调度：找出 callback_status='pending' 且 next_at <= now 的
    "CREATE INDEX IF NOT EXISTS idx_callback_due "
    "ON grading_tasks(callback_status, callback_next_at) "
    "WHERE callback_status IS NOT NULL",
]


CREATE_SCHEMA_VERSIONS_SQL = """
CREATE TABLE IF NOT EXISTS schema_versions (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
);
"""


# ---- 连接管理 ---- #


class Database:
    """共享 aiosqlite 连接的最小封装。

    使用：

        db = Database(path)
        await db.connect()      # 建连接 + 跑迁移
        # 业务里 await db.conn.execute(...) / await db.conn.fetchone(...)
        await db.close()        # FastAPI shutdown 调用
    """

    def __init__(self, path: Path):
        self.path = path
        self._conn: aiosqlite.Connection | None = None

    @property
    def conn(self) -> aiosqlite.Connection:
        if self._conn is None:
            raise RuntimeError("Database not connected; call .connect() first")
        return self._conn

    async def connect(self) -> None:
        """打开 SQLite + 设置 WAL pragma + 跑 schema 迁移。"""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # isolation_level=None：让我们手动控制事务，避免 sqlite3 默认隐式 commit
        # 把 PRAGMA 也包进 transaction 引发奇怪行为。
        self._conn = await aiosqlite.connect(self.path, isolation_level=None)
        self._conn.row_factory = aiosqlite.Row

        # WAL 模式：读不阻塞读、读不阻塞写；写仍串行化。
        await self._conn.execute("PRAGMA journal_mode=WAL")
        # synchronous=NORMAL：fsync 频率降低（FULL 太慢、OFF 不安全），WAL 下足够安全。
        await self._conn.execute("PRAGMA synchronous=NORMAL")
        await self._conn.execute("PRAGMA foreign_keys=ON")
        # busy_timeout=5000：单个写者占锁时其他写者等 5s 再失败，避免 SQLITE_BUSY。
        await self._conn.execute("PRAGMA busy_timeout=5000")

        await self._migrate()
        logger.info(f"Database connected at {self.path}, schema_version={SCHEMA_VERSION}")

    async def close(self) -> None:
        if self._conn is not None:
            await self._conn.close()
            self._conn = None

    async def _migrate(self) -> None:
        """幂等迁移：已应用的版本跳过；未应用的按顺序跑。"""
        await self._conn.execute(CREATE_SCHEMA_VERSIONS_SQL)
        cur = await self._conn.execute(
            "SELECT version FROM schema_versions ORDER BY version"
        )
        rows = await cur.fetchall()
        await cur.close()
        applied = {r["version"] for r in rows}

        if 1 not in applied:
            await self._apply_v1()
            await self._conn.execute(
                "INSERT INTO schema_versions(version, applied_at) "
                "VALUES (1, datetime('now'))"
            )
            logger.info("Applied schema migration v1")

        if 2 not in applied:
            await self._apply_v2()
            await self._conn.execute(
                "INSERT INTO schema_versions(version, applied_at) "
                "VALUES (2, datetime('now'))"
            )
            logger.info("Applied schema migration v2")

    async def _apply_v1(self) -> None:
        await self._conn.execute(CREATE_TASKS_SQL)
        for sql in CREATE_INDEXES_SQL:
            await self._conn.execute(sql)

    async def _apply_v2(self) -> None:
        """加 question_context 列。给 web 老师端按题批改用——题干 / 评分要点会随
        请求一起送进来，由 core/grader._prepend_question_context 拼到 prompt 顶部。

        SQLite 限制：ALTER ADD COLUMN 必须 NULL 默认值（不能指定 DEFAULT）。
        没问题，我们本来就允许这字段为空（老 multipart 调用方根本不传）。
        """
        await self._conn.execute(
            "ALTER TABLE grading_tasks ADD COLUMN question_context TEXT"
        )


# ---- helper：让 Row 转 dict 时容错 None / JSON 字段 ---- #


def row_to_dict(row: aiosqlite.Row | None) -> dict | None:
    """把 aiosqlite.Row 转成普通 dict，None 透传。"""
    if row is None:
        return None
    return {k: row[k] for k in row.keys()}
