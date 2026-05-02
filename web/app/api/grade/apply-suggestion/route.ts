import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  gradingTaskId: z.string().min(1),
});

function parseSuggestion(raw: string | null): {
  reason: string | null;
  suggestedRubric: string | null;
  suggestedFeedbackGuide: string | null;
} | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const reason =
      typeof parsed.reason === "string" && parsed.reason.trim()
        ? parsed.reason.trim()
        : null;
    const suggestedRubric =
      typeof parsed.suggested_rubric === "string"
        ? parsed.suggested_rubric.trim() || null
        : typeof parsed.suggestedRubric === "string"
          ? parsed.suggestedRubric.trim() || null
          : null;
    const suggestedFeedbackGuide =
      typeof parsed.suggested_feedback_guide === "string"
        ? parsed.suggested_feedback_guide.trim() || null
        : typeof parsed.suggestedFeedbackGuide === "string"
          ? parsed.suggestedFeedbackGuide.trim() || null
          : null;
    return { reason, suggestedRubric, suggestedFeedbackGuide };
  } catch {
    const text = raw.trim();
    if (!text) return null;
    return { reason: text, suggestedRubric: null, suggestedFeedbackGuide: null };
  }
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  let body;
  try {
    body = bodySchema.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "invalid body" },
      { status: 400 },
    );
  }

  const task = await prisma.gradingTask.findUnique({
    where: { id: body.gradingTaskId },
    include: { submission: { include: { question: { include: { batch: true } } } } },
  });
  if (!task || task.submission.question.batch.ownerId !== session.user.id) {
    return NextResponse.json({ error: "任务不存在或无权操作" }, { status: 404 });
  }
  const suggestion = parseSuggestion(task.promptSuggestion);
  if (!suggestion) {
    return NextResponse.json({ error: "当前任务没有可应用的优化建议" }, { status: 400 });
  }
  if (!suggestion.suggestedRubric && !suggestion.suggestedFeedbackGuide) {
    return NextResponse.json({ error: "建议中没有可写入的字段" }, { status: 400 });
  }

  await prisma.question.update({
    where: { id: task.submission.questionId },
    data: {
      ...(suggestion.suggestedRubric !== null
        ? { rubric: suggestion.suggestedRubric }
        : {}),
      ...(suggestion.suggestedFeedbackGuide !== null
        ? { feedbackGuide: suggestion.suggestedFeedbackGuide }
        : {}),
    },
  });

  return NextResponse.json({
    ok: true,
    applied: {
      rubric: suggestion.suggestedRubric !== null,
      feedbackGuide: suggestion.suggestedFeedbackGuide !== null,
    },
    reason: suggestion.reason,
    batchId: task.submission.question.batchId,
    questionId: task.submission.questionId,
  });
}

