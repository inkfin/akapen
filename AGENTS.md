# AGENTS.md

> 给后续维护这个仓库的人（不管是真人还是 LLM agent）看的架构指南。
> 用户可见的功能 / 启动方式见 `README.md`，本文件只讲**怎么改代码**。

## 〇、三个入口 + 共享内核 + 一个外挂前端

仓库 *python* 部分提供两个独立入口，共享 `core/` 业务核心；*JS* 部分提供第三个
入口（Next.js 老师端），它**不 import core**，只通过 HTTP 调 backend：

```text
┌──────────────────────┐                            ┌──────────────────────┐
│ demo/ (Gradio)       │  模式 A：离线批量批改      │ backend/ (FastAPI)   │  模式 B：批改任务中台
│ - 扫描 data/input/   │                            │ - REST API           │
│ - 写 data/records/   │                            │ - SQLite (WAL)       │
└──────────┬───────────┘                            │ - asyncio worker     │
           │                                        │ - webhook 回调       │
           │             ┌────────────────┐         │ - /admin 上挂 Gradio │
           └────────────▶│   core/ (业务) │◀────────┴──────────┬───────────┘
                         └────────┬───────┘                    │
                                  ▼                            │ HTTP
                         ┌────────────────┐                    │ (web → backend)
                         │ core/providers │                    │
                         └────────────────┘                    │
                                                               │
                                              ┌────────────────┴───────────┐
                                              │ web/ (Next.js)             │  模式 C：老师端
                                              │ - 班级/学生/作业 CRUD      │
                                              │ - 移动端拍照上传           │
                                              │ - 批改大盘 (学生×题矩阵)   │
                                              │ - SQLite (web.db)          │
                                              └────────────────────────────┘
```

**模式 A/B 共用 core**：所有 prompt、所有 provider、所有 grading schema。
**模式 C 不 import core**：避免双语言运行时纠缠；它只跨 HTTP 调 backend，并复用
backend 的 `WEBHOOK_SECRET` 做回调验签。

依赖方向（单向）：

- `demo/` ──▶ `core/`（合法）
- `backend/` ──▶ `core/`（合法）
- `web/` ──▶ `backend/` 仅通过 HTTP（合法），**不**直接 import `core/` 或 `backend/`
- `core/` ──▶ `demo/` ❌
- `core/` ──▶ `backend/` ❌
- `core/` ──▶ `web/` ❌（语言不通，也不许）
- `demo/` ↔ `backend/` ❌（两条路径完全独立，绝不互相 import）
- `backend/` ──▶ `web/`：仅通过 webhook + `image_urls`（合法），不 import

## 一、核心理念

业务逻辑（OCR / 批改）和 LLM provider（Qwen / Gemini / Claude / …）解耦。

```text
┌──────────────┐     ┌────────────────┐     ┌──────────────────────┐
│ demo/app.py /│────▶│ core/ocr.py    │────▶│ core/providers/      │
│ backend/     │     │ core/grader.py │     │   QwenProvider       │
│   worker.py  │     │ (业务流程)      │     │   GeminiProvider     │
└──────────────┘     └────────────────┘     │   ClaudeProvider     │
                                            │  ──────────────────  │
                                            │  统一 chat() 接口     │
                                            └──────────────────────┘
```

- 顶层入口（`demo/app.py` 或 `backend/worker.py`）只关心任务编排，调用
  `make_provider(name, settings)` 拿到一个 Provider，然后传给业务函数：
  - `transcribe(...)` —— OCR
  - `grade(...) -> markdown` —— 老接口（Gradio 修改 Tab 用）
  - `grade_json(...) -> GradingResult` —— 新 JSON 接口（后端主路径）
  - `single_shot(...) -> SingleShotResult` —— 一次 vision 调用同时返回转写+评分
- `core/ocr.py` / `core/grader.py` 完全不知道 provider 是哪家，只调用 `Provider.chat()`。
- `core/providers/` 是 LLM API 适配层，每家 provider 一个文件，互不依赖。

## 二、文件地图（按依赖方向）

### `core/`（业务核心，两种模式共用）

| 文件 | 职责 | 关键导出 |
| --- | --- | --- |
| `core/imageproc.py` | 图片预处理：EXIF 旋正 + RGB + 长边缩放 + JPEG 重编码 | `standardize_jpeg(path)`、`standardize_jpeg_bytes(data)` |
| `core/schemas.py` | 域模型：评分结果的 pydantic schema（严格校验 + 重试用） | `GradingResult`、`SingleShotResult`、`DimensionScore`、`Deduction` |
| `core/providers/base.py` | Provider 抽象基类（`chat(image_paths=...,image_bytes=...)`） | `Provider`（ABC）、`ProviderError` |
| `core/providers/qwen.py` | Qwen / 阿里云百炼（OpenAI 兼容协议） | `QwenProvider` |
| `core/providers/gemini.py` | Google Gemini（google-genai SDK） | `GeminiProvider` |
| `core/providers/claude.py` | Anthropic Claude | `ClaudeProvider` |
| `core/providers/__init__.py` | provider 注册表 + 工厂 | `make_provider(name, settings)`、`registered_providers()` |
| `core/config.py` | Settings + 模型 catalog + 双档画质 + VPC endpoint 开关 | `Settings`、`OCR_MAX_LONG_SIDE`、`GRADING_MAX_LONG_SIDE`、`DASHSCOPE_VPC_BASE_URL` |
| `core/ocr.py` | OCR 业务（多页合并 + thinking=False；`image_paths` 或 `image_bytes` 二选一） | `transcribe(...) -> str`、`OCRError` |
| `core/grader.py` | 批改业务（vision/text 自动切换；markdown / json / single-shot 三种入口） | `grade()`、`grade_json()`、`single_shot()`、`GradingError` |
| `core/logger.py` | 集中日志 + task_id contextvar 注入 | `setup_logging()`、`tail_log()`、`set_task_id()` / `reset_task_id()` |

> **`core/` 不再持有任何 prompt 文件**——三种入口各带一套独立 prompts，详见下面
> 各模块文件地图 + 第 §九.5 节"prompt 模板的三套独立来源"。

### `demo/`（模式 A：离线 Gradio）

| 文件 | 职责 | 关键导出 |
| --- | --- | --- |
| `demo/app.py` | Gradio UI 主入口（`uv run python -m demo.app`） | `build_ui()`、`DEMO_PROMPTS_DIR` |
| `demo/filenames.py` | `学号_姓名/页码.jpg` 文件夹扫描 | `scan_folder()` |
| `demo/storage.py` | 每位学生一份 JSON 记录（落到 `data/records/`） | `StudentRecord`、`extract_score()`、`make_key()` |
| `demo/prompts/ocr.md` | demo 模式 OCR prompt 默认（**通用框架自包含**，不绑题型） | （文本资源） |
| `demo/prompts/grading.md` | demo 模式批改 prompt 默认（含 `{ocr_review_block}` 占位符；**不**含 `{rubric}`） | （文本资源） |
| `demo/prompts/single_shot.md` | demo 模式 single-shot prompt 默认（**通用框架自包含**） | （文本资源） |

### `backend/`（模式 B：批改任务中台）

| 文件 | 职责 | 关键导出 |
| --- | --- | --- |
| `backend/app.py` | FastAPI app 工厂 + lifespan + uvicorn 入口 | `create_app()`、`AppState`、`main()` |
| `backend/config.py` | `BackendSettings`：core.Settings + API key / 并发 / 带宽 / DB 路径 | `BackendSettings.load()`、`BACKEND_PROMPTS_DIR` |
| `backend/db.py` | aiosqlite 连接 + WAL 模式 + 幂等 schema 迁移 | `Database`、`row_to_dict` |
| `backend/schemas.py` | API 边界 pydantic（请求 / 响应 / webhook payload） | `TaskCreateRequestJSON`、`TaskStatus`、`WebhookPayload`、状态机常量 |
| `backend/repo.py` | 任务 CRUD + 幂等 INSERT + 状态机转换 + reclaim | `create_task`、`get_task`、`list_tasks`、`save_grading_result`、`reclaim_stuck_tasks` |
| `backend/auth.py` | `X-API-Key` middleware（FastAPI dependency） | `require_api_key`、`api_key_id_from_request` |
| `backend/rate_limit.py` | slowapi 限流（按 api_key_id） | `limiter`、`install_limiter` |
| `backend/routes/tasks.py` | REST 路由：POST/GET/list/retry/cancel；multipart + JSON 双入参 | `router` |
| `backend/routes/health.py` | `/livez` `/readyz` `/healthz` `/metrics` | `router` |
| `backend/worker.py` | asyncio worker：Semaphore(8) + token bucket + grader 调用 | `Worker` |
| `backend/fetcher.py` | URL → JPEG bytes 异步拉图（httpx + 退避 + size/mime 校验） | `fetch_one`、`fetch_many`、`FetcherError` |
| `backend/webhook.py` | HMAC-SHA256 回调（独立队列 + 指数退避 + 死信箱） | `WebhookDispatcher`、`verify_signature` |
| `backend/token_bucket.py` | 异步全局上行字节令牌桶 | `TokenBucket.from_kbps()` |
| `backend/metrics.py` | Prometheus 指标定义 | 各种 Counter / Histogram / Gauge |
| `backend/admin_ui.py` | 只读 Gradio 后台（任务列表 / 详情 / 重试），挂在 `/admin` | `mount_admin`、`build_admin_ui` |
| `backend/prompts/ocr.md` | backend worker fallback OCR prompt（web 没传 override 时用） | （文本资源） |
| `backend/prompts/grading.md` | backend worker fallback 批改 prompt（含 `{ocr_review_block}`；**不**含 `{rubric}`） | （文本资源） |
| `backend/prompts/single_shot.md` | backend worker fallback single-shot prompt | （文本资源） |

## 三、Provider 接口契约

每个 provider 子类实现 `core/providers/base.Provider` 的接口：

```python
class Provider(ABC):
    name: ClassVar[str]                       # 与 _REGISTRY 的 key 一致

    @classmethod
    def from_settings(cls, settings) -> Self  # 从全局 Settings 构造
    def chat(prompt, image_paths, *, model, timeout_sec, max_attempts,
             temperature, thinking, label) -> str  # 单轮 chat
    def is_vision_model(model) -> bool        # 是否能看图（默认 True）
    def supports_thinking_toggle(model) -> bool  # 能否切换思考模式（默认 False）
```

### `chat()` 的语义

- **必返回非空文本**；任何错误都抛 `ProviderError`（业务层会再包成 `OCRError` /
  `GradingError`）。
- 不该静默 strip 入参 —— 调用方传什么，就发什么。"图片要不要发" 由 `core/grader.py`
  根据 `is_vision_model()` 提前决定。
- 日志格式约定：`[<Provider> ▶] <label> (<n>图, <kb>KB, model=..., thinking=..., timeout=...s)`
  开始；`[<Provider> ✓] <label> <chars>字 in <s>s` 结束；失败用 `[<Provider> ✗]`。

### `thinking` 参数三态

| 值 | 语义 |
| --- | --- |
| `None` | 不传 thinking 参数，走模型默认 |
| `True` | 尽量启用思考模式（Qwen `enable_thinking=True`；Gemini 留空 budget） |
| `False` | 尽量关闭思考（Qwen `enable_thinking=False`；Gemini `thinking_budget=0`） |

不支持切换的模型（Qwen `-235b-a22b-instruct/-thinking`、`qwen-vl-ocr-*`）会被
provider **自动忽略并打 info 日志**，**不抛错**。

### 用法约定

- **OCR**（`core/ocr.py:transcribe`）：始终传 `thinking=False`。让模型只做转写，
  不主动纠错、看不清打 `[?]`。
- **批改**（`core/grader.py:grade`）：传用户在 UI 勾选的 `thinking` bool。

## 四、Vision / Text 模式（仅批改）

`core/grader.py:grade()` 根据 **provider 能力 + 是否真的有图** 自动切：

```python
is_vision_mode = provider.is_vision_model(model) and bool(paths)
```

- **vision 模式**：图片正常发，prompt 用 `VISION_REVIEW_BLOCK`（"先看图再评分"）。
- **text 模式**：图片**不发出去**，prompt 用 `TEXT_REVIEW_BLOCK`（"你看不到图，
  别假装看了图"），避免纯文本模型幻觉。

prompt 模板里的 `{ocr_review_block}` 占位符会被自动替换。对没占位符的老 prompt
（用户 settings.json 里可能存的旧版本），用 regex `_LEGACY_VISION_BLOCK`
一次性迁移老的「重要：OCR 校对说明」段落。

## 五、新增一个 Provider 的步骤

以 OpenAI 为例（同样适用于火山引擎、本地 vLLM、Ollama 等）：

1. **写 provider 类** —— 在 `core/providers/openai_provider.py`：

   ```python
   from typing import ClassVar
   from .base import Provider, ProviderError

   class OpenAIProvider(Provider):
       name: ClassVar[str] = "openai"

       def __init__(self, *, api_key: str): ...

       @classmethod
       def from_settings(cls, settings):
           return cls(api_key=settings.openai_api_key)

       def is_vision_model(self, model: str) -> bool:
           return "vision" in model or "gpt-4o" in model or "gpt-5" in model

       def supports_thinking_toggle(self, model: str) -> bool:
           return False  # OpenAI 当前没有运行时切换 reasoning effort 的接口

       def chat(self, prompt, image_paths, *, model, timeout_sec, max_attempts,
                temperature, thinking, label):
           # 调 OpenAI Chat Completions / Responses API，把 image_paths 编成 base64
           # data URL 塞进 messages 即可。错误统一抛 ProviderError(...)。
           ...
   ```

2. **登记** —— `core/providers/__init__.py`：

   ```python
   from .openai_provider import OpenAIProvider

   _REGISTRY: dict[str, type[Provider]] = {
       QwenProvider.name: QwenProvider,
       GeminiProvider.name: GeminiProvider,
       ClaudeProvider.name: ClaudeProvider,
       OpenAIProvider.name: OpenAIProvider,   # ← 新增
   }
   ```

3. **加 settings 字段** —— `core/config.py:Settings`：加一个 `openai_api_key: str = ""`，
   并在 `Settings.load()` 里加一行 `openai_api_key=os.getenv("OPENAI_API_KEY", "")`。

4. **加到 catalog** —— `core/config.py`：

   ```python
   OCR_MODEL_CATALOG["openai"] = ["gpt-5-vision", ...]
   GRADING_MODEL_CATALOG["openai"] = [...]
   # OCR_PROVIDERS / GRADING_PROVIDERS 自动从 catalog.keys() 推出，不用动
   ```

5. **加 UI 输入** —— `demo/app.py` 设置 Tab：加一个 `openai_key = gr.Textbox(...)`，
   把它接进 `save_settings(...)` 的入参列表 + 顶层 `inputs=[...]` 列表。

6. **不要碰** `core/ocr.py` / `core/grader.py` —— 它们对 provider 完全无感。

## 六、关键设计决策（解释 "为什么这样写"）

### 6.1 Provider 不做静默回退

旧版 `core/qwen.py` 在收到纯文本 model 时会自动 strip 掉图片附件。新版**不再这样
做**——这是数据层不该有的隐式行为。现在统一由 `core/grader.py` 提前根据
`provider.is_vision_model(model)` 决定要不要把 paths 传进 `chat()`。

好处：

- provider 行为可预测（传啥发啥）；
- 业务层有完整决策权（同时还能切换 prompt 文案）；
- OCR 路径根本不会遇到这种情况（catalog 限制了 OCR 只能选视觉 model）。

### 6.2 Provider 实例 vs 名字字符串

`transcribe()` / `grade()` 收的是 `Provider` 实例，不是字符串名字。
理由：

- 调用点（`demo/app.py` 或 `backend/worker.py`）只需要 `make_provider` 一次，
  并发 worker 闭包里复用，避免每条记录重新查 registry。
- 业务函数签名直接表达 "我需要一个 provider"，比 "我需要 provider name + 一堆 api key"
  清楚得多。

### 6.3 `Settings` 是 provider 配置的唯一入口

每个 provider 用 `from_settings(cls, settings)` 自取需要的字段。
所以新增 provider 只要往 `Settings` 加一两个字段，业务函数签名不动。
这就是为什么 `transcribe()` / `grade()` 不再有 `gemini_api_key=` /
`dashscope_api_key=` 这种 provider 专属 kwargs——它们已经被封装到 Provider 实例里。

### 6.4 Catalog 是 UI hint，不是 hard 限制

`OCR_MODEL_CATALOG` / `GRADING_MODEL_CATALOG` 只是给下拉填默认选项；
所有 model dropdown 都开了 `allow_custom_value=True`，用户能粘贴任意 ID。
这样无需改代码就能接 catalog 里没列的快照（如 `qwen3-vl-plus-2025-09-23`）
或单独申请的额外 model（如 `qwen3-vl-235b-a22b-thinking`）。

### 6.5 prompt 占位符 + legacy 迁移

三套 grading.md（`demo/prompts/`、`backend/prompts/`、`web/lib/model-catalog.ts:DEFAULT_PROMPT_GRADING`）
都用 `{ocr_review_block}` 占位符；vision/text 由 `core/grader.py` 按当前模式填充。
但现网用户 `data/settings.json` 里很可能存着没有占位符的旧 prompt，所以保留了一段
`_LEGACY_VISION_BLOCK` regex，自动把老的 "重要：OCR 校对说明" 段升级成动态 block，
避免要求用户手动重置 prompt。

## 七、调试 / 烟测建议

写改 provider 后建议跑一遍 4 路烟测（小图 + 短 transcript 控成本）：

| # | 路径 | 关键期望 |
| --- | --- | --- |
| 1 | OCR / 视觉 model | 日志含 `mode=vision`、`thinking=off`，返回非空 |
| 2 | 批改 / 视觉 model + 图 | `mode=vision`，图实际发出去 |
| 3 | 批改 / 文本 model + 图 | `mode=text-only`，**0 图发出**，model 输出不出现 "我看了图" 之类幻觉句 |
| 4 | 批改 / 视觉 model + `thinking=True` | `thinking=on`，正常返回 |

运行示例：

```bash
uv run python - <<'PY'
import logging; logging.basicConfig(level=logging.INFO)
from core.config import Settings
from core.providers import make_provider
from core.ocr import transcribe
s = Settings.load()
print(transcribe(["data/input/2024002_李娜/1.jpg"],
                 provider=make_provider("qwen", s),
                 model="qwen3-vl-flash", prompt=s.ocr_prompt,
                 timeout_sec=60, max_attempts=1)[:80])
PY
```

`data/logs/app.log` 里能看到完整的 `[OCR ▶] / [Qwen ▶] / [OCR ✓]` 链路日志。

## 八、不要做的事

- ❌ 在 `core/ocr.py` / `core/grader.py` 里写 `if provider == "xxx"` 分支
 —— 抽象就废了。
- ❌ 让 provider 在 `chat()` 里自作主张改 `image_paths` / `image_bytes` —— 调用方有更完整的上下文。
- ❌ 把 API key 传进业务函数 —— 应该走 `Settings → from_settings → Provider`。
- ❌ 在 prompt 里硬编码 "请看图…" —— 用 `{ocr_review_block}` 占位符，让 `grader` 切换。
- ❌ 把 `core/providers/__init__.py` 弄成"业务路由"——它只是注册表，不应该出现
 `if name == "qwen": ...` 这种业务分支。
- ❌ 在 `core/` 里 `import backend.*` 或 `import demo.*` —— 单向依赖，反过来必然出问题。
- ❌ 在 `demo/` 和 `backend/` 之间互相 import —— 两条入口完全独立。
- ❌ 在 `backend/worker.py` 里直接读 / 写 `data/records/` 老 JSON —— 中台只用 SQLite。
- ❌ 在 `backend/routes/` 里做异步 LLM 调用 —— 路由只负责落库 + 入队列，业务在 worker。
- ❌ 在 `pyproject.toml` 之外维护依赖 —— `requirements.txt` 是 `uv export` 自动生成的，
  不要手编辑；改依赖只改 `pyproject.toml`，再 `uv lock && uv export ...` 即可。

## 八½、Prompt 模板的三套独立来源

历史上 `prompts/` 在仓库根目录被 demo 和 backend 共用，违反 §零 "demo / backend
完全独立"原则；2026-05 拆成三套独立来源：

| 来源 | 服务于 | 含 `{rubric}` 占位符？ | 主要 owner |
| --- | --- | --- | --- |
| `demo/prompts/{ocr,grading,single_shot}.md` | 模式 A（Gradio 离线） | ❌ 不含 | demo 用户：Gradio "设置" Tab 改完会持久化到 `data/settings.json` |
| `backend/prompts/{ocr,grading,single_shot}.md` | 模式 B（中台 worker fallback） | ❌ 不含 | 运维：现网 web 总是显式传 `providerOverrides`，这套基本不会被读到 |
| `web/lib/model-catalog.ts:DEFAULT_PROMPT_*` | 模式 C（web 老师端"重置为推荐模板"按钮） | ✅ 含，由 web 在 POST 给 backend 前替换 | 老师：在 web 设置页可改全局模板 |

加载机制（`core/config.py:Settings.load_prompts(prompts_dir)`）：

- `core/` 不持有任何 prompt 文件路径，`Settings.load()` 只把 `*_prompt` 字段
  默认成空串。
- 各入口在 `Settings.load()` 之后**显式**调 `s.load_prompts(自家目录)`：
  - `demo/app.py:_load_settings()` → `s.load_prompts(DEMO_PROMPTS_DIR)`
  - `backend/config.py:BackendSettings.load()` → `core.load_prompts(BACKEND_PROMPTS_DIR)`
- `data/settings.json` 里 user 改过的持久化值 > prompts 目录的默认值（`load_prompts`
  只填空字段）。

**改 prompt 时三套要同步**——它们对应同一份 `core/schemas.py:GradingResult`，
跑出来的 LLM 输出 JSON schema 必须一致，不然 demo / backend / web 三条路径任一
出现 schema 漂移都会引发 GRADING_FAILED。

**不要做的事**：

- ❌ 让 `core/` 重新长出 `PROMPTS_DIR` / `_read_prompt` —— 单向依赖，core 不能
  知道任何入口的存在。
- ❌ 在 `demo/prompts/` 或 `backend/prompts/` 写 `{rubric}` —— backend
  `core/grader.py` 的 `str.replace` 不识别它，会被原样发给 LLM。
- ❌ 在 `web/lib/model-catalog.ts:DEFAULT_PROMPT_*` 漏掉 `{rubric}` —— web 端
  settings 保存时会校验报错。
- ❌ 把 demo / backend / web 任何一套 copy 给另一套 —— 它们三套 owner 不同、
  可演化方向不同，强行拉齐反而失去拆分意义。

## 九、模式 B 改代码时的关键约束（2C2G + 3 Mbps）

- **图片标准化只做一次**：fetcher 拉到 → `standardize_jpeg_bytes()` → bytes 缓存
  在 worker 内存里 + 同时写盘做审计；OCR / 批改 / single-shot 都从这份 bytes 走，
  不再二次 decode。
- **provider.chat 优先 image_bytes**：传了 bytes 就用 bytes，传了 path 才退化到
  从盘读 + 标准化。`backend/worker.py` 始终走 bytes 路径；`demo/app.py`（Gradio）
  目前还走 path 路径（兼容性）。
- **不要在路由里阻塞 / sleep**：所有可能慢的事（标准化、LLM 调用、webhook）都
  推到 worker / dispatcher 里跑。HTTP 路由只允许 DB 单语句 + 入队列。
- **token bucket 只管 LLM 上行**：webhook 不走 bucket（body 几 KB，影响忽略），
  fetcher 进站方向也不走（公网入向不收 LLM 端的钱）。
- **新增字段到 `grading_tasks` 表**：用 `ALTER TABLE ADD COLUMN` 写新的
  `_apply_v2()`（`backend/db.py`），别直接改 `_apply_v1()` —— 否则现网迁移会跳过。

## 十、5 路烟测（上线 / 改 worker 后必跑）

```bash
uv run python scripts/smoke_api.py
```

会跑 5 路（在脚本里依次出现）：

1. **JSON + 轮询**：POST 带 image_urls → 轮询到 succeeded
2. **multipart + 轮询**：POST 带 multipart 图片 → 轮询到 succeeded
3. **JSON + webhook**：起 echo server，验证 HMAC + 收到 succeeded
4. **故意 4xx webhook**：echo 返 400 → 重试 → dead 状态
5. **带宽压测**：30 个任务，看 `akapen_upload_bytes_total` 单分钟 ≤ 18 MB，
   `akapen_bucket_wait_seconds` p95 ≤ 30s

跑前先确认 `.env` 里 `API_KEYS=akapen:<32 字符>`，并启动中台
`uv run python -m backend.app`（或 `docker compose up -d`）。

## 十一、模式 C · `web/` 老师端 Next.js 应用

`web/` 是独立的 JS/TS 子项目（Next.js 15 + Prisma + SQLite + NextAuth v5 +
shadcn/ui + Tailwind v4），与 python 部分**进程级隔离**，docker-compose 中作为
service `web` 与 `backend` 并列。

### 11.1 `web/` 的边界

- **只做老师端业务**：班级 / 学生 / 作业批次 / 题目 CRUD + 拍照上传 + 批改大盘 +
  接 backend 的 task 状态。
- **不调 LLM**：所有评分都通过 `lib/akapen.ts` 走 `POST /v1/grading-tasks`。
- **不读 `core/grading.db`**：跟 backend 各自一个 SQLite (`web/data/web.db` 与
  `data/grading.db`)，互不感知。GradingTask 表只存「我们这边发起的批改请求」状态。
- **不提供给学生用**：产品决策 A，学生不登录；老师代为录入。

### 11.2 `web/` 与 `backend/` 的集成契约

| 字段 / 路径 | 意义 |
| --- | --- |
| `web` env `AKAPEN_BASE_URL` | docker-compose 同机部署：`http://backend:8000`；跨机：公网 URL |
| `web` env `WEB_PUBLIC_BASE_URL` | docker-compose 同机部署：`http://web:3000`；akapen 容器拉图用 |
| `web` env `AKAPEN_API_KEY` | 等于 backend `.env` 里 `API_KEYS=akapen:<this>` 的 secret 部分 |
| `web` env `WEBHOOK_SECRET` | **必须等于 backend 的 `WEBHOOK_SECRET`**（用同一份 HMAC 校验） |
| `web` env `IMAGE_URL_SECRET` | 仅 web 自家用，给 `/u/<token>.jpg` 签名；backend 不感知 |
| `POST web→backend body.image_urls` | `http://web:3000/u/<HMAC token>.jpg`，内网 docker 拉图，0 公网 |
| `POST web→backend body.callback_url` | `http://web:3000/api/webhooks/akapen` |
| `POST web→backend body.idempotency_key` | `<submissionId>:r<revision>`（见 `lib/akapen.ts:makeIdempotencyKey`） |
| `POST web→backend body.question_context` | 题干 + 评分要点拼出来的 ≤4000 字字符串（schema v2 引入） |
| Header `X-Akapen-Signature` | `t=<unix>,v1=<hex>`，`v1 = hmac_sha256(secret, f"{t}.{body}")` |

### 11.3 `web/` 文件地图

| 文件 | 职责 |
| --- | --- |
| `web/app/(auth)/login/` | 登录页（NextAuth Credentials + server action） |
| `web/app/(app)/classes/` | 班级 / 学生 CRUD |
| `web/app/(app)/batches/` | 作业批次 / 题目 CRUD + 移动端 upload 入口 |
| `web/app/(app)/grade/[id]/` | 批改大盘（学生 × 题号矩阵 + 多选 + 一键批改 + 详情抽屉） |
| `web/app/api/upload/` | 多部件接图，落盘 `data/uploads/<batch>/<student>/<q>/<sha>.jpg` |
| `web/app/api/uploads-preview/` | 给登录的老师本人浏览图片（session 鉴权） |
| `web/app/api/webhooks/akapen/` | akapen → web 的回调入口（HMAC 验签 + 落库） |
| `web/app/api/grade/{status,submit,retry}/` | 大盘轮询 + 批改提交 + 重试 HTTP wrapper |
| `web/app/u/[token]/` | 给 akapen 容器拉图的签名 URL（HMAC 鉴权） |
| `web/lib/auth.ts` / `auth.config.ts` | NextAuth v5（edge-safe config + 完整 config 分离） |
| `web/lib/db.ts` | Prisma client singleton（dev 防 hot reload 多实例） |
| `web/lib/akapen.ts` | akapen HTTP 客户端（创建任务 / 查状态 / 重试 + 退避） |
| `web/lib/hmac.ts` | 三种 HMAC 用法集中地（图片签名 / webhook 验签 / base64url） |
| `web/lib/uploads.ts` | 上传配置 + magic-byte 格式检测（拒 HEIC） |
| `web/lib/grade-data.ts` | 批改大盘数据装载（一次出 cells 矩阵） |
| `web/lib/actions/{classes,batches,grade}.ts` | server actions：CRUD + 提交批改 |
| `web/prisma/schema.prisma` | User / Class / Student / HomeworkBatch / Question / Submission / GradingTask |
| `web/scripts/create-user.ts` | 命令行加老师账号 |

### 11.4 改 `web/` 时的约束

- ❌ **不要 import `core/` 或 `backend/`**：根本 import 不到（不在同一 build 里），
  即便用 subprocess 调 python 也别这么做 —— 走 HTTP。
- ❌ **不要把 `demo/prompts/*.md` 或 `backend/prompts/*.md` 拷进 `web/`**：题目
  上下文通过 `question_context` 字段传过去就行；web 自己那套 prompt 模板已经在
  `web/lib/model-catalog.ts:DEFAULT_PROMPT_*`，含 `{rubric}` 占位符，跟 demo /
  backend 的版本是**三套独立来源**（详见 §八½）。
- ❌ **不要把 `WEB_PUBLIC_BASE_URL` 设成公网域名**（除非跨机部署）：会触发 hairpin
  陷阱，akapen 拉图会回到自己的公网出向，把 3 Mbps 打爆。详见
  `.cursor/plans/homework-frontend_*.plan.md` §八。
- ❌ **不要把 GradingTask.result 字段塞进轮询响应**：那是大块 JSON，每 3s 回包
  会喷大量字节。`lib/grade-data.ts` 已经只回 `finalScore + reviewFlag + status`，
  保持这样就好；想看完整 JSON 单独走 `/api/grade/result?id=...`（暂时未实现，
  按需加）。
- ❌ **不要在 client component 里直接 import server action**：用
  `/api/grade/submit` 这类 fetch wrapper，给 react-query 一个统一的错误处理路径。
- ❌ **不要把 `File` 原样塞进 `FormData` 上传**：必须先过 `web/lib/image-compress.ts`
  的 `compressImage()` / `compressImages()`。原因：iPhone 直拍 3~5 MB JPEG，
  老师 4G 上行要 30~60s 才能上传一张；前端 canvas 缩到 1280px 长边 + JPEG 70%
  后只剩 ~300 KB，3~5s 完成，体验差距巨大。helper 内部对 < 200 KB / HEIC /
  压缩失败都会自动 fallback 到原 file，调用方无需关心错误处理。HEIC 格式
  backend 已支持（`core/imageproc` 注册了 `pillow-heif`），不需要前端转格式，
  只需要 `<input accept>` 用 `web/lib/uploads.ts:UPLOAD_ACCEPT` 常量保证一致。
- ❌ **不要给新对话框直接用 shadcn `Dialog`**：移动端键盘弹起会顶飞 Dialog、
  两边白边浪费屏幕。改用 `web/components/ui/responsive-dialog.tsx` 的
  `ResponsiveDialog` 系列（API 与 shadcn `Dialog` 一致，桌面照样走 Dialog、
  移动端自动切到 vaul `Drawer` 底部上滑）。纯桌面后台页（不在手机访问）才
  例外。
- ❌ **不要用 `group-hover:` 显隐操作按钮**：触屏设备根本没有 hover 状态，
  老师在手机上**永远点不到**。删除 / 编辑这类操作图标必须始终可见
  （半透明背景 + 主图标即可保持视觉清爽）。

### 11.5 `web/` 烟测

```bash
cd web

# 1) 装依赖（用 npmmirror 加速，已写在 .npmrc 里）
npm ci

# 2) 跑数据库迁移到本地 SQLite
DATABASE_URL=file:./data/web.db npx prisma migrate deploy

# 3) 创建初始账号
DATABASE_URL=file:./data/web.db npm run create-user -- \
  --email teacher@example.com --password testtest --name 王老师

# 4) 起 dev server（默认 3000）
DATABASE_URL=file:./data/web.db \
AUTH_SECRET=testtesttesttesttesttesttesttest \
WEBHOOK_SECRET=与-backend-同步 \
IMAGE_URL_SECRET=testtesttesttesttesttesttesttest \
AKAPEN_BASE_URL=http://localhost:8000 \
AKAPEN_API_KEY=akapen-secret-from-.env \
WEB_PUBLIC_BASE_URL=http://host.docker.internal:3000 \
npm run dev
```

跨容器集成测试请用 `docker compose up`，不要在裸进程模式下连 docker network 里的
backend 服务（除非用 `host.docker.internal` 或加上 host 映射）。

## 十二、改完代码 → 本地测试 → 推送上线

每次发版按本节流程走。本地未验过的代码不要 push 到生产。

### 12.1 流程总览

```text
改代码 → 本地静态检查 → 本地端到端验活 → git commit + push
        → scripts/release.sh → ssh ECS dcp pull && up -d → 验活
        → 失败则按 12.6 回滚
```

### 12.2 本地静态检查

| 改了什么 | 跑什么 |
| --- | --- |
| `core/` / `backend/` python | `uv run ruff check . && uv run pytest` + `uv run python scripts/smoke_api.py`（见 §十） |
| `web/` ts/tsx | `cd web && npx tsc --noEmit && npm run lint` |
| `web/prisma/schema.prisma` | **必须**走 `./web/scripts/migrate.sh --name <短描述>`（详见 §12.2.5）；**不要**直接 `npx prisma migrate dev`；**永远不要**用 `prisma db push` |
| `demo/prompts/*.md` 或 `backend/prompts/*.md` 或 `web/lib/model-catalog.ts:DEFAULT_PROMPT_*` | 跑一次 §十 的烟测 1～2，确认 LLM 输出还能 parse；改一边时 cross-check 另两边是否要同步（见 §八½） |
| `Dockerfile` / `docker-compose.yml` | `docker compose config` 看一眼解析后的 yaml |

### 12.2.5 改 `web/prisma/schema.prisma` —— 必须走 `migrate.sh` wrapper

只要动了 prisma schema，**必须**这样跑：

```bash
./web/scripts/migrate.sh --name <短描述>
# 例：./web/scripts/migrate.sh --name add_question_difficulty
```

不要图省事直接 `cd web && npx prisma migrate dev --name xxx`，原因（踩过的坑）：

1. **`web/.env` 里 `DATABASE_URL=file:/app/data/web.db` 是容器内绝对路径**。在
   宿主机裸跑 prisma 时这个路径不存在，prisma 会**回落到按 `schema.prisma`
   所在目录解析相对路径**。如果你以为 `file:./data/web.db` 能指到 `web/data/web.db`，
   实际上它会被解析成 **`web/prisma/data/web.db`** —— 一个全新的 stray DB。
   migration 应用上去；启动 web 容器后查实际运行 DB 还是老 schema，下次启动
   `migrate deploy` 跑出冲突。
2. **不传 `--name` 会进交互模式**询问 migration 名字，agent / CI 跑直接卡死。
3. **`prisma db push` 不生成 migration 文件**，schema 漂移没有 git 痕迹，
   ECS 上的 `migrate deploy` 一脸懵。

`migrate.sh` 做的事（30 行 bash，不复杂）：

- 把 `DATABASE_URL` 强制覆盖成 **绝对路径** `file:<repo>/web/data/web.db`
- 跑前检查 `web/prisma/data/` 是不是已经有 stray DB，有就拒绝执行（要求先
  `rm -rf` 干净再来）
- 强制要求 `--name`，避免 agent 卡在交互
- 完成后打印下一步（重启容器 + git add）

**绝不**修改 `web/.env` 里的 `DATABASE_URL` 来"绕过" wrapper —— 那个值是容器
运行时用的，不能为了本地 prisma 调试改它，否则 docker compose 起来连不上 DB。

### 12.3 本地端到端验活（agent 自动跑，用户在浏览器验收）

完整链路涉及 backend + web 互联 + LLM 调用 + SQLite 卷挂载，单独 `uv run`
无法覆盖 web；裸跑 `npm run dev` 又要手动配一堆 env 与 webhook secret。
统一走 `docker compose`，以"agent 自检 + 起服 → 用户浏览器体验"为标准流程。

agent 改完代码后**自动跑**：

```bash
# 1) 静态检查通过后再起服（见 12.2）
# 2) 干净起一遍（带 build；首次 5～10 分钟，之后增量很快）
docker compose down
docker compose up -d --build

# 3) 等所有容器 healthy
docker compose ps

# 4) 探活
curl -fsS http://127.0.0.1:8000/v1/livez
curl -fsS http://127.0.0.1:3000/api/health

# 5) 如果改了 schema，确认 prisma migrate 跑过
docker compose logs web | rg 'migrate|migration' | tail
```

容器跑起来之后，agent 把以下信息丢给用户：

- 浏览器入口：<http://localhost:3000>
- 测试账号（首次部署用 `docker compose exec web node scripts/create-user.cjs ...` 建一个）
- 这次改动需要用户重点验的 UI 路径

agent 不要替用户跑完整业务流（登录 → 建班 → 建题 → 上传图 → 批改 → 出分）—
那条链路要烧 LLM token + 真图，且 LLM 输出是黑盒，用户肉眼验更可靠。

#### 加速：只改了 backend 的 python 代码

如果改的只是 `core/` / `backend/` / `prompts/` 而 web 不动，可以省掉
`--build`（python wheel 已 cache）：

```bash
docker compose up -d --build backend
```

或者只跑 backend 烟测（不需要 web）：

```bash
uv run python -m backend.app           # 终端 1
uv run python scripts/smoke_api.py     # 终端 2
```

但只要碰了 `web/`，就回到上面的完整 `docker compose up -d --build`。

### 12.4 推送 ACR + 发 GitHub Release

`release.sh` 强制要求 git 干净 + 已 push origin（保证镜像与 release 可复现）。
不满足直接退出。

一次性配 ACR 凭据（写到 `~/.zshrc`）：

```bash
export ACR_NAMESPACE=inkfin
export ACR_USERNAME=inkfinite
export ACR_PASSWORD=<阿里云 ACR 控制台设的固定密码>
```

发版：

```bash
./scripts/release.sh v0.1.0           # 标准发版
./scripts/release.sh                  # 自动用 v0.0.0-<git-sha>
REPLACE=1 ./scripts/release.sh v0.1.0 # 重传同版本 artifact
```

`release.sh` 顺序做：

1. 校验 git 干净 + 已 push origin
1. `git tag $VERSION && git push origin $VERSION`
1. 调 `push-acr.sh` 推镜像（同时打 `:latest`、`:<git-sha>`、`:<version>`）
1. 打包部署清单 tar：`docker-compose.yml`、`docker-compose.prod.yml`（镜像 tag
   钉死成 `:<version>`）、`.env.example`、`web/.env.example`、`scripts/backup.sh`、
   `docs/DEPLOY_HANDOFF.md`、现场生成的 `INSTALL.md`
1. `gh release create $VERSION akapen-deploy.tar.gz`，artifact 名稳定不带版本号
   → 永久稳定的 latest URL：
   `https://github.com/inkfin/akapen/releases/latest/download/akapen-deploy.tar.gz`

只想推镜像不发 release（hotfix 迭代中）：

```bash
./scripts/push-acr.sh                # 只 build + push :latest + :<sha>
```

正式发版优先走 `release.sh`，保证镜像 + 部署清单可回溯。

### 12.5 ECS 上线 / 升级

首次部署：

```bash
ssh aliyun
mkdir -p ~/akapen && cd ~/akapen
curl -fL https://github.com/inkfin/akapen/releases/latest/download/akapen-deploy.tar.gz | tar -xz
# 跟 INSTALL.md / docs/DEPLOY_HANDOFF.md 配 .env、起服
```

升级：

```bash
ssh aliyun
cd ~/akapen

# 方案 A：覆盖 prod.yml 让镜像 tag 跟新 release 走
curl -fL https://github.com/inkfin/akapen/releases/latest/download/akapen-deploy.tar.gz \
  | tar -xz docker-compose.prod.yml docs/DEPLOY_HANDOFF.md
dcp pull && dcp up -d

# 方案 B：原 prod.yml 用 :latest + pull_policy: always
dcp pull && dcp up -d

# 验活
dcp ps
curl -fsS http://127.0.0.1:8000/v1/livez
curl -fsS http://127.0.0.1:3000/api/health
dcp logs --tail=80 backend
dcp logs --tail=80 web

# Schema 改动时 web 容器会自动跑 prisma migrate deploy；确认实际跑过：
dcp logs web | rg 'migrate|migration' | tail
```

`dcp` 是 alias：`docker compose -f docker-compose.yml -f docker-compose.prod.yml`。
见 `docs/DEPLOY_HANDOFF.md`。

### 12.6 回滚

线上出故障时优先回滚再排查。

```bash
ssh aliyun
cd ~/akapen

# 方案 A：拉旧 release 的部署清单（prod.yml 已钉死那个版本的镜像）
LAST_GOOD=v0.1.2
curl -fL https://github.com/inkfin/akapen/releases/download/${LAST_GOOD}/akapen-deploy.tar.gz \
  | tar -xz docker-compose.prod.yml
dcp pull && dcp up -d

# 方案 B：手动改 prod.yml 切到指定 git short sha
sed -i "s|:[a-z0-9]\{7,\}|:abc1234|g" docker-compose.prod.yml
dcp pull && dcp up -d
```

⚠ web 服务回滚且这次 push 包含 schema migration 时，旧镜像不会反向迁移。
要么提前备份 `web/data/web.db`（见 §十三），要么停服等 hotfix。Prisma 不
推荐写 down migration。

### 12.7 反模式

- ❌ 用 `uv run` + 裸跑 `npm run dev` 替代 `docker compose` 验 e2e —— web 端
  少了 webhook secret / volume 挂载等环境，复现度低；agent 必须用 docker compose
  起完整链路再交给用户验
- ❌ ECS 上直接 vim 改文件 —— 跟 git 失联，下次拉镜像会被覆盖
- ❌ ECS 上跑 `docker compose up --build` —— 2C2G 内存不够 next build
- ❌ 跳过本地验活直接 push
- ❌ push 后忘记 ssh ECS 跑 `dcp pull && up -d`（`pull_policy: always` 只在 `up` 时拉一次）
- ❌ 改 `web/prisma/schema.prisma` 后裸跑 `npx prisma migrate dev` —— 必须走
  `./web/scripts/migrate.sh` wrapper，否则会因为 `web/.env:DATABASE_URL` 是容器
  路径而把 migration 应用到 stray DB `web/prisma/data/web.db`（详见 §12.2.5）

## 十三、宿主机持久化 + 备份恢复

容器无状态，所有持久化数据在两个 bind mount：

| 路径 | 内容 | 重要性 |
| --- | --- | --- |
| `data/grading.db` (+ -wal/-shm) | backend 任务队列 / worker 状态 | 低（重启重跑） |
| `data/uploads/` | backend 拉图后的标准化缓存 | 低（可重新拉） |
| `data/records/` | 每条任务的 prompt + LLM 原始输出 | 中（复盘用） |
| `data/logs/app.log*` | 应用日志 | 中（排障用） |
| `web/data/web.db` | 老师账号 / 班级 / 学生 / 题目 / 批改结果 | **高** |
| `web/data/uploads/` | 学生作业原图（上传源） | **高** |

挂载契约（在 `docker-compose.yml`）：

- `./data:/app/data`（backend）
- `./web/data:/app/data`（web）

容器内 uid=1000；ECS 部署用户也得是 1000，否则写不进去。

### 13.1 备份

`scripts/backup.sh`：

- 用宿主 `python3` stdlib 对 `*.db` 做在线 `.backup` 快照（避免 WAL 漏写）
- tar 打包 `data/` + `web/data/`，排除 `*-wal` / `*-shm` / 老 logs / 临时上传
- 可选 `BACKUP_OSS_BUCKET=oss://...` 自动 ossutil 上传 OSS
- 自动清理本机 N 天前的 tar（默认 3 天）

ECS 上一次性配好：

```bash
ssh aliyun

# 1) 先手跑一次确认脚本能用（cron 出错主因是 PATH / 环境变量）
cd ~/docker/akapen && ./scripts/backup.sh

# 2) 装 ossutil（异地容灾）
curl -L https://gosspublic.alicdn.com/ossutil/v2/2.0.4/ossutil-2.0.4-linux-amd64.zip -o /tmp/o.zip
unzip /tmp/o.zip -d /tmp/ && sudo mv /tmp/ossutil-*-linux-amd64/ossutil /usr/local/bin/
ossutil config -e oss-cn-shenzhen.aliyuncs.com -i <ak> -k <sk>  # RAM 子账号，仅授对应 bucket 写权限

# 3) 加 cron（每天 04:00；日志写到项目内方便 ssh 看）
crontab -e
# 末尾加：
0 4 * * * cd ~/docker/akapen && BACKUP_OSS_BUCKET=oss://my-bucket/akapen ./scripts/backup.sh >> data/logs/backup.log 2>&1
```

cron 注意：

- cron 默认 `PATH=/usr/bin:/bin`。本脚本依赖 `python3 / tar / find / ossutil`，
  前三个在默认 PATH。ossutil 装到非 `/usr/local/bin` 时在 crontab 顶部加
  `PATH=/usr/local/bin:/usr/bin:/bin`。
- cron 工作目录是 `$HOME`，不是项目根。要用 `cd ~/docker/akapen && ./scripts/backup.sh`
  或写绝对路径。
- OSS 上传失败时脚本仅警告不退出，本机 tar 仍在 `/tmp`，可手动 `ossutil cp` 补传。
- `backup.log` 是 append，长期跑会膨胀。配 logrotate：

  ```bash
  sudo tee /etc/logrotate.d/akapen-backup <<'EOF'
  /home/inkfin/docker/akapen/data/logs/backup.log {
      weekly
      rotate 4
      compress
      missingok
      notifempty
      copytruncate
  }
  EOF
  ```

systemd timer 也能跑，本规模无必要。

### 13.2 恢复

```bash
ssh aliyun
cd ~/docker/akapen
docker compose down

mkdir restore && cd restore
tar -xzf /path/to/akapen_20260501_040000.tgz

# .bak 改回正式名（备份脚本同时打包了原 .db 和 .bak 快照，用 .bak 是一致快照）
mv data/grading.db.bak data/grading.db
mv web/data/web.db.bak web/data/web.db
rm -f data/*.db-wal data/*.db-shm web/data/*.db-wal web/data/*.db-shm

cd ..
rsync -av --delete restore/data/ data/
rsync -av --delete restore/web/data/ web/data/
docker compose up -d
```

⚠ `--delete` 会清掉目标里多出来的文件（如恢复点之后新传的图）。想保留就去掉
`--delete`，但混合不同 schema 的 web.db 与新数据可能不兼容；恢复前确认备份点
代码版本与当前镜像版本一致。

### 13.3 反模式

- ❌ 直接 `cp web/data/web.db backup.db`：WAL 模式会漏掉 `web.db-wal` 里没合并
  的事务。用 `sqlite3 .backup` 或 python `connection.backup()`（脚本已实现）。
- ❌ 把 `data/` 挂到 NFS / 网盘 / fuse OSS：SQLite 在 NFS 上 fcntl 锁不可靠，
  会随机 corrupt。仅本地盘 ext4/xfs。
- ❌ 容器写入时 tar 整个 `web/data/web.db`：快照不一致。先 `docker compose stop web`
  或走脚本的 `.backup` 路径。
- ❌ 备份 tar 只留在 ECS 同一块盘上：本机盘损坏时备份一并丢失。配
  `BACKUP_OSS_BUCKET` 上传 OSS。
