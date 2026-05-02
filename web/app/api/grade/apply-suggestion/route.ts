import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { parseSuggestion } from "@/lib/prompt-suggestion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  gradingTaskId: z.string().min(1),
});

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
  const latestTask = await prisma.gradingTask.findFirst({
    where: { submissionId: task.submissionId },
    orderBy: { revision: "desc" },
    select: { id: true },
  });
  if (latestTask && latestTask.id !== task.id) {
    return NextResponse.json(
      { error: "当前建议不是最新版本，请刷新后在最新记录上应用" },
      { status: 409 },
    );
  }
  const suggestion = parseSuggestion(task.promptSuggestion);
  if (!suggestion) {
    return NextResponse.json({ error: "当前任务没有可应用的优化建议" }, { status: 400 });
  }
  if (!suggestion.suggestedRubric && !suggestion.suggestedFeedbackGuide) {
    return NextResponse.json({ error: "建议中没有可写入的字段" }, { status: 400 });
  }

  await prisma.$transaction([
    prisma.question.update({
      where: { id: task.submission.questionId },
      data: {
        ...(suggestion.suggestedRubric !== null
          ? { rubric: suggestion.suggestedRubric }
          : {}),
        ...(suggestion.suggestedFeedbackGuide !== null
          ? { feedbackGuide: suggestion.suggestedFeedbackGuide }
          : {}),
      },
    }),
    prisma.gradingTask.update({
      where: { id: task.id },
      data: { promptSuggestion: null },
    }),
  ]);

  revalidatePath(`/batches/${task.submission.question.batchId}`);
  revalidatePath(`/grade/${task.submission.question.batchId}`);

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

