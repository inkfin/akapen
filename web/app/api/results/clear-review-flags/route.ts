import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  batchId: z.string().min(1),
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

  const batch = await prisma.homeworkBatch.findFirst({
    where: { id: body.batchId, ownerId: session.user.id },
    select: { id: true },
  });
  if (!batch) {
    return NextResponse.json({ error: "作业不存在或无权操作" }, { status: 404 });
  }

  const flagged = await prisma.gradingTask.findMany({
    where: {
      reviewFlag: true,
      submission: { question: { batchId: body.batchId } },
    },
    select: { id: true },
  });

  if (flagged.length === 0) {
    return NextResponse.json({ ok: true, cleared: 0 });
  }

  const updated = await prisma.gradingTask.updateMany({
    where: { id: { in: flagged.map((x) => x.id) } },
    data: { reviewFlag: false },
  });

  return NextResponse.json({ ok: true, cleared: updated.count });
}

