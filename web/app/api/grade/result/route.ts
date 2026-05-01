import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { parseGradingResult, type ParsedGradingResult } from "@/lib/grading-result";

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

type ResultPayload = ParsedGradingResult & {
  gradingTaskId: string;
  status: string;
  reviewFlag: boolean;
  errorCode: string | null;
  errorMessage: string | null;
};

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

  const parsed = parseGradingResult(t.result);
  const payload: ResultPayload = {
    ...parsed,
    // GradingTask 列里的 finalScore / maxScore 是 webhook 直接落的快照，
    // 与 result JSON 同源；优先用列字段（不需要再 parse JSON 拿）—— 二者只在
    // 极少数老数据 / 漂移场景才会不一致，这里以列字段为准。
    finalScore: t.finalScore,
    maxScore: t.maxScore,
    gradingTaskId: t.id,
    status: t.status,
    reviewFlag: t.reviewFlag,
    errorCode: t.errorCode,
    errorMessage: t.errorMessage,
  };

  return NextResponse.json(payload, {
    headers: { "Cache-Control": "no-store" },
  });
}
