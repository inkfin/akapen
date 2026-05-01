// 与 core/config.py 的 OCR/GRADING_MODEL_CATALOG 同步。
// 这里只是 UI 的下拉提示，dropdown 都是 allow custom value 的，
// 老师可以粘贴 catalog 里没列的快照（如 qwen3-vl-plus-2025-09-23）。
//
// 同步原则：每次后端 catalog 变了就更新这里；不一致也不会出错（backend 会校验 provider 名）。

export const PROVIDERS = ["qwen", "gemini", "claude"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export const OCR_MODEL_CATALOG: Record<string, readonly string[]> = {
  qwen: ["qwen3-vl-plus", "qwen3-vl-flash"],
  gemini: [
    "gemini-3.1-pro",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
  ],
};

export const GRADING_MODEL_CATALOG: Record<string, readonly string[]> = {
  qwen: [
    "qwen3-vl-plus",
    "qwen3-vl-flash",
    "qwen3.6-plus",
    "qwen3.6-flash",
    "qwen3.5-plus",
    "qwen3.5-flash",
  ],
  gemini: [
    "gemini-3.1-pro",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
  ],
  claude: ["claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5"],
};

export const OCR_PROVIDERS = Object.keys(OCR_MODEL_CATALOG);
export const GRADING_PROVIDERS = Object.keys(GRADING_MODEL_CATALOG);

export function modelsFor(
  provider: string,
  kind: "ocr" | "grading",
): readonly string[] {
  const catalog = kind === "ocr" ? OCR_MODEL_CATALOG : GRADING_MODEL_CATALOG;
  return catalog[provider] ?? [];
}

// 简单的 vision 判断（与 core/providers/qwen.py is_vision_model 同步）。
// 没列出的就当 vision（保守开 single-shot）；前端只用作 UI 提示。
export function isLikelyVisionModel(model: string): boolean {
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
