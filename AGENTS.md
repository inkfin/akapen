# AGENTS.md

> 给后续维护这个仓库的人（不管是真人还是 LLM agent）看的架构指南。
> 用户可见的功能 / 启动方式见 `README.md`，本文件只讲**怎么改代码**。

## 一、核心理念

业务逻辑（OCR / 批改）和 LLM provider（Qwen / Gemini / Claude / …）解耦。

```text
┌──────────┐     ┌────────────────┐     ┌──────────────────────┐
│  app.py  │────▶│ core/ocr.py    │────▶│ core/providers/      │
│ (Gradio) │     │ core/grader.py │     │   QwenProvider       │
└──────────┘     │ (业务流程)      │     │   GeminiProvider     │
                 └────────────────┘     │   ClaudeProvider     │
                                        │  ──────────────────  │
                                        │  统一 chat() 接口     │
                                        └──────────────────────┘
```

- `app.py` 只关心 UI + 任务编排，调用 `make_provider(name, settings)` 拿到一个
  Provider，然后传给 `transcribe()` / `grade()`。
- `core/ocr.py` / `core/grader.py` 完全不知道 provider 是哪家，只调用 `Provider.chat()`。
- `core/providers/` 是 LLM API 适配层，每家 provider 一个文件，互不依赖。

## 二、文件地图（按依赖方向）

| 文件 | 职责 | 关键导出 |
| --- | --- | --- |
| `core/imageproc.py` | 图片预处理：EXIF 旋正 + RGB + 1600px 长边 + JPEG q85 | `standardize_jpeg(path) -> bytes` |
| `core/providers/base.py` | Provider 抽象基类 | `Provider`（ABC）、`ProviderError` |
| `core/providers/qwen.py` | Qwen / 阿里云百炼（OpenAI 兼容协议） | `QwenProvider` |
| `core/providers/gemini.py` | Google Gemini（google-genai SDK） | `GeminiProvider` |
| `core/providers/claude.py` | Anthropic Claude | `ClaudeProvider` |
| `core/providers/__init__.py` | provider 注册表 + 工厂 | `make_provider(name, settings)`、`registered_providers()` |
| `core/config.py` | Settings dataclass + 模型 catalog | `Settings`、`OCR_MODEL_CATALOG`、`GRADING_MODEL_CATALOG`、`models_for()` |
| `core/ocr.py` | OCR 业务逻辑（多页合并 + thinking=False） | `transcribe(...) -> str`、`OCRError` |
| `core/grader.py` | 批改业务（vision/text 模式自动切换） | `grade(...) -> str`、`GradingError`、`VISION_REVIEW_BLOCK`、`TEXT_REVIEW_BLOCK` |
| `core/filenames.py` | `学号_姓名/页码.jpg` 文件夹扫描 | `scan_folder()` |
| `core/storage.py` | 每个学生一个 JSON 记录 | `StudentRecord`、`extract_score()`、`make_key()` |
| `core/logger.py` | 控制台 + `data/logs/app.log` rotating handler | `setup_logging()`、`tail_log()`、`clear_log()` |
| `app.py` | Gradio UI、批量并发调度、单条重跑 | （顶层脚本） |
| `prompts/ocr.md` / `prompts/grading.md` | 默认 prompt；`grading.md` 含 `{ocr_review_block}` 占位符 | （文本资源） |

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

5. **加 UI 输入** —— `app.py` 设置 Tab：加一个 `openai_key = gr.Textbox(...)`，
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

- 调用点（`app.py`）只需要 `make_provider` 一次，并发 worker 闭包里复用，
  避免每条记录重新查 registry。
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

`prompts/grading.md` 用 `{ocr_review_block}` 占位符；vision/text 由 `core/grader.py`
按当前模式填充。但现网用户 `data/settings.json` 里很可能存着没有占位符的旧
prompt，所以保留了一段 `_LEGACY_VISION_BLOCK` regex，自动把老的 "重要：OCR 校对说明"
段升级成动态 block，避免要求用户手动重置 prompt。

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
PYTHONPATH=. python - <<'PY'
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
- ❌ 让 provider 在 `chat()` 里自作主张改 `image_paths` —— 调用方有更完整的上下文。
- ❌ 把 API key 传进业务函数 —— 应该走 `Settings → from_settings → Provider`。
- ❌ 在 prompt 里硬编码 "请看图…" —— 用 `{ocr_review_block}` 占位符，让 `grader` 切换。
- ❌ 把 `core/providers/__init__.py` 弄成"业务路由"——它只是注册表，不应该出现
  `if name == "qwen": ...` 这种业务分支。
