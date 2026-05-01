"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  DEFAULT_PROMPT_GRADING,
  DEFAULT_PROMPT_OCR,
  DEFAULT_PROMPT_SINGLE_SHOT,
} from "@/lib/model-catalog";

async function requireUserId() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  return session.user.id;
}

/**
 * 这是给 UI 直接渲染的形状：所有字段都有值（NULL prompt 自动 fallback 到空串）。
 * 跑批改任务时由 grade action 把空串再变回 undefined（让 backend 用自己默认）。
 */
export type WebSettingsView = {
  gradingProvider: string;
  gradingModel: string;
  enableSingleShot: boolean;
  gradingWithImage: boolean;
  gradingThinking: boolean;
  ocrProvider: string;
  ocrModel: string;
  ocrPrompt: string;
  gradingPrompt: string;
  singleShotPrompt: string;
};

const updateSchema = z.object({
  gradingProvider: z.string().trim().min(1).max(64),
  gradingModel: z.string().trim().min(1).max(128),
  enableSingleShot: z.boolean(),
  gradingWithImage: z.boolean(),
  gradingThinking: z.boolean(),
  ocrProvider: z.string().trim().min(1).max(64),
  ocrModel: z.string().trim().min(1).max(128),
  // prompt 留空 = 用 backend 默认；直接存 NULL
  ocrPrompt: z.string().max(16000).optional().default(""),
  gradingPrompt: z.string().max(16000).optional().default(""),
  singleShotPrompt: z.string().max(16000).optional().default(""),
});

export type UpdateWebSettingsInput = z.infer<typeof updateSchema>;

// 用户从未配置过时给的默认值。
//
// 关键：prompt 字段**预填**了 schema-correct 的中文作文模板（见 model-catalog.ts），
// 而不是空串 —— 因为 backend `prompts/single_shot.md` 里的「扣分项 max=0」与
// `core/schemas.py:DimensionScore.max>0` 互相矛盾，prompt 直接落到 backend 默认会
// 触发校验失败。预填模板让老师开箱可用；想改的话进设置页编辑就行。
//
// 用户清空某栏 + 保存 = 存 NULL → 跑批改时 backend 退回 prompts/*.md 默认。
const FALLBACK: WebSettingsView = {
  gradingProvider: "qwen",
  gradingModel: "qwen3-vl-plus",
  enableSingleShot: true,
  gradingWithImage: true,
  gradingThinking: false,
  ocrProvider: "qwen",
  ocrModel: "qwen3-vl-plus",
  ocrPrompt: DEFAULT_PROMPT_OCR,
  gradingPrompt: DEFAULT_PROMPT_GRADING,
  singleShotPrompt: DEFAULT_PROMPT_SINGLE_SHOT,
};

export async function getWebSettings(): Promise<WebSettingsView> {
  const userId = await requireUserId();
  const row = await prisma.webSettings.findUnique({ where: { userId } });
  if (!row) return FALLBACK;
  return {
    gradingProvider: row.gradingProvider,
    gradingModel: row.gradingModel,
    enableSingleShot: row.enableSingleShot,
    gradingWithImage: row.gradingWithImage,
    gradingThinking: row.gradingThinking,
    ocrProvider: row.ocrProvider,
    ocrModel: row.ocrModel,
    ocrPrompt: row.ocrPrompt ?? "",
    gradingPrompt: row.gradingPrompt ?? "",
    singleShotPrompt: row.singleShotPrompt ?? "",
  };
}

export async function updateWebSettingsAction(
  input: UpdateWebSettingsInput,
): Promise<{ ok: boolean; error?: string }> {
  const userId = await requireUserId();
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    };
  }
  const data = parsed.data;
  const empty = (s: string) => (s.trim().length === 0 ? null : s);
  await prisma.webSettings.upsert({
    where: { userId },
    update: {
      gradingProvider: data.gradingProvider,
      gradingModel: data.gradingModel,
      enableSingleShot: data.enableSingleShot,
      gradingWithImage: data.gradingWithImage,
      gradingThinking: data.gradingThinking,
      ocrProvider: data.ocrProvider,
      ocrModel: data.ocrModel,
      ocrPrompt: empty(data.ocrPrompt),
      gradingPrompt: empty(data.gradingPrompt),
      singleShotPrompt: empty(data.singleShotPrompt),
    },
    create: {
      userId,
      gradingProvider: data.gradingProvider,
      gradingModel: data.gradingModel,
      enableSingleShot: data.enableSingleShot,
      gradingWithImage: data.gradingWithImage,
      gradingThinking: data.gradingThinking,
      ocrProvider: data.ocrProvider,
      ocrModel: data.ocrModel,
      ocrPrompt: empty(data.ocrPrompt),
      gradingPrompt: empty(data.gradingPrompt),
      singleShotPrompt: empty(data.singleShotPrompt),
    },
  });
  revalidatePath("/settings");
  return { ok: true };
}

/**
 * 测试 akapen 连通性。直接打 backend 的 /v1/livez（无鉴权）+ 创建一个一定 422 的
 * 任务（带鉴权 + 故意错的 image_urls），通过响应类型反推：
 *
 * - livez 200 → backend 进程在
 * - tasks 422 with `image_urls` 字眼 → API key 鉴权通过、schema 路径通
 * - tasks 401 → API key 错
 * - 任意网络异常 → 拨不通
 */
export async function testAkapenConnectionAction(): Promise<{
  ok: boolean;
  livez: "ok" | "fail";
  auth: "ok" | "bad_key" | "unknown";
  detail?: string;
}> {
  await requireUserId();
  const base = (process.env.AKAPEN_BASE_URL ?? "http://backend:8000").replace(
    /\/+$/,
    "",
  );
  const apiKey = process.env.AKAPEN_API_KEY ?? "";

  let livez: "ok" | "fail" = "fail";
  try {
    const r = await fetch(`${base}/v1/livez`, {
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
    });
    livez = r.ok ? "ok" : "fail";
  } catch (e) {
    return {
      ok: false,
      livez: "fail",
      auth: "unknown",
      detail: e instanceof Error ? e.message : "connect error",
    };
  }

  // 用一个永远 422 的请求探鉴权：传 image_urls 但 student_id 缺
  let auth: "ok" | "bad_key" | "unknown" = "unknown";
  try {
    const r = await fetch(`${base}/v1/grading-tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(3000),
    });
    if (r.status === 401) auth = "bad_key";
    else if (r.status === 422) auth = "ok"; // 通过鉴权进了 schema 校验
    else auth = "unknown";
  } catch (e) {
    return {
      ok: false,
      livez,
      auth: "unknown",
      detail: e instanceof Error ? e.message : "auth probe error",
    };
  }

  return { ok: livez === "ok" && auth === "ok", livez, auth };
}
