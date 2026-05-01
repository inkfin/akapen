import fs from "node:fs";
import path from "node:path";

import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { UPLOAD_ROOT, mimeFromFilename } from "@/lib/uploads";

// 给登录的老师本人浏览自己的上传图片用。
// 与 /u/[token]（给 akapen 拉图）区别：
//   - 鉴权方式：session  vs  HMAC token
//   - 只能 owner 自己看  vs  任何持有 token 的人
//   - 路径来源：query string p=batch/student/q/file  vs  token decode
export const runtime = "nodejs";

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const url = new URL(req.url);
  const rel = url.searchParams.get("p");
  if (!rel || rel.includes("..") || rel.startsWith("/")) {
    return NextResponse.json({ error: "非法路径" }, { status: 400 });
  }

  // 路径形如 batchId/studentId/questionId/file。
  // 通过 batchId 验证 ownership：只有该批次的 owner 才允许预览。
  const segments = rel.split("/");
  if (segments.length !== 4) {
    return NextResponse.json({ error: "非法路径" }, { status: 400 });
  }
  const [batchId] = segments;
  const batch = await prisma.homeworkBatch.findFirst({
    where: { id: batchId, ownerId: session.user.id },
    select: { id: true },
  });
  if (!batch) {
    return NextResponse.json({ error: "无权访问" }, { status: 404 });
  }

  const full = path.resolve(UPLOAD_ROOT, rel);
  // 终极防御：resolve 出来的路径必须仍然在 UPLOAD_ROOT 下
  const root = path.resolve(UPLOAD_ROOT);
  if (!full.startsWith(root + path.sep)) {
    return NextResponse.json({ error: "非法路径" }, { status: 400 });
  }
  if (!fs.existsSync(full)) {
    return NextResponse.json({ error: "图片不存在" }, { status: 404 });
  }
  const buf = await fs.promises.readFile(full);
  return new NextResponse(buf, {
    headers: {
      "Content-Type": mimeFromFilename(rel),
      "Cache-Control": "private, max-age=300",
    },
  });
}
