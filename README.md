# 日语作文批改 Demo

本地批量 OCR + AI 批改流水线，前端用 Gradio。

## 流程

1. 按下面的「输入格式」整理好作文图片目录。
2. 启动应用，在「设置」Tab 填好 **DashScope（推荐）** 或 Gemini / Anthropic Key。
3. 「任务」Tab 填路径 → 扫描 → 批量 OCR → 批量批改（也可一键全跑）。
4. 「修改」Tab 逐个学生复核、编辑、重跑。
5. 「结果」Tab 导出 Markdown（每人一份或汇总）。

## 启动

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
# 编辑 .env 填入 DASHSCOPE_API_KEY（推荐）/ GEMINI_API_KEY / ANTHROPIC_API_KEY
# 也可在 UI 的「设置」Tab 填

python app.py
# 打开 http://127.0.0.1:7860
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
├── app.py                  # Gradio UI 入口
├── core/
│   ├── config.py           # Settings + UI 模型 catalog
│   ├── providers/          # LLM provider 抽象层（详见 AGENTS.md）
│   │   ├── base.py         #   Provider ABC + ProviderError
│   │   ├── qwen.py         #   QwenProvider（阿里云百炼，OpenAI 兼容协议）
│   │   ├── gemini.py       #   GeminiProvider
│   │   ├── claude.py       #   ClaudeProvider
│   │   └── __init__.py     #   make_provider(name, settings) 工厂
│   ├── ocr.py              # OCR 业务逻辑（provider-agnostic）
│   ├── grader.py           # 批改业务逻辑（vision/text 模式自动切换）
│   ├── filenames.py        # 学生文件夹扫描
│   ├── imageproc.py        # 图片标准化 + 压缩
│   ├── storage.py          # 学生 record 持久化
│   └── logger.py           # 日志（写到 data/logs/app.log）
├── prompts/
│   ├── ocr.md              # OCR 默认 prompt
│   └── grading.md          # 批改默认 prompt（含 30 分评分标准）
├── data/
│   ├── input/              # 学生作文输入目录（按上面的格式）
│   ├── records/            # 每位学生一个 record JSON
│   ├── exports/            # 导出的 Markdown
│   └── logs/               # 持久化运行日志
├── AGENTS.md               # 给 AI 改这个仓库时看的架构指南
└── requirements.txt
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
