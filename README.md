# Akapen

日语作文批改工具，**两种用法**共存：

- **模式 A · 离线 Gradio（``demo/``）** —— 老牌单机批改：扫描 `data/input/`
  下整班作文目录，UI 上点几下，结果落到 `data/records/`，导出 Markdown。
- **模式 B · 批改任务中台（``backend/``）** —— FastAPI + SQLite + asyncio worker，
  提供 REST API 和 webhook。前端（作业收集系统）通过 ``POST /v1/grading-tasks``
  提交任务，轮询或回调拿严格 JSON 评分结果。访问
  ``http://127.0.0.1:8000/admin`` 还能看到只读运维后台（Gradio）。

两种模式**共享业务核心**（`core/`），换 LLM provider / 改 prompt / 调画质都
是同一份代码。

## 启动

### 通用准备

本地运行时使用 [uv](https://docs.astral.sh/uv/) 管理虚拟环境。Docker 部署见
下面 *模式 B · Docker 一键部署*，那条路径不需要本地装 uv / Python。

```bash
# 一次性装 uv（如果还没装）
curl -LsSf https://astral.sh/uv/install.sh | sh

# 装依赖（从 uv.lock 锁定版本）
uv sync

cp .env.example .env
# 编辑 .env 填入 DASHSCOPE_API_KEY（推荐）/ GEMINI_API_KEY / ANTHROPIC_API_KEY
# 也可在 UI 的「设置」Tab 填
```

依赖单一来源是 ``pyproject.toml``。`requirements.txt` 是 ``uv export`` 自动生成
的，**只用于 Docker 镜像构建**；改依赖请改 ``pyproject.toml`` 后跑：

```bash
uv lock                                                  # 重生成 uv.lock
uv export --frozen --no-hashes --no-dev -o requirements.txt
```

### 模式 A · 离线 Gradio

```bash
uv run python -m demo.app
# 打开 http://127.0.0.1:7860
```

1. 按下面的「输入格式」整理好作文图片目录。
2. 「设置」Tab 填 Key / 模型。
3. 「任务」Tab 扫描 → 批量 OCR → 批量批改（也可一键全跑）。
4. 「修改」Tab 逐个学生复核、编辑、重跑。
5. 「结果」Tab 导出 Markdown。

### 模式 B · 批改任务中台（本地裸跑）

```bash
# 先在 .env 里加上：
#   API_KEYS=akapen:<32+ 字符随机字符串>     ← 至少配一个，否则服务拒启动
#   WEBHOOK_SECRET=<32+ 字符随机字符串>     ← 客户端校验回调签名用

uv run python -m backend.app
# 默认监听 0.0.0.0:8000
```

提交一条任务（JSON + 图片 URL）：

```bash
curl -X POST http://localhost:8000/v1/grading-tasks \
  -H "X-API-Key: <你的 API_KEYS secret>" \
  -H "Content-Type: application/json" \
  -d '{
    "idempotency_key": "abc-123",
    "student_id": "2024001",
    "student_name": "王伟",
    "image_urls": ["https://your-cdn/page1.jpg", "https://your-cdn/page2.jpg"],
    "callback_url": "https://your-frontend/webhooks/grading"
  }'
# → 202 { "task_id": "...", "status": "queued", ... }
```

或者 multipart 上传（文件直传）：

```bash
curl -X POST http://localhost:8000/v1/grading-tasks \
  -H "X-API-Key: <secret>" \
  -F idempotency_key=abc-123 \
  -F student_id=2024001 \
  -F student_name=王伟 \
  -F images=@page1.jpg \
  -F images=@page2.jpg
```

轮询：

```bash
curl -H "X-API-Key: <secret>" http://localhost:8000/v1/grading-tasks/<task_id>
```

完整 API 形态见 `docs/PLAN_CN_SINGLE_SCHOOL_2C2G.md` 的 §三、《API 形态》。
运维后台（task 列表 / 详情 / 重试）：<http://localhost:8000/admin>。
监控指标：<http://localhost:8000/v1/metrics>（Prometheus 文本格式）。

### 模式 B · Docker 一键部署（推荐）

仓库自带 `Dockerfile` + `docker-compose.yml`，一条命令起服务，**SQLite / 上传图
片 / 日志全部映射到宿主机** `./data/`，停容器重启容器都不丢任务。

```bash
# 1) 准备配置
cp .env.example .env
# 编辑 .env，至少填：
#   DASHSCOPE_API_KEY=sk-...
#   API_KEYS=akapen:<32+ 位随机串>           ← 没配会拒启动
#   WEBHOOK_SECRET=<32+ 位随机串>           ← 客户端校验回调用
#   USE_VPC_ENDPOINT=true                   ← 仅当机器和 DashScope 同 region

# 2) 准备宿主机数据目录（容器以 uid 1000 跑）
mkdir -p data
# 自建 Linux 宿主上若你的 uid 不是 1000：sudo chown -R 1000:1000 data
# 或者 build 时对齐：USER_UID=$(id -u) USER_GID=$(id -g) docker compose build

# 3) 起服务
docker compose up -d --build

# 4) 验活
curl http://127.0.0.1:8000/v1/livez       # → 200 OK
curl http://127.0.0.1:8000/v1/readyz      # → 200 OK（启动完成后）
docker compose logs -f backend            # 看实时日志
```

宿主机持久化目录长这样：

```
./data/
├── grading.db           # SQLite 任务库（含 grading_tasks / schema_versions）
├── grading.db-wal       # WAL 模式辅助文件
├── uploads/             # multipart 收到的原图 + 标准化后图片
└── logs/                # app.log（滚动 5MB × 3 备份）
```

常用维护命令：

```bash
docker compose ps                           # 查容器健康状态
docker compose restart backend              # 改 .env 后重启（不重新打镜像）
docker compose down && docker compose up -d # 升级镜像后干净重起（数据保留）
docker compose down -v                      # ⚠ 不要轻易跑：会删 named volume（虽然这里只用 bind mount）
docker compose exec backend python -m backend.app --help    # 进容器排查

# 备份 SQLite（推荐每天 cron 一次）
docker compose exec backend sqlite3 /app/data/grading.db ".backup /app/data/backup-$(date +%F).db"
# 或者直接 rsync ./data 到别的机器，因为 WAL 模式下 .db + .db-wal 一起复制就行
```

升级中台代码：

```bash
git pull
docker compose up -d --build      # 仅 backend 服务，重启时间一般 < 10s
# 启动时会自动 reclaim 上次没跑完的任务（详见 §六《startup reclaim》），不丢请求
```

跨架构构建（开发机 macOS arm64 → 服务器 linux/amd64）：

```bash
docker buildx build --platform linux/amd64 -t akapen-backend:latest --load .
# 然后 docker save | ssh server docker load
```

### 2C2G + 3 Mbps 部署提示

中台默认配置已经为「单校单机 + 公网 3 Mbps」做了带宽优化（详见
`docs/PLAN_CN_SINGLE_SCHOOL_2C2G.md` §〇）：

- ``Settings.enable_single_shot=True`` —— 一次 vision 调用同时完成 OCR + 评分，
  比两步模式省一半带宽
- ``Settings.grading_with_image=False`` —— 两步模式时批改阶段不再发图（仅文本）
- ``Semaphore(8) + TokenBucket(2400 kbps)`` —— 并发不超载、上行不超额

如果服务器是阿里云 ECS **且与 DashScope 同 region**，加 ``USE_VPC_ENDPOINT=true``
切到内网 endpoint，**完全不占公网带宽**：

```bash
# .env
USE_VPC_ENDPOINT=true
MAX_CONCURRENCY=20      # 内网了，并发可以拉高
BANDWIDTH_KBPS=200000   # 形同关闭桶
```

## API Provider

默认走 **阿里云百炼（DashScope）的 Qwen3-VL**，原因：

- 国内网络稳，延迟比 Gemini 低很多。
- 日语手写实测好，对涂改 / 插字 / 划线推理够用。
- 价格便宜，`qwen3-vl-plus` 比 `gemini-3.1-pro` 便宜 ~5×；用 batch 还能再 5 折。

| Provider | 视觉（OCR / 看图批改） | 纯文本（仅批改） | 备注 |
| --- | --- | --- | --- |
| `qwen`（默认） | `qwen3-vl-plus` / `qwen3-vl-flash` | `qwen3.6-plus` / `qwen3.6-flash` / `qwen3.5-plus` / `qwen3.5-flash` | 阿里云百炼 OpenAI 兼容协议；纯文本模型选了会自动跳过附图 |
| `gemini` | `gemini-3.1-pro` / `gemini-2.5-pro` / `gemini-2.5-flash` / `gemini-2.5-flash-lite` | — | 海外 |
| `claude` | `claude-sonnet-4-5` / `claude-opus-4-5` / `claude-haiku-4-5` | — | 仅批改可选 |

> 百炼上 `qwen3-vl-235b-a22b-instruct/-thinking`、`qwen-vl-max-latest`、`qwen-vl-ocr-latest`
> 这些不在默认开通范围里，需要单独在「模型广场」申请；申请到之后直接在 UI 模型框
> 粘贴 ID 即可（dropdown 都开了 `allow_custom_value`）。
>
> ⚠ Qwen3-VL 系列**没有 max** 这一档，旗舰就是 `qwen3-vl-plus`；UI 上看到的「Max」
> 一般是旧 Qwen2-VL 时代的 `qwen-vl-max-latest`，不要混淆。

申请百炼 Key：<https://bailian.console.aliyun.com/> → API-KEY 管理 → 创建。
Key 形如 `sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`。

## 输入格式

每位学生一个**子文件夹**，文件夹名 `学号_姓名`，里面放页码命名的图片：

```
data/input/
├── 2024001_王伟/
│   ├── 1.jpg          # 第 1 页
│   ├── 2.jpg          # 第 2 页
│   └── 3.jpg          # 第 3 页
├── 2024002_李娜/
│   └── 1.jpg
└── 2024003_张敏/
    ├── 1.jpg
    └── 2.png
```

规则：

- 文件夹名第一个 `_` 之前 = 学号，之后 = 姓名（学号支持字母数字混合，姓名支持中文/日文）。
- 图片支持 `.jpg / .jpeg / .png / .webp`。
- 同一学生的多页会按文件名里的**数字**排序，一次性合并送 Gemini 多模态 OCR 转写为一篇连续作文。
- 没有任何正则需要配置 —— 只要遵守命名约定即可。

## 项目结构

```
.
├── core/                   # 共享业务核心（模式 A 和 B 都依赖这里，自身不依赖任何一边）
│   ├── config.py           #   Settings + UI 模型 catalog + 双档画质预设
│   ├── schemas.py          #   域模型：GradingResult / SingleShotResult（pydantic）
│   ├── providers/          #   LLM provider 抽象层（详见 AGENTS.md）
│   │   ├── base.py         #     Provider ABC + ProviderError
│   │   ├── qwen.py         #     QwenProvider（阿里云百炼，OpenAI 兼容协议）
│   │   ├── gemini.py       #     GeminiProvider
│   │   ├── claude.py       #     ClaudeProvider
│   │   └── __init__.py     #     make_provider(name, settings) 工厂
│   ├── ocr.py              #   OCR 业务逻辑（provider-agnostic）
│   ├── grader.py           #   批改业务：grade（markdown）/ grade_json / single_shot
│   ├── imageproc.py        #   图片标准化（path / bytes 两个入口）
│   └── logger.py           #   日志 + task_id contextvar
├── demo/                   # 模式 A · 离线 Gradio Demo（uv run python -m demo.app）
│   ├── app.py              #   Gradio UI 主入口
│   ├── filenames.py        #   学号_姓名/页码.jpg 文件夹扫描
│   └── storage.py          #   每位学生一份 record JSON 持久化
├── backend/                # 模式 B · 批改任务中台（FastAPI + SQLite + asyncio worker）
│   ├── app.py              #   create_app() + lifespan + uvicorn 入口
│   ├── config.py           #   BackendSettings：core.Settings + API key / 并发 / 带宽
│   ├── db.py               #   aiosqlite 连接 + WAL + schema 迁移
│   ├── schemas.py          #   API 边界 pydantic（请求 / 响应 / webhook payload）
│   ├── repo.py             #   任务 CRUD + 状态机 + reclaim
│   ├── auth.py             #   X-API-Key 鉴权 dependency
│   ├── rate_limit.py       #   slowapi 按 api_key_id 限流
│   ├── routes/             #   FastAPI 路由
│   │   ├── tasks.py        #     POST/GET/list/retry/cancel
│   │   └── health.py       #     /livez /readyz /healthz /metrics
│   ├── worker.py           #   asyncio worker：Semaphore(8) + token bucket + grader 调用
│   ├── fetcher.py          #   URL→bytes 异步拉图（httpx + 退避 + size/mime 校验）
│   ├── webhook.py          #   HMAC-SHA256 回调（独立队列 + 指数退避 + 死信箱）
│   ├── token_bucket.py     #   全局上行带宽令牌桶
│   ├── metrics.py          #   Prometheus 指标定义
│   └── admin_ui.py         #   只读 Gradio 后台（挂在 /admin）
├── prompts/
│   ├── ocr.md              # OCR 默认 prompt
│   ├── grading.md          # 批改 prompt（要求严格 JSON 输出）
│   └── single_shot.md      # Single-shot prompt（一次 vision 调用同时返转写+评分）
├── docs/
│   └── PLAN_CN_SINGLE_SCHOOL_2C2G.md  # 中台架构说明 / 容量预算（保留作历史参考）
├── scripts/
│   └── smoke_api.py        # 5 路烟测脚本（uv run python -m scripts.smoke_api）
├── data/                   # ⚠ gitignore；本地 + Docker 容器挂载点
│   ├── input/              #   学生作文输入目录（模式 A）
│   ├── records/            #   每位学生一份 record JSON（模式 A）
│   ├── exports/            #   导出的 Markdown（模式 A）
│   ├── grading.db          #   中台任务库（模式 B；首次启动自动创建）
│   ├── uploads/            #   中台 multipart 上传 + 标准化后图片（模式 B）
│   └── logs/               #   持久化运行日志（两种模式共享）
├── pyproject.toml          # 依赖 single source of truth（uv 用）
├── uv.lock                 # uv 锁文件（committed，复现性靠它）
├── requirements.txt        # uv export 自动生成，仅供 Docker 构建用
├── Dockerfile              # python:3.12-slim + non-root + healthcheck（模式 B）
├── docker-compose.yml      # 一键部署：8000 端口 + ./data 挂载 + 1.5G 内存上限
├── .dockerignore           # 排除 venv / git / data / dataset 等
└── AGENTS.md               # 给 AI 改这个仓库时看的架构指南
```

新增一个 LLM provider（例如 OpenAI / 火山引擎 / 本地 vLLM）的步骤详见 `AGENTS.md`。

## 默认模型 & 思考策略

- **OCR**：`qwen3-vl-plus`（百炼 Qwen3-VL 旗舰，~5–10 秒/页）。
  非流式 chat 默认不开思考，对应 Gemini 的 `thinking_budget=0`：让 OCR 保持
  「快而傻」—— 原文转写、不主动纠错、看不清的字打 `[?]`。这能避免模型偷偷把
  学生写错的地方"修正"成正确的，导致批改时漏扣分。
- **批改**：默认同样 `qwen3-vl-plus` + **多模态**。批改模型同时收到 OCR 草稿和
  **学生原图**，会先看图核对 OCR、补全 `[?]`、剔除印刷干扰，再依据校对后的文本评分。
  想省钱可换 `qwen3.6-plus`/`qwen3.5-plus` 等纯文本模型（自动不附图、只读 OCR 草稿）；
  想要更强推理可申请 `qwen3-vl-235b-a22b-thinking`，或切到 `claude-sonnet-4-5` /
  `gemini-3.1-pro`。

## 图片预处理

`core/imageproc.py` 在每次送 API 前会对每张图：

1. 按 EXIF 信息纠正方向；
2. 模式统一成 RGB；
3. 长边缩放到 1600 px（保留清晰度的前提下给真实大图省带宽）；
4. 重新编码 JPEG quality=85 + progressive。

学生手机直拍的 4000+ 像素大图能压到几百 KB，单次请求传输/计费都明显降低。

## 性能 & 调试

设置 Tab 里有：

- **OCR 并发数 / 批改并发数**：默认 8 / 6，按你的速率限额调。
- **单次超时 (秒)**：避开「Processing 半天没反应」的情况（注意 httpx timeout 是 per-IO，不是 wall-clock）。
- **最多重试次数**：429/5xx 自动退避重试。

「任务」Tab 底部的**实时日志框**每 2 秒自动刷新一次内容来自 `data/logs/app.log`，刷新页面也不会丢，方便定位卡住的请求。

## 编辑后再重跑

「修改」Tab 里编辑 OCR 文本后，点「📝 用当前转写重新批改」会以你修改后的文本送批改，是处理 OCR 错字 / 疑难笔迹的主要手段。多页学生会以 Gallery 形式展示原图。

## 数据存放

所有运行时数据保存在 `data/` 目录：

- `data/settings.json` —— UI 中保存的设置（API key、模型、并发、prompt…）
- `data/records/<key>.json` —— 每个学生一个 JSON（学号、图片路径列表、转写、批改、分数）
- `data/exports/` —— 导出的 Markdown
- `data/logs/app.log` —— 滚动日志（5MB × 3 备份）
