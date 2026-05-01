import { NextResponse } from "next/server";
import { z } from "zod";

import { gradeSubmissionsAction } from "@/lib/actions/grade";

// POST /api/grade/submit
// body: { submissionIds: string[] }
//
// 业务逻辑全在 lib/actions/grade.ts，这里只是个 HTTP 包装：
//   - 校验 body shape
//   - 串行调用 server action
//   - 把返回 JSON 化（包含成功 / 失败 / 各条错误信息）
//
// 选用 API route 而不是直接从 client 调 server action：
//   1. 给 react-query useMutation 一个统一的 fetch 入口，错误处理路径清晰
//   2. 后续要加全局节流 / 频控时方便扩展
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  submissionIds: z.array(z.string().min(1)).min(1).max(200),
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
  const result = await gradeSubmissionsAction(body.submissionIds);
  return NextResponse.json(result);
}
