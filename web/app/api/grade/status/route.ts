import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { loadGradeBoard } from "@/lib/grade-data";

// 给批改大盘的轮询：3s 一发，前端 react-query 用。
// 不做差量推送（SSE / websocket），原因：
//   1. SQLite 反正一次拉全部 student×question 才几 KB，省事
//   2. 同机 compose 部署下完全不占公网带宽
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const url = new URL(req.url);
  const batchId = url.searchParams.get("batchId");
  if (!batchId) {
    return NextResponse.json({ error: "缺少 batchId" }, { status: 400 });
  }
  const data = await loadGradeBoard(batchId, session.user.id);
  if (!data) {
    return NextResponse.json({ error: "作业不存在" }, { status: 404 });
  }
  return NextResponse.json(data, {
    headers: { "Cache-Control": "no-store" },
  });
}
