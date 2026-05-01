"""批改任务中台后端：FastAPI + asyncio worker + SQLite (WAL) 单机部署。

模块边界：``backend/`` 只关心 HTTP API、任务队列、持久化、回调；具体的 LLM 调用、
图片处理、prompt 渲染都委托给 ``core/``。新增 provider 仍按 ``AGENTS.md`` 走，
后端无感。
"""
