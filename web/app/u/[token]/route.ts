import fs from "node:fs";
import path from "node:path";

import { NextResponse } from "next/server";

import { verifyImageToken } from "@/lib/hmac";
import { UPLOAD_ROOT, mimeFromFilename } from "@/lib/uploads";

/**
 * 给 akapen 容器（或任何持有有效 HMAC token 的 fetch 客户端）拉学生作业图片。
 *
 * 安全模型：
 *   - 不需要 session（akapen 容器没法登录我们 web）
 *   - 鉴权 = HMAC token，包含 path + expiry，无法篡改也无法越权
 *   - middleware.ts 已把 /u/* 排除在登录守卫之外
 *   - SSRF 防御：解出来的 path 必须在 UPLOAD_ROOT 之内（path traversal 防御）
 *
 * URL 形态约定 /u/<token>.jpg —— 末尾 .jpg/.png/.webp 装饰可选，会被剥掉再校验。
 * 选这个形态因为部分 LLM SDK 在 URL 末尾必须看到图片扩展才认。
 */
export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  let { token } = await params;

  // 把可选的装饰扩展剥掉
  const dot = token.lastIndexOf(".");
  if (dot > 0) {
    const tail = token.slice(dot + 1).toLowerCase();
    if (tail === "jpg" || tail === "jpeg" || tail === "png" || tail === "webp") {
      token = token.slice(0, dot);
    }
  }

  const payload = verifyImageToken(token);
  if (!payload) {
    return new NextResponse("forbidden", { status: 403 });
  }

  const root = path.resolve(UPLOAD_ROOT);
  const full = path.resolve(root, payload.p);
  // 终极防御：resolve 后必须仍在 UPLOAD_ROOT 之下
  if (full !== root && !full.startsWith(root + path.sep)) {
    return new NextResponse("forbidden", { status: 403 });
  }
  if (!fs.existsSync(full)) {
    return new NextResponse("not found", { status: 404 });
  }

  const buf = await fs.promises.readFile(full);
  return new NextResponse(buf, {
    headers: {
      "Content-Type": mimeFromFilename(payload.p),
      "Content-Length": String(buf.byteLength),
      "Cache-Control": "private, max-age=600",
      // 加点防意外公网传播的 hint
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
