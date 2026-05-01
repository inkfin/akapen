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
 * 批改用模型清单。**全部都是 vision-capable**——Qwen3.5 / 3.6 主线和 Qwen3-VL
 * 都支持文本+图像+视频输入；纯文本档已经被官方下线 / 不再单独推荐。
 *
 * 排序原则：当前阿里云官方主推 Qwen3.6 系列（"qwen3-vl 已不作为首选推荐，新
 * 项目建议使用 qwen3.6 或 qwen3.5 系列"，详见
 * https://www.alibabacloud.com/help/zh/model-studio/vision-model）。
 *
 * 维护节奏：阿里云 / Google 上新或下线时，记得同步更新 `core/config.py` 的
 * `OCR_MODEL_CATALOG` / `GRADING_MODEL_CATALOG`，两边都是 UI hint，不影响后端
 * 校验（backend 只校验 provider 是否注册过，不校验 model 名）。
 */
export const GRADING_MODELS: ModelOption[] = [
  // ── Qwen 主推线：3.6 旗舰 → 3.6 flash → 3.5 / 3-vl 兼容档 ──
  {
    id: "qwen3-6-plus",
    label: "Qwen · qwen3.6-plus（推荐）",
    provider: "qwen",
    model: "qwen3.6-plus",
    vision: true,
    recommended: true,
    note: "阿里通义当前旗舰，多模态（看图+视频+文本），1M 上下文。看图同时打分，single-shot 一次搞定。",
  },
  {
    id: "qwen3-6-flash",
    label: "Qwen · qwen3.6-flash",
    provider: "qwen",
    model: "qwen3.6-flash",
    vision: true,
    note: "Qwen3.6 的 flash 档，更便宜更快；批量批改首选，质量略低于 plus。",
  },
  {
    id: "qwen3-5-plus",
    label: "Qwen · qwen3.5-plus",
    provider: "qwen",
    model: "qwen3.5-plus",
    vision: true,
    note: "上一代 Qwen3.5 旗舰，多模态稳定；3.6 不可用时的兜底。",
  },
  {
    id: "qwen3-5-flash",
    label: "Qwen · qwen3.5-flash",
    provider: "qwen",
    model: "qwen3.5-flash",
    vision: true,
    note: "Qwen3.5 flash 档，更便宜更快。",
  },
  {
    id: "qwen-vl-plus",
    label: "Qwen · qwen3-vl-plus（旧版）",
    provider: "qwen",
    model: "qwen3-vl-plus",
    vision: true,
    note: "阿里通义旧 VL 系列，官方已不再首选推荐；新项目优先选 Qwen3.6 / 3.5 系列。",
  },
  {
    id: "qwen-vl-flash",
    label: "Qwen · qwen3-vl-flash（旧版）",
    provider: "qwen",
    model: "qwen3-vl-flash",
    vision: true,
    note: "qwen3-vl-plus 的 flash 档，旧版兼容用。",
  },
  // ── Gemini ──
  {
    id: "gemini-3-1-pro-preview",
    label: "Gemini · gemini-3.1-pro-preview（推荐）",
    provider: "gemini",
    model: "gemini-3.1-pro-preview",
    vision: true,
    recommended: true,
    note: "Google Gemini 3.1 旗舰（preview 阶段），作文质量评估最细。需要科学上网 + GEMINI_API_KEY。",
  },
  {
    id: "gemini-2-5-pro",
    label: "Gemini · gemini-2.5-pro",
    provider: "gemini",
    model: "gemini-2.5-pro",
    vision: true,
    note: "Gemini 2.5 旗舰，质量稳定。3.1 preview 不可用时的备选。",
  },
  {
    id: "gemini-2-5-flash",
    label: "Gemini · gemini-2.5-flash",
    provider: "gemini",
    model: "gemini-2.5-flash",
    vision: true,
    note: "Gemini 2.5 flash 档，速度快、价格低，适合批量批改。",
  },
  {
    id: "gemini-2-5-flash-lite",
    label: "Gemini · gemini-2.5-flash-lite",
    provider: "gemini",
    model: "gemini-2.5-flash-lite",
    vision: true,
    note: "Gemini 2.5 family 最便宜最快的多模态档，适合海量轻批改。",
  },
];

/**
 * OCR 模型清单 ── 必须是视觉模型（看不到图就没法转写）。
 * 仅在批改模型是文本模型时才走得到这里；现网默认全是 vision 模型 → OCR 配置形同虚设。
 */
export const OCR_MODELS: ModelOption[] = [
  {
    id: "qwen3-6-plus-ocr",
    label: "Qwen · qwen3.6-plus（推荐）",
    provider: "qwen",
    model: "qwen3.6-plus",
    vision: true,
    recommended: true,
    note: "Qwen3.6 旗舰多模态，手写体识别能力强。",
  },
  {
    id: "qwen3-6-flash-ocr",
    label: "Qwen · qwen3.6-flash",
    provider: "qwen",
    model: "qwen3.6-flash",
    vision: true,
    note: "Qwen3.6 flash，更便宜；字迹潦草时建议换回 plus。",
  },
  {
    id: "qwen-vl-plus-ocr",
    label: "Qwen · qwen3-vl-plus（旧版）",
    provider: "qwen",
    model: "qwen3-vl-plus",
    vision: true,
    note: "旧 VL 系列，兼容用；新项目优先选 Qwen3.6。",
  },
  {
    id: "qwen-vl-flash-ocr",
    label: "Qwen · qwen3-vl-flash（旧版）",
    provider: "qwen",
    model: "qwen3-vl-flash",
    vision: true,
    note: "更便宜更快的旧版本。",
  },
  {
    id: "gemini-2-5-flash-ocr",
    label: "Gemini · gemini-2.5-flash",
    provider: "gemini",
    model: "gemini-2.5-flash",
    vision: true,
    note: "Gemini 转写档，速度快；需要海外网络。",
  },
  {
    id: "gemini-2-5-pro-ocr",
    label: "Gemini · gemini-2.5-pro",
    provider: "gemini",
    model: "gemini-2.5-pro",
    vision: true,
    note: "Gemini 旗舰转写，最稳但慢；适合特别难辨认的字迹。",
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
// 设计：全局 prompt 是个**纯框架**，只规定 LLM 角色 + JSON 输出 schema + 通用约束，
// **不出现任何题型相关字眼**（"段落"、"跑题"、"立意"、"字数"…一律不写）。
// 真正"这是什么题、怎么评"全部由 Question.rubric 提供，web 端在送给 LLM 前把
// `{rubric}` 占位符替换成 question.rubric 字面文字。
//
// 这样同一份全局模板可以兼容作文 / 续写 / 默写 / 选择 / 填空 / 计算 等所有题型；
// 老师只需要在每道题里写"本题题型 + 答案 / 给分点"即可。
//
// 跟 backend 的协作：
//   - backend `core/grader.py` 用 str.replace() 替换 {student_name}/{student_id}/
//     {transcription}/{ocr_review_block} —— 不识别 {rubric}。
//   - 所以 web 在发请求前把 {rubric} 替换掉，送到 backend 时已经 "rubric finalized"。
//   - 如果 prompt 模板里漏了 {rubric}，settings 保存时会校验报错。
//
// Prompt 模板共有 **三套独立来源**（按入口隔离，互不干扰）：
//   1. `demo/prompts/*.md` —— 模式 A · Gradio 离线 demo 的默认值；
//      用户在 Gradio "设置" Tab 改完会持久化到 `data/settings.json`。
//      **不含 `{rubric}` 占位符**，必须自包含——demo 里题目评分要求直接写在 prompt 正文。
//   2. `backend/prompts/*.md` —— 模式 B · backend worker 的 fallback；
//      只在 web 没传 `providerOverrides.{ocr,grading,single_shot}_prompt` 时才会被读到
//      （现网默认 web 总是显式传，所以这套基本不会被用到）。
//      也**不含 `{rubric}` 占位符**——backend 的 `str.replace` 不识别它。
//   3. **本文件 `DEFAULT_PROMPT_*`** —— 模式 C · web 老师端用，"重置为推荐模板"按钮
//      塞的就是这套；**含 `{rubric}` 占位符**，由 web 端按题替换后整段塞进
//      `providerOverrides`，绕过路径 1 / 2。
//
// 三套的 JSON schema / 通用要求 / 输出约束**必须同步**——它们对应同一份
// `core/schemas.py:GradingResult`。改这里时记得 cross-check
// `demo/prompts/{ocr,grading,single_shot}.md` 和
// `backend/prompts/{ocr,grading,single_shot}.md`，避免三套跑出来不一致。
// 详见 `core/config.py:Settings.load_prompts` docstring。
//
// 关键约束（与 backend `core/schemas.py:GradingResult` 严格对齐）：
//   - dimension_scores[].max 必须 > 0
//   - SingleShotResult 顶层是 {transcription, grading: {...}}，不能 flatten
//   - deduction.points 是正数，evidence 字段写"原文片段"
//   - max_score / final_score 由 LLM 根据 rubric 自行决定，**不打分模式整段省略**
//   - 占位符校验工具：用 RUBRIC_PLACEHOLDER 而不是字面字符串，避免散落多处时漏改

export const RUBRIC_PLACEHOLDER = "{rubric}";

export const DEFAULT_PROMPT_SINGLE_SHOT = `你是一位经验丰富的老师，需要在**一次调用内**完成两件事：

1. **看图转写**：把学生在答题区写的内容**忠实**转写为文本——学生写什么就是什么，**不要替学生纠错、不要补全**。看不清的字 / 笔迹用 \`[?]\` 占位。
2. **评分 / 批注**：按下方「本题评分要求」执行——可能是按 rubric 打分，也可能是只给修改建议（rubric 写明"只批注 / 不打分"时）。

【学生信息】
姓名：{student_name}
学号：{student_id}

---

# 本题评分要求

${RUBRIC_PLACEHOLDER}

---

# 通用要求（适用于所有题型）

- **转写**：忠实记录学生的答案原貌，错字 / 错答 / 涂改都按原样转写；不要把试卷上印刷的题干、页码等转写进来。
- **评分**：完全按上方"本题评分要求"执行，rubric **没列出**的扣分项 / 评分维度**不要自己加**。
- 满分 (\`max_score\`) 和评分维度完全按 rubric 来；不打分模式则省略 \`final_score\` / \`max_score\` / \`dimension_scores\`。
- \`final_score\` 必须等于各 \`dimension_scores[].score\` 之和（rubric 拆维度时）。
- 无法判断、证据不足时，把 \`confidence\` 压低、\`review_flag\` 设 true，让老师人工复核。

# 输出格式（**必须**严格 JSON）

只输出一个合法 JSON 对象；**不要** \`\`\`json 代码块、不要前后加说明文字、直接从 \`{\` 到 \`}\`：

\`\`\`
{
  "transcription": "<完整转写学生写的内容，原样保留>",
  "grading": {
    "final_score": <number；不打分模式省略此字段>,
    "max_score": <与 rubric 一致的满分；不打分模式省略此字段>,
    "dimension_scores": [
      {"name": "<维度名（来自 rubric）>", "score": <number>, "max": <number, **必须 > 0**>,
       "deductions": [{"rule": "<规则>", "points": <正数>, "evidence": "<原文片段>"}]}
    ],
    "feedback": "<面向学生的中文修改建议 / 评语，可换行 markdown>",
    "confidence": <number, 0.0-1.0>,
    "review_flag": <boolean>,
    "review_reasons": ["<low_confidence / boundary_score / poor_handwriting / missing_evidence 等>"],
    "transcription": "<重复顶层 transcription 的值，让 grading 块自包含>",
    "notes": "<评分过程补充说明，可 null>"
  }
}
\`\`\`

# 硬约束

- 每个 \`dimension_scores[].max\` **必须 > 0**（schema 校验）
- \`final_score\` / \`max_score\` 不能为负、不能超过 rubric 写的满分
- \`deduction.points\` 是正数（扣多少分）
- 不要输出 schema 之外的字段；多余字段会被丢弃
`;

export const DEFAULT_PROMPT_OCR = `你是一个高精度的手写 / 印刷文字识别专家。请准确转写图片中的**学生作答**。

要求：
1. **忠实**转写：学生写什么就是什么，**不要修改、不要纠错、不要补全**。
2. 保留原文的段落 / 行 / 题号结构，段落之间用一个空行分隔。
3. 保留学生原本的标点、空格和书写风格。
4. 如果有笔迹无法辨认，用 \`[?]\` 标记。
5. **不要**把试卷上印刷的题干、边距说明、页码、答题格栅编号转写进来；只要学生写的部分。
6. **不要**把被划掉 / 涂抹掉的字写进来。
7. 不要输出任何解释、标题或前后缀，只输出转写正文。
`;

export const DEFAULT_PROMPT_GRADING = `你是一位经验丰富的老师。基于学生答案的转写文本（OCR 草稿），按下方「本题评分要求」批改：可能是打分（rubric 描述了满分 + 评分点），也可能只给修改建议（rubric 写明"只批注 / 不打分"时）。

【学生信息】
姓名：{student_name}
学号：{student_id}

【OCR 转写草稿（仅供参考，可能有误）】
{transcription}

---

{ocr_review_block}

---

# 本题评分要求

${RUBRIC_PLACEHOLDER}

---

# 通用要求（适用于所有题型）

- 完全按上方"本题评分要求"执行，rubric **没列出**的扣分项 / 维度**不要自己加**。
- 满分 (\`max_score\`) 和评分维度完全按 rubric 来；不打分模式省略 \`final_score\` / \`max_score\` / \`dimension_scores\`。
- \`final_score\` 必须等于各 \`dimension_scores[].score\` 之和（rubric 拆维度时）。
- 证据不足时压低 \`confidence\`、把 \`review_flag\` 设 true。

# 输出格式（**必须**严格 JSON，不允许 Markdown / 代码块包裹 / 解释性文字）

只输出一个合法 JSON 对象；从 \`{\` 开始到 \`}\` 结束：

\`\`\`
{
  "final_score": <number；不打分模式省略此字段>,
  "max_score": <与 rubric 一致的满分；不打分模式省略此字段>,
  "dimension_scores": [
    {"name": "<维度名（来自 rubric）>", "score": <number>, "max": <number, **必须 > 0**>,
     "deductions": [{"rule": "<规则>", "points": <正数>, "evidence": "<原文片段>"}]}
  ],
  "feedback": "<面向学生的中文修改建议 / 评语，可换行 markdown>",
  "confidence": <number, 0.0-1.0>,
  "review_flag": <boolean>,
  "review_reasons": ["<low_confidence / boundary_score / poor_ocr 等>"],
  "transcription": "<校对后正文，没看图就留空字符串>",
  "notes": "<可空>"
}
\`\`\`

# 硬约束

- 每个 \`dimension_scores[].max\` **必须 > 0**
- \`final_score\` 必须 = 各 \`dimension_scores[].score\` 之和
- \`deduction.points\` 是正数
- 不要输出 schema 之外的字段
`;

// ───── rubric 占位符工具函数 ─────

/**
 * 当 question.rubric 为空（老师选择"只批注 / 不打分"模式）时，把模板里的
 * {rubric} 占位符替换成这段强指令，让模型：
 * - 只输出 transcription + grading.feedback（修改建议）
 * - **不要**输出 final_score / max_score / dimension_scores
 *
 * 配合 `core/schemas.py`（这几个字段已经是 `float | None = None` / 默认空列表），
 * 模型完全省略它们也能 parse 通过；UI 拿到 finalScore=null 就走"已批注"分支。
 */
const NO_GRADING_RUBRIC_BLOCK = `**本题不打分**：本题没有标准答案 / 评分细则，老师只想让你给学生**修改建议**。

请按下面方式输出 JSON：
- 必填字段：\`transcription\`（完整转写）、\`grading.feedback\`（详尽的中文修改建议，可分点列出语法 / 用词 / 结构 / 论据等问题）
- **禁止输出**：\`grading.final_score\` / \`grading.max_score\` / \`grading.dimension_scores\`（这三项整段省略，**不要**写成 0、null 或空数组）
- \`grading.confidence\` 仍按惯例自评 0~1
- \`grading.review_flag\` 一般留 false；除非作答几乎完全无法识别 / 跑题严重

feedback 是这次批改的**唯一交付物**，请写得具体、可操作，引用学生原文片段说明问题。`;

/**
 * 把 prompt 里的 {rubric} 替换为题目评分细则。
 *
 * 设计要点：
 * - 用 split/join 而不是 String.replace(string, ...) —— 后者在 ES 里只替第一处，
 *   万一老师在 prompt 里写了多次 {rubric} 会漏。
 * - rubric 字面值不做转义：backend 用 str.replace 处理后续占位符（{student_name}
 *   等），不会被 rubric 里的花括号搞炸。
 * - rubric 为空 / 全空白 → 切到 NO_GRADING_RUBRIC_BLOCK，进入"只批注"模式。
 * - 调用方应保证 prompt 包含 {rubric}（settings 保存时已校验，但兜底再加一层）。
 */
export function substituteRubric(prompt: string, rubric: string | null): string {
  const trimmed = (rubric ?? "").trim();
  const block = trimmed === "" ? NO_GRADING_RUBRIC_BLOCK : trimmed;
  if (!prompt.includes(RUBRIC_PLACEHOLDER)) {
    // 老 prompt 没有占位符，直接拼到末尾 —— 兜底，不让批改失败
    const heading = trimmed === "" ? "# 批改方式" : "# 本题评分要求";
    return `${prompt}\n\n${heading}\n\n${block}\n`;
  }
  return prompt.split(RUBRIC_PLACEHOLDER).join(block);
}

/** 给前端用：判断这道题是不是"只批注 / 不打分"模式。 */
export function isNoGradingQuestion(rubric: string | null | undefined): boolean {
  return !rubric || rubric.trim() === "";
}
