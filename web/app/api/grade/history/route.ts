import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { parseGradingResult } from "@/lib/grading-result";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const url = new URL(req.url);
  const submissionId = url.searchParams.get("submissionId");
  if (!submissionId) {
    return NextResponse.json({ error: "缺少 submissionId" }, { status: 400 });
  }

  const sub = await prisma.submission.findUnique({
    where: { id: submissionId },
    include: { question: { include: { batch: true } } },
  });
  if (!sub || sub.question.batch.ownerId !== session.user.id) {
    return NextResponse.json({ error: "记录不存在或无权查看" }, { status: 404 });
  }

  const rows = await prisma.gradingTask.findMany({
    where: { submissionId },
    orderBy: { revision: "desc" },
    select: {
      id: true,
      revision: true,
      status: true,
      mode: true,
      actionType: true,
      finalScore: true,
      maxScore: true,
      teacherInstruction: true,
      updatedAt: true,
      result: true,
    },
  });

  const items = rows.map((r) => {
    const parsed = parseGradingResult(r.result);
    return {
      gradingTaskId: r.id,
      revision: r.revision,
      status: r.status,
      mode: r.mode,
      actionType: r.actionType,
      finalScore: r.finalScore,
      maxScore: r.maxScore,
      teacherInstruction: r.teacherInstruction,
      updatedAt: r.updatedAt.toISOString(),
      hasModelAnswer: !!parsed.modelAnswer?.trim(),
    };
  });

  return NextResponse.json({ items }, { headers: { "Cache-Control": "no-store" } });
}

