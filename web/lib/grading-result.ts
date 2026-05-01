/**
 * 把 GradingTask.result（pydantic 序列化的 GradingResult JSON 字符串）解析成
 * web 端友好的形态。snake_case → camelCase；缺字段 / 类型异常一律给安全默认。
 *
 * 多处复用：
 * - `app/api/grade/result/route.ts`：详情抽屉单条按需拉取
 * - `lib/results-data.ts:loadStudentReport`：服务端预解析整张成绩单
 *
 * 不打分模式（requireGrading=false）下 final_score / max_score / dimension_scores
 * 可能整段 null/缺失，调用方拿到的也是 null / 空数组，渲染时各自判空。
 */
export type Deduction = {
  rule: string;
  points: number;
  evidence: string | null;
};

export type DimensionScore = {
  name: string;
  score: number;
  max: number;
  deductions: Deduction[];
};

export type ParsedGradingResult = {
  finalScore: number | null;
  maxScore: number | null;
  reviewReasons: string[];
  feedback: string;
  confidence: number | null;
  notes: string | null;
  dimensionScores: DimensionScore[];
  /**
   * grading 内部的"模型校对后的最终文本"。跟 GradingTask 顶层 transcription
   * 字段（如果有）不一定一致；以 result 内为准。
   */
  transcription: string;
};

export const EMPTY_PARSED_RESULT: ParsedGradingResult = {
  finalScore: null,
  maxScore: null,
  reviewReasons: [],
  feedback: "",
  confidence: null,
  notes: null,
  dimensionScores: [],
  transcription: "",
};

export function parseGradingResult(raw: string | null): ParsedGradingResult {
  if (!raw) return { ...EMPTY_PARSED_RESULT };
  try {
    const r = JSON.parse(raw) as Record<string, unknown>;
    return {
      finalScore: typeof r.final_score === "number" ? r.final_score : null,
      maxScore: typeof r.max_score === "number" ? r.max_score : null,
      reviewReasons: Array.isArray(r.review_reasons)
        ? (r.review_reasons as unknown[]).filter(
            (x): x is string => typeof x === "string",
          )
        : [],
      feedback: typeof r.feedback === "string" ? r.feedback : "",
      confidence: typeof r.confidence === "number" ? r.confidence : null,
      notes: typeof r.notes === "string" ? r.notes : null,
      dimensionScores: Array.isArray(r.dimension_scores)
        ? (r.dimension_scores as Record<string, unknown>[]).map((d) => ({
            name: String(d.name ?? ""),
            score: Number(d.score ?? 0),
            max: Number(d.max ?? 0),
            deductions: Array.isArray(d.deductions)
              ? (d.deductions as Record<string, unknown>[]).map((x) => ({
                  rule: String(x.rule ?? ""),
                  points: Number(x.points ?? 0),
                  evidence: typeof x.evidence === "string" ? x.evidence : null,
                }))
              : [],
          }))
        : [],
      transcription: typeof r.transcription === "string" ? r.transcription : "",
    };
  } catch {
    return { ...EMPTY_PARSED_RESULT };
  }
}
