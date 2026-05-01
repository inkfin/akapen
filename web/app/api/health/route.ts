import { NextResponse } from "next/server";

// Docker HEALTHCHECK + 反向代理探活共用。不查数据库（避免 cold start 时探针挂掉），
// 只确认 Node 进程能响应。要查 DB 健康度走 /api/readyz。
export async function GET() {
  return NextResponse.json({ status: "ok", ts: new Date().toISOString() });
}
