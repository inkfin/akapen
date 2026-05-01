import { NextResponse } from "next/server";
import { z } from "zod";

import { retryGradingTaskAction } from "@/lib/actions/grade";

// POST /api/grade/retry
// body: { gradingTaskId: string }
//
// 用 akapen 的 /v1/grading-tasks/{id}/retry：复用 idempotency_key（不增加 LLM 调用计数）
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  gradingTaskId: z.string().min(1),
});

export async function POST(req: Request) {
  let body;
  try {
    body = bodySchema.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "invalid body" },
      { status: 400 },
    );
  }
  const result = await retryGradingTaskAction(body.gradingTaskId);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
