import { NextResponse } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/db";
import { verifyWebhookSignature } from "@/lib/hmac";
import { extractPromptSuggestionFromResult } from "@/lib/prompt-suggestion";

/**
 * akapen-backend → web 的回调入口。
 *
 * 完成 / 失败 / 取消 时 backend 都会 POST 这里。设计契约见 backend/webhook.py：
 *   - Header  X-Akapen-Signature: t=<unix>,v1=<hex>
 *   - Header  X-Akapen-Task-Id: <task_id>      （仅 debug，不参与签名）
 *   - Body    WebhookPayload JSON
 *
 * 失败处理：
 *   - 4xx → backend 不再重试（直接进死信，让维护者排查）
 *   - 5xx → backend 按 5s/30s/300s/3600s/21600s 退避重试 5 次后死信
 *   所以验签失败 / payload 格式错都返 400 让对方放弃（错对了也不该再骚扰）；
 *   但 DB 写入失败返 500 让对方稍后重试。
 *
 * 幂等：同一 task_id 多次到达视为重复，按"最新一次为准"覆盖（akapen 那边在
 *   delivered=true 之前会一直重试，所以重复几乎不会发生；最坏情况也只是覆盖
 *   一次相同状态，无副作用）。
 */
export const runtime = "nodejs";
// dynamic = "force-dynamic" 防止 Next.js 缓存这个 POST handler 的 module-state
export const dynamic = "force-dynamic";

// payload schema：与 backend/schemas.WebhookPayload 对齐，但用宽松校验，
// 未来 backend 给 payload 加新字段不会让我们 400。
//
// 关键：backend GradingResult 把 final_score / max_score 声明为 `float | None`，
// "不打分"模式（requireGrading=false）下走 None → pydantic 序列化成 `null` 进 JSON。
// 之前用 `z.number().optional()` 不接受 null，会让 webhook 整体 400 → backend
// 5 次退避重试后死信，UI 永远停在 pending。改用 `nullish()` 同时接受 number / null /
// undefined，并显式列出 max_score（之前靠 .passthrough() 兜着没有强校验）。
const payloadSchema = z.object({
  task_id: z.string().min(1),
  status: z.enum([
    "queued",
    "fetching_images",
    "preprocessing",
    "ocr_running",
    "grading_running",
    "succeeded",
    "failed",
    "cancelled",
  ]),
  student_id: z.string(),
  student_name: z.string(),
  result: z
    .object({
      final_score: z.number().nullish(),
      max_score: z.number().nullish(),
      review_flag: z.boolean().nullish(),
    })
    .passthrough()
    .optional()
    .nullable(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      attempts: z.number().int().nonnegative(),
    })
    .optional()
    .nullable(),
  timestamp: z.string(),
});

export async function POST(req: Request) {
  // 一定要拿原始 body 字符串，不能用 .json()——签名是对原始 bytes 算的
  const rawBody = await req.text();
  const sig = req.headers.get("x-akapen-signature");

  if (!verifyWebhookSignature(rawBody, sig)) {
    console.warn("[webhook] 签名校验失败", {
      hasSig: !!sig,
      bodyBytes: rawBody.length,
    });
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  let payload;
  try {
    payload = payloadSchema.parse(JSON.parse(rawBody));
  } catch (e) {
    console.warn("[webhook] payload 解析失败", e);
    return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  }

  // 找对应的 GradingTask（按 akapen 那边的 task_id 反查；只有命中才更新）
  const local = await prisma.gradingTask.findUnique({
    where: { akapenTaskId: payload.task_id },
  });
  if (!local) {
    // 没找到本地记录：可能是脏数据 / 我们自己刚 DROP 过——返 200 让 backend 别再重试
    console.warn(`[webhook] 未找到 GradingTask for akapen task=${payload.task_id}`);
    return NextResponse.json({ ok: true, note: "not_tracked" });
  }

  // 把 backend 返回的 status 映射到本地状态机：
  //   succeeded / failed / cancelled 是终态
  //   其余中间态（fetching_images / preprocessing / ocr_running / grading_running）
  //     在 web 这边统一记为 'running'，UI 不需要细分
  const localStatus =
    payload.status === "succeeded"
      ? "succeeded"
      : payload.status === "failed"
        ? "failed"
        : payload.status === "cancelled"
          ? "failed" // cancelled 我们当 failed 处理（用户重批一次即可）
          : "running";

  try {
    await prisma.gradingTask.update({
      where: { id: local.id },
      data: {
        status: localStatus,
        result: payload.result ? JSON.stringify(payload.result) : null,
        promptSuggestion: payload.result
          ? extractPromptSuggestionFromResult(payload.result)
          : null,
        finalScore:
          payload.result && typeof payload.result.final_score === "number"
            ? payload.result.final_score
            : null,
        maxScore:
          payload.result && typeof payload.result.max_score === "number"
            ? payload.result.max_score
            : null,
        reviewFlag:
          payload.result && payload.result.review_flag === true ? true : false,
        errorCode: payload.error?.code ?? null,
        errorMessage: payload.error?.message?.slice(0, 1000) ?? null,
        attempts: payload.error?.attempts ?? local.attempts,
      },
    });
  } catch (e) {
    console.error("[webhook] DB 写入失败，让 backend 稍后重试", e);
    return NextResponse.json({ error: "db_error" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, task_id: payload.task_id });
}

// HEAD 让某些反向代理 / health probe 不打扰
export async function HEAD() {
  return new NextResponse(null, { status: 200 });
}
