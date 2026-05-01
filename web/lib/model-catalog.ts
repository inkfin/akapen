// 与 core/providers/__init__.py:_REGISTRY 对齐的 provider 清单。
// 这里只是 UI 的下拉提示，老师可以走「自定义模型」粘贴 catalog 里没列的快照
// （如 qwen3-vl-plus-2025-09-23）。backend 只校验 provider 是否注册过，不校验 model 名。
//
// **维护原则**：保证 qwen / gemini 两条线开箱可用，因为部署默认配置只有
// DASHSCOPE_API_KEY + GEMINI_API_KEY。Claude 路径放到「自定义」里 ——
// 用户必须自己往 backend .env 加 ANTHROPIC_API_KEY 才能跑通，不该在主下拉里
// 误导老师以为选了就能用。

export type ProviderId = "qwen" | "gemini" | "claude";

/**
 * UI 主下拉里的"模型选项"。每个选项把 provider + model 合并成一行，
 * 老师不用先选 provider 再过滤 model，对非技术用户更直观。
 *
 * `vision` 标记决定：
 *   - 主操作里给徽章「视觉」/「文本」
 *   - 选了文本模型时高级面板里 OCR 兜底自动展开提示
 *   - 影响是否走 single-shot（backend worker 自己判断，前端只是 UI 提示）
 *
 * `recommended` 仅作 UI badge，backend 不识别。
 *
 * `note` 是面向老师的简短中文说明，「为什么我会选这个」级别。
 */
export type ModelOption = {
  id: string; // 唯一 key，UI 用
  label: string; // 下拉里展示的"Qwen — qwen3-vl-plus"
  provider: ProviderId;
  model: string;
  vision: boolean;
  recommended?: boolean;
  thinking?: boolean; // 该模型本身就走思考模式（开关无意义）
  note?: string;
};

/**
 * 批改用模型清单。视觉模型排前面 + 标"推荐"，因为 single-shot 一次过的体验最好。
 * 纯文本模型排后面 ── 选了之后 backend 会自动退化为「OCR + 批改」两步，
 * 此时高级面板里的 OCR 设置才有意义。
 */
export const GRADING_MODELS: ModelOption[] = [
  {
    id: "qwen-vl-plus",
    label: "Qwen · qwen3-vl-plus",
    provider: "qwen",
    model: "qwen3-vl-plus",
    vision: true,
    recommended: true,
    note: "阿里通义视觉版，性价比最佳。看图同时打分，单次调用搞定。",
  },
  {
    id: "qwen-vl-flash",
    label: "Qwen · qwen3-vl-flash",
    provider: "qwen",
    model: "qwen3-vl-flash",
    vision: true,
    note: "Qwen 视觉版的 flash 档，更便宜、更快，但稳定性略低。",
  },
  {
    id: "gemini-3-1-pro",
    label: "Gemini · gemini-3.1-pro",
    provider: "gemini",
    model: "gemini-3.1-pro",
    vision: true,
    recommended: true,
    note: "Google Gemini 旗舰，作文质量评估非常细。需要科学上网 + GEMINI_API_KEY。",
  },
  {
    id: "gemini-2-5-pro",
    label: "Gemini · gemini-2.5-pro",
    provider: "gemini",
    model: "gemini-2.5-pro",
    vision: true,
  },
  {
    id: "gemini-2-5-flash",
    label: "Gemini · gemini-2.5-flash",
    provider: "gemini",
    model: "gemini-2.5-flash",
    vision: true,
    note: "Gemini 的 flash 档，速度快价格低，适合批量。",
  },
  // 纯文本模型 ── 选了之后 backend 自动走「OCR + 批改」两步
  {
    id: "qwen-text-plus",
    label: "Qwen · qwen3.6-plus（纯文本）",
    provider: "qwen",
    model: "qwen3.6-plus",
    vision: false,
    note: "纯文本模型，看不到图。需要先用 OCR 模型把图转文字，再批改。",
  },
  {
    id: "qwen-text-flash",
    label: "Qwen · qwen3.6-flash（纯文本）",
    provider: "qwen",
    model: "qwen3.6-flash",
    vision: false,
  },
];

/**
 * OCR 模型清单 ── 必须是视觉模型（看不到图就没法转写）。
 * UI 只在批改模型是文本模型时才让用户选这个；视觉批改下根本走不到这条路径。
 */
export const OCR_MODELS: ModelOption[] = [
  {
    id: "qwen-vl-plus-ocr",
    label: "Qwen · qwen3-vl-plus",
    provider: "qwen",
    model: "qwen3-vl-plus",
    vision: true,
    recommended: true,
  },
  {
    id: "qwen-vl-flash-ocr",
    label: "Qwen · qwen3-vl-flash",
    provider: "qwen",
    model: "qwen3-vl-flash",
    vision: true,
    note: "更便宜，作转写够用。",
  },
  {
    id: "gemini-2-5-flash-ocr",
    label: "Gemini · gemini-2.5-flash",
    provider: "gemini",
    model: "gemini-2.5-flash",
    vision: true,
  },
  {
    id: "gemini-2-5-pro-ocr",
    label: "Gemini · gemini-2.5-pro",
    provider: "gemini",
    model: "gemini-2.5-pro",
    vision: true,
  },
];

export function findGradingModel(
  provider: string,
  model: string,
): ModelOption | undefined {
  return GRADING_MODELS.find(
    (m) => m.provider === provider && m.model === model,
  );
}

export function findOcrModel(
  provider: string,
  model: string,
): ModelOption | undefined {
  return OCR_MODELS.find((m) => m.provider === provider && m.model === model);
}

/**
 * 给 UI 用：当前批改 provider+model 的能力推断。
 * 优先用 catalog，命中就用 catalog 的 vision；catalog 没列就按模型 id 关键字猜。
 */
export function isLikelyVisionModel(provider: string, model: string): boolean {
  const hit = findGradingModel(provider, model) ?? findOcrModel(provider, model);
  if (hit) return hit.vision;
  if (!model) return false;
  const m = model.toLowerCase();
  return (
    m.includes("vl") ||
    m.includes("gemini") ||
    m.includes("claude") ||
    m.includes("gpt-4o") ||
    m.includes("gpt-5")
  );
}

// ───── 推荐 prompt 模板（中文作文，100 分） ─────
//
// 设计目标：与 backend `core/schemas.py:GradingResult` 严格匹配。
// 关键约束（避开 demo `prompts/single_shot.md` 与 schema 不一致的老坑）：
//   - dimension_scores[].max 必须 > 0 —— prompt 里的所有维度都给非零 max
//   - 顶层是 {transcription, grading: {...}}，不能 flatten
//   - 所有 deduction.points 是正数，evidence 字段写"原文片段"
// backend 会通过 question_context 把题干 + 评分要点拼到 prompt 顶部，所以
// 这个模板**不**写题目，只写「按通用作文标准评分」的细则。

export const DEFAULT_PROMPT_SINGLE_SHOT = `你是一位经验丰富的中学/高中老师。请你**一次调用同时完成**：

1. **看图转写**：把学生作文图准确转写为文本（保留段落、保留学生原意，不要纠错）。
2. **评分批改**：基于校对后的文本 + 题干（题干已在本 prompt 顶部由前端传入），打分 + 给评语。

【学生信息】
姓名：{student_name}
学号：{student_id}

# 评分维度（满分 100）

| 维度 | 满分 | 关注点 |
| --- | --- | --- |
| 内容（紧扣题目 / 写作要点） | 40 | 是否回应题目要求；要点完整性；论点是否清晰 |
| 语言表达（用词、语法、句式） | 30 | 词汇丰富度；语法正确性；句式多样性 |
| 结构与连贯 | 20 | 段落组织；过渡衔接；首尾呼应 |
| 字数 / 标点 / 格式 | 10 | 是否达到字数要求；标点规范；版面整洁 |

**严重跑题**（题目要点完全未涉及）：内容维度最多给 8 分，总分一般不超过 30。

# 输出格式（**必须**严格 JSON）

只输出一个合法 JSON 对象；**不要** \`\`\`json 代码块、不要在前后加任何说明文字、直接从 \`{\` 开始到 \`}\` 结束：

\`\`\`
{
  "transcription": "<完整作文转写，按段落分隔，保留原意>",
  "grading": {
    "final_score": <number, 0-100，整数或 0.5 倍数；= dimension_scores[].score 之和>,
    "max_score": 100,
    "dimension_scores": [
      {"name": "内容（紧扣题目 / 写作要点）", "score": <0-40>, "max": 40,
       "deductions": [{"rule": "<规则>", "points": <正数>, "evidence": "<原文片段>"}]},
      {"name": "语言表达（用词、语法、句式）", "score": <0-30>, "max": 30,
       "deductions": []},
      {"name": "结构与连贯", "score": <0-20>, "max": 20,
       "deductions": []},
      {"name": "字数 / 标点 / 格式", "score": <0-10>, "max": 10,
       "deductions": []}
    ],
    "feedback": "<面向学生的整体评语，150 字以内中文 markdown 可换行；扣分理由 + 3-5 条改进建议>",
    "confidence": <number, 0.0-1.0；字迹清晰证据足 0.8+，潦草 / 跑题压低>,
    "review_flag": <boolean，OCR 太烂 / 跑题 / 边界分数建议 true>,
    "review_reasons": ["<low_confidence / off_topic / poor_handwriting / missing_evidence 等>"],
    "rubric_id": "generic-cn-essay-100",
    "rubric_version": "v1",
    "transcription": "<重复顶层 transcription 的值即可，让 grading 块自包含>",
    "notes": "<对评分过程的补充说明，可 null>"
  }
}
\`\`\`

# 关键约束

- 每个 dimension_scores[].max **必须 > 0**（schema 校验）
- final_score 不能是负数、不能超过 100
- deduction.points 是正数（扣多少分）
- 不要输出 schema 之外的字段；多余字段会被丢弃
`;

export const DEFAULT_PROMPT_OCR = `你是一个高精度的手写文字识别专家。请准确转写图片中的学生作文。

要求：
1. 严格按照原文转写，不要修改任何字词、不要纠错。
2. 保留原文的段落结构，段落之间用一个空行分隔。
3. 保留原作者的标点符号和书写风格。
4. 如果有笔迹无法辨认，用 [?] 标记。
5. 不要把试卷上印刷的题干、边距说明、页码、作文格栅编号转写进来；只要学生写的正文。
6. 不要把被划掉 / 涂抹掉的字写进来。
7. 不要输出任何解释、标题或前后缀，只输出转写正文。
`;

export const DEFAULT_PROMPT_GRADING = `请你作为一位经验丰富的中学/高中老师，按照下面的「题目要求」批改这位学生的作文：
指出错误并修改、按要点评估、打分、给出详细的优化指导。

【学生信息】
姓名：{student_name}
学号：{student_id}

【OCR 转写草稿（仅供参考，可能有误）】
{transcription}

---

{ocr_review_block}

---

# 评分维度（满分 100）

| 维度 | 满分 | 关注点 |
| --- | --- | --- |
| 内容（紧扣题目 / 写作要点） | 40 | 是否回应题目要求；要点完整性；论点是否清晰 |
| 语言表达（用词、语法、句式） | 30 | 词汇丰富度；语法正确性；句式多样性 |
| 结构与连贯 | 20 | 段落组织；过渡衔接；首尾呼应 |
| 字数 / 标点 / 格式 | 10 | 是否达到字数要求；标点规范；版面整洁 |

**严重跑题**（题目要点完全未涉及）：内容维度最多给 8 分，总分一般不超过 30。

# 输出格式（**必须**严格 JSON，不允许 Markdown / 代码块包裹 / 解释性文字）

只输出一个合法 JSON 对象；从 \`{\` 开始到 \`}\` 结束：

\`\`\`
{
  "final_score": <number, 0-100，整数或 0.5 倍数；= dimension_scores[].score 之和>,
  "max_score": 100,
  "dimension_scores": [
    {"name": "内容（紧扣题目 / 写作要点）", "score": <0-40>, "max": 40,
     "deductions": [{"rule": "<规则>", "points": <正数>, "evidence": "<原文片段>"}]},
    {"name": "语言表达（用词、语法、句式）", "score": <0-30>, "max": 30, "deductions": []},
    {"name": "结构与连贯", "score": <0-20>, "max": 20, "deductions": []},
    {"name": "字数 / 标点 / 格式", "score": <0-10>, "max": 10, "deductions": []}
  ],
  "feedback": "<面向学生的整体评语，150 字以内中文 markdown 可换行>",
  "confidence": <number, 0.0-1.0>,
  "review_flag": <boolean>,
  "review_reasons": ["<low_confidence / off_topic / poor_ocr 等>"],
  "rubric_id": "generic-cn-essay-100",
  "rubric_version": "v1",
  "transcription": "<校对后正文，没看图就留空字符串>",
  "notes": "<可空>"
}
\`\`\`

# 关键约束

- 每个 dimension_scores[].max **必须 > 0**
- final_score = 各 dimension_scores[].score 之和
- deduction.points 是正数
- 不要输出 schema 之外的字段
`;
