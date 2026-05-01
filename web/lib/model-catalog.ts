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

// ───── 推荐 prompt 模板（含 {rubric} 占位符） ─────
//
// 设计：全局 prompt 是个**框架**，规定 JSON schema、字段格式、思考流程。
// 真正"这题怎么打分"由 Question.rubric 提供，web 端在送给 LLM 前把
// `{rubric}` 占位符替换成 question.rubric 字面文字。
//
// 这样老师建题时只填几行评分细则（如「满分 30，地名 10 + 时间 10 + 论述 10」），
// 不必每题重写整个 prompt 框架。
//
// 跟 backend 的协作：
//   - backend `core/grader.py` 用 str.replace() 替换 {student_name}/{student_id}/
//     {transcription}/{ocr_review_block} —— 不识别 {rubric}。
//   - 所以 web 在发请求前把 {rubric} 替换掉，送到 backend 时已经 "rubric finalized"。
//   - 如果 prompt 模板里漏了 {rubric}，settings 保存时会校验报错。
//
// 关键约束（与 backend `core/schemas.py:GradingResult` 严格对齐）：
//   - dimension_scores[].max 必须 > 0
//   - SingleShotResult 顶层是 {transcription, grading: {...}}，不能 flatten
//   - deduction.points 是正数，evidence 字段写"原文片段"
//   - max_score / final_score 由 LLM 根据 rubric 自行决定，**不再硬编码 100**
//
// 占位符校验工具：用 RUBRIC_PLACEHOLDER 而不是字面字符串，避免散落在多处时漏改。

export const RUBRIC_PLACEHOLDER = "{rubric}";

export const DEFAULT_PROMPT_SINGLE_SHOT = `你是一位经验丰富的老师。请你**一次调用同时完成**：

1. **看图转写**：把学生答题图准确转写为文本（保留段落、保留原意，不要纠错）。
2. **评分批改**：按下方「本题评分细则」打分 + 给评语 + 输出严格 JSON。

【学生信息】
姓名：{student_name}
学号：{student_id}

---

# 本题评分细则（rubric）

${RUBRIC_PLACEHOLDER}

---

# 评分要求

- **满分**和**评分维度**完全按上方 rubric 来，rubric 里写"满分 30 分"就是 30，不要硬编码 100。
- 多个给分点 / 维度 → dimension_scores 逐个返回；只给总分 → 用一个 \`name="综合"\` 维度。
- final_score 必须 = 各 dimension_scores[].score 之和。
- 严重跑题 / 答非所问 → 内容相关维度大幅扣分，可酌情压低总分。

# 输出格式（**必须**严格 JSON）

只输出一个合法 JSON 对象；**不要** \`\`\`json 代码块、不要前后加说明文字、直接从 \`{\` 到 \`}\`：

\`\`\`
{
  "transcription": "<完整转写，按段落分隔，保留原意>",
  "grading": {
    "final_score": <number，与 rubric 满分一致；= dimension_scores[].score 之和>,
    "max_score": <与 rubric 一致的满分>,
    "dimension_scores": [
      {"name": "<维度名（来自 rubric）>", "score": <number>, "max": <number, **必须 > 0**>,
       "deductions": [{"rule": "<规则>", "points": <正数>, "evidence": "<原文片段>"}]}
    ],
    "feedback": "<面向学生的整体评语，150 字以内中文 markdown 可换行；扣分理由 + 改进建议>",
    "confidence": <number, 0.0-1.0；字迹清晰证据足 0.8+，潦草 / 跑题压低>,
    "review_flag": <boolean，OCR 太烂 / 跑题 / 边界分数建议 true>,
    "review_reasons": ["<low_confidence / off_topic / poor_handwriting / missing_evidence 等>"],
    "rubric_id": "<可空，留 string 或 null>",
    "rubric_version": "<可空>",
    "transcription": "<重复顶层 transcription 的值，让 grading 块自包含>",
    "notes": "<评分过程补充说明，可 null>"
  }
}
\`\`\`

# 硬约束

- 每个 dimension_scores[].max **必须 > 0**（schema 校验）
- final_score / max_score 不能为负、不能超过 rubric 写的满分
- deduction.points 是正数（扣多少分）
- 不要输出 schema 之外的字段；多余字段会被丢弃
`;

export const DEFAULT_PROMPT_OCR = `你是一个高精度的手写文字识别专家。请准确转写图片中的学生作答。

要求：
1. 严格按照原文转写，不要修改任何字词、不要纠错。
2. 保留原文的段落结构，段落之间用一个空行分隔。
3. 保留原作者的标点符号和书写风格。
4. 如果有笔迹无法辨认，用 [?] 标记。
5. 不要把试卷上印刷的题干、边距说明、页码、作文格栅编号转写进来；只要学生写的正文。
6. 不要把被划掉 / 涂抹掉的字写进来。
7. 不要输出任何解释、标题或前后缀，只输出转写正文。
`;

export const DEFAULT_PROMPT_GRADING = `请你作为一位经验丰富的老师，按照下面的「本题评分细则」批改这位学生的作答：
指出错误并修改、按要点评估、打分、给出优化指导。

【学生信息】
姓名：{student_name}
学号：{student_id}

【OCR 转写草稿（仅供参考，可能有误）】
{transcription}

---

{ocr_review_block}

---

# 本题评分细则（rubric）

${RUBRIC_PLACEHOLDER}

---

# 评分要求

- **满分**和**评分维度**完全按上方 rubric 来，不要硬编码 100。
- 多个给分点 → dimension_scores 逐个返回；只给总分 → 一个 \`name="综合"\` 维度。
- final_score = 各 dimension_scores[].score 之和。

# 输出格式（**必须**严格 JSON，不允许 Markdown / 代码块包裹 / 解释性文字）

只输出一个合法 JSON 对象；从 \`{\` 开始到 \`}\` 结束：

\`\`\`
{
  "final_score": <number；= dimension_scores[].score 之和>,
  "max_score": <与 rubric 一致的满分>,
  "dimension_scores": [
    {"name": "<维度名（来自 rubric）>", "score": <number>, "max": <number, **必须 > 0**>,
     "deductions": [{"rule": "<规则>", "points": <正数>, "evidence": "<原文片段>"}]}
  ],
  "feedback": "<面向学生的整体评语>",
  "confidence": <number, 0.0-1.0>,
  "review_flag": <boolean>,
  "review_reasons": ["<low_confidence / off_topic / poor_ocr 等>"],
  "rubric_id": "<可空>",
  "rubric_version": "<可空>",
  "transcription": "<校对后正文，没看图就留空字符串>",
  "notes": "<可空>"
}
\`\`\`

# 硬约束

- 每个 dimension_scores[].max **必须 > 0**
- final_score = 各 dimension_scores[].score 之和
- deduction.points 是正数
- 不要输出 schema 之外的字段
`;

// ───── rubric 占位符工具函数 ─────

/**
 * 把 prompt 里的 {rubric} 替换为题目评分细则。
 *
 * 设计要点：
 * - 用 split/join 而不是 String.replace(string, ...) —— 后者在 ES 里只替第一处，
 *   万一老师在 prompt 里写了多次 {rubric} 会漏。
 * - rubric 字面值不做转义：backend 用 str.replace 处理后续占位符（{student_name}
 *   等），不会被 rubric 里的花括号搞炸。
 * - 调用方应保证 prompt 包含 {rubric}（settings 保存时已校验，但兜底再加一层）。
 */
export function substituteRubric(prompt: string, rubric: string): string {
  if (!prompt.includes(RUBRIC_PLACEHOLDER)) {
    // 老 prompt 没有占位符，直接拼到末尾 —— 兜底，不让批改失败
    return `${prompt}\n\n# 本题评分细则（rubric）\n\n${rubric}\n`;
  }
  return prompt.split(RUBRIC_PLACEHOLDER).join(rubric);
}
