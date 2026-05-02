import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";

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

  await prisma.gradingTask.update({
    where: { id: task.id },
    data: { reviewFlag: false },
  });

  return NextResponse.json({ ok: true });
}

