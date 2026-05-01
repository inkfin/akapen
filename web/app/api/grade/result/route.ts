import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";

// 拉单条 GradingTask 的完整 result（GradingResult JSON）+ transcription 摘要。
//
// 为什么单独一条路由：批改大盘 / 详情抽屉的轮询接口（/api/grade/status）按
// AGENTS.md §11.4 的约束，**不能**把这块 JSON 灌进去 —— 几 KB 的 result 每 3s
// 回包会喷大量字节、把 react-query cache 撑大。详情抽屉打开时单独按需拉一次，
// react-query 按 gradingTaskId 缓存，不需要轮询。
//
// "只批注"模式下 result.final_score / max_score / dimension_scores 都可能为
// null / 空数组，前端要做 None-safe 渲染。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ResultPayload = {
  gradingTaskId: string;
  status: string;
  finalScore: number | null;
  maxScore: number | null;
  reviewFlag: boolean;
  reviewReasons: string[];
  feedback: string;
  confidence: number | null;
  notes: string | null;
  // 维度细分；不打分 / 老数据可能是空数组
  dimensionScores: Array<{
    name: string;
    score: number;
    max: number;
    deductions: Array<{ rule: string; points: number; evidence: string | null }>;
  }>;
  // grading result 内部的 transcription（"模型校对后的最终文本"）。
  // 跟 GradingTask.transcription（如果存在）可能不一致，这里以 result 为准。
  transcription: string;
  // 原始错误（status=failed 时）
  errorCode: string | null;
  errorMessage: string | null;
};

function parseResult(raw: string | null): Partial<ResultPayload> {
  if (!raw) return {};
  try {
    // result 是 GradingResult.model_dump_json() 的输出 —— pydantic 字段名是 snake_case
    const r = JSON.parse(raw);
    return {
      finalScore: r.final_score ?? null,
      maxScore: r.max_score ?? null,
      reviewReasons: Array.isArray(r.review_reasons) ? r.review_reasons : [],
      feedback: typeof r.feedback === "string" ? r.feedback : "",
      confidence: typeof r.confidence === "number" ? r.confidence : null,
      notes: typeof r.notes === "string" ? r.notes : null,
      dimensionScores: Array.isArray(r.dimension_scores)
        ? r.dimension_scores.map((d: Record<string, unknown>) => ({
            name: String(d.name ?? ""),
            score: Number(d.score ?? 0),
            max: Number(d.max ?? 0),
            deductions: Array.isArray(d.deductions)
              ? (d.deductions as Array<Record<string, unknown>>).map((x) => ({
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
    return {};
  }
}

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "缺少 id" }, { status: 400 });
  }

  const t = await prisma.gradingTask.findUnique({
    where: { id },
    include: {
      submission: {
        include: { question: { include: { batch: true } } },
      },
    },
  });
  if (!t || t.submission.question.batch.ownerId !== session.user.id) {
    return NextResponse.json({ error: "任务不存在或无权查看" }, { status: 404 });
  }

  const parsed = parseResult(t.result);
  const payload: ResultPayload = {
    gradingTaskId: t.id,
    status: t.status,
    finalScore: t.finalScore,
    maxScore: t.maxScore,
    reviewFlag: t.reviewFlag,
    reviewReasons: parsed.reviewReasons ?? [],
    feedback: parsed.feedback ?? "",
    confidence: parsed.confidence ?? null,
    notes: parsed.notes ?? null,
    dimensionScores: parsed.dimensionScores ?? [],
    transcription: parsed.transcription ?? "",
    errorCode: t.errorCode,
    errorMessage: t.errorMessage,
  };

  return NextResponse.json(payload, {
    headers: { "Cache-Control": "no-store" },
  });
}
