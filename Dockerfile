# syntax=docker/dockerfile:1.7
# 单进程 FastAPI + asyncio worker。设计前提见 docs/PLAN_CN_SINGLE_SCHOOL_2C2G.md：
# 我们刻意保持单进程（in-process queue + token bucket + Semaphore），所以
# 不要起 uvicorn workers > 1，也不要堆 gunicorn。

FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# ---- 依赖层 ---- #
# 先 COPY requirements.txt 再装包，业务代码改动不会让这层失效，构建快很多。
COPY requirements.txt /app/requirements.txt
RUN pip install -r /app/requirements.txt

# ---- 业务代码 ---- #
# 注意：data/ 不进镜像；运行时由 volume 挂上来。
# demo/ 是离线 Gradio 入口，本镜像只跑中台 backend，所以不 COPY 进来。
# backend/ 已经把 backend/prompts/ 自带，core/ 不再持有任何 prompt 路径
# （详见 core/config.py:Settings.load_prompts docstring）。
COPY core /app/core
COPY backend /app/backend

# ---- 非 root 用户 ---- #
# 默认 uid/gid = 1000，与大多数 Linux 桌面用户一致；Mac docker desktop 透明处理。
# 自建 ECS 上如果宿主 user uid 不是 1000，请 `chown -R 1000:1000 data` 一次。
ARG USER_UID=1000
ARG USER_GID=1000
RUN groupadd --gid ${USER_GID} akapen \
 && useradd --uid ${USER_UID} --gid akapen --shell /bin/bash --home /app --no-create-home akapen \
 && mkdir -p /app/data /app/data/uploads /app/data/logs \
 && chown -R akapen:akapen /app

USER akapen

EXPOSE 8000

# 健康检查：内部 ping /v1/livez。urllib 是 stdlib，不需要装 curl。
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request,sys; \
r = urllib.request.urlopen('http://127.0.0.1:8000/v1/livez', timeout=3); \
sys.exit(0 if r.status == 200 else 1)"

# `backend.app:main()` 内部调 uvicorn.run(app, ...)，遵守我们的单进程设计。
CMD ["python", "-m", "backend.app"]
