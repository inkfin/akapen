/**
 * akapen-backend HTTP 客户端。
 *
 * 设计契约（与 backend/schemas.py 严格对齐）：
 * - 所有请求带 X-API-Key（AKAPEN_API_KEY env）
 * - 创建任务用 JSON 路径 + image_urls（让 akapen 通过 docker 内网拉图，不占公网带宽）
 * - 幂等键由我们生成：`<submissionId>:r<revision>`，避免老师重复提交时重复扣 LLM 配额
 * - 请求超时：建任务 10s，查状态 5s（与 akapen 自身的内部超时区分）
 * - 重试只对网络/5xx 错误退避 4 次，4xx 直接抛
 *
 * 不做的事：
 * - 不在这里管 GradingTask DB 行，那是调用方（route handler）的事
 * - 不轮询任务状态：用 webhook 模式（callback_url 指回 /api/webhooks/akapen）
 *   只有在 webhook 没回（akapen 那边 callback_attempts 用尽）时才走 GET 兜底
 */

import { setTimeout as sleep } from "node:timers/promises";

import type { GradingTask } from "@prisma/client";

const BASE_URL = (process.env.AKAPEN_BASE_URL ?? "http://backend:8000").replace(
  /\/+$/,
  "",
);
const API_KEY = process.env.AKAPEN_API_KEY ?? "";

// ───── 类型定义（不 import backend，pydantic schema 的镜像） ─────

export type AkapenTaskStatus =
  | "queued"
  | "fetching_images"
  | "preprocessing"
  | "ocr_running"
  | "grading_running"
  | "succeeded"
  | "failed"
  | "cancelled";

export const AKAPEN_TERMINAL_STATUSES: ReadonlySet<AkapenTaskStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
] as const);

export type CreateTaskInput = {
  studentId: string;
  studentName: string;
  imageUrls: string[];
  idempotencyKey: string;
  callbackUrl: string;
  rubricId?: string;
  rubricVersion?: string;
  /**
   * 题目上下文，会被 akapen 拼到 prompt 顶部。
   * NOTE: backend 当前 schema 还没这个字段；akapen-backend-ext phase
   * 会加。在没合并前，传了也无害（backend pydantic extra="forbid" 会 422，
   * 所以本字段在 backend ext 合并前 *不能* 传）。akapen-backend-ext 完成后再启用。
   */
  questionContext?: string;
  /**
   * 覆盖 backend Settings 默认值。**所有字段都是 optional**，不传 = 用 backend 的默认。
   * 字段名与 backend/schemas.py:ProviderOverrides 一一对应（snake_case 转换在序列化层做）。
   *
   * web 端从 WebSettings 读出来后会把全套字段传过来，这样 backend 不再依赖
   * data/settings.json，真正成为"无状态"批改服务。
   */
  providerOverrides?: {
    provider?: string;
    model?: string;
    ocrProvider?: string;
    ocrModel?: string;
    enableSingleShot?: boolean;
    gradingWithImage?: boolean;
    gradingThinking?: boolean;
    ocrPrompt?: string;
    gradingPrompt?: string;
    singleShotPrompt?: string;
  };
};

export type CreateTaskResponse = {
  task_id: string;
  status: AkapenTaskStatus;
  idempotent: boolean;
  created_at: string;
  links: { self: string; result: string };
};

export type AkapenGradingResult = {
  // 只列我们 UI 用到的字段；其他字段透传到 GradingTask.result（JSON 字符串）。
  final_score?: number;
  max_score?: number;
  review_flag?: boolean;
  ocr_text?: string;
  dimensions?: Array<{
    name: string;
    score: number;
    max_score: number;
    comment?: string;
    deductions?: Array<{ reason: string; points: number }>;
  }>;
  overall_comment?: string;
  [k: string]: unknown;
};

export type AkapenTaskStatusResponse = {
  task_id: string;
  status: AkapenTaskStatus;
  student_id: string;
  student_name: string;
  idempotency_key: string | null;
  image_count: number;
  result?: AkapenGradingResult | null;
  error?: { code: string; message: string; attempts: number } | null;
  attempts: number;
  created_at: string;
  updated_at: string;
};

export class AkapenError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "AkapenError";
  }
  /** 4xx：客户端错误，不重试；5xx + 网络错误：重试 */
  get retryable(): boolean {
    return this.status === 0 || this.status >= 500;
  }
}

// ───── 幂等键生成 ─────

/**
 * idempotency_key 规则：`<submissionId>:r<revision>`
 *
 * - submissionId 唯一对应 (questionId, studentId)，所以同一个学生同一题同一次重试稳定
 * - revision 每次"重批"递增，让新一轮请求不会撞老的 idempotency 命中
 * - 长度上限 128（akapen schema 约束），cuid + 数字稳定 < 50 字符
 */
export function makeIdempotencyKey(
  submissionId: string,
  revision: number,
): string {
  return `${submissionId}:r${revision}`;
}

/** 给已有 GradingTask 算下一个 revision —— 同 submissionId 的 max(revision) + 1 */
export function nextRevisionFrom(rows: Pick<GradingTask, "revision">[]): number {
  if (rows.length === 0) return 1;
  return Math.max(...rows.map((r) => r.revision)) + 1;
}

// ───── HTTP 内核：带超时 + 退避 ─────

type FetchOpts = {
  method: "GET" | "POST" | "DELETE";
  body?: unknown;
  /** 单次请求超时（毫秒） */
  timeoutMs?: number;
  /** 整体重试次数（含首发） */
  maxAttempts?: number;
};

async function fetchWithRetry(
  path: string,
  opts: FetchOpts,
): Promise<Response> {
  const url = `${BASE_URL}${path}`;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 4);

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: opts.method,
        headers: {
          "X-API-Key": API_KEY,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: ac.signal,
      });
      clearTimeout(timer);

      if (res.ok) return res;

      // 4xx 不重试
      if (res.status >= 400 && res.status < 500) {
        const detail = await res.text().catch(() => "");
        throw new AkapenError(
          res.status,
          `akapen ${res.status}: ${detail.slice(0, 256)}`,
          detail,
        );
      }

      // 5xx：留到下一轮退避
      const detail = await res.text().catch(() => "");
      lastErr = new AkapenError(
        res.status,
        `akapen ${res.status}: ${detail.slice(0, 256)}`,
        detail,
      );
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof AkapenError && !e.retryable) throw e;
      // 超时 / 连不上 / 5xx
      lastErr =
        e instanceof Error && e.name === "AbortError"
          ? new AkapenError(0, `akapen timeout after ${timeoutMs}ms`)
          : (e as Error);
    }

    if (attempt < maxAttempts) {
      // 200 / 400 / 800 / 1600 ms + jitter，最多 4 次共 ~3s
      const base = 200 * Math.pow(2, attempt - 1);
      const jitter = Math.floor(Math.random() * 100);
      await sleep(base + jitter);
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new AkapenError(0, `akapen 调用失败（${maxAttempts} 次重试用尽）`);
}

// ───── public API ─────

export async function createGradingTask(
  input: CreateTaskInput,
): Promise<CreateTaskResponse> {
  const body: Record<string, unknown> = {
    idempotency_key: input.idempotencyKey,
    student_id: input.studentId,
    student_name: input.studentName,
    image_urls: input.imageUrls,
    callback_url: input.callbackUrl,
  };
  if (input.rubricId) body.rubric_id = input.rubricId;
  if (input.rubricVersion) body.rubric_version = input.rubricVersion;
  if (input.questionContext) body.question_context = input.questionContext;
  if (input.providerOverrides) {
    const po = input.providerOverrides;
    const dict: Record<string, unknown> = {};
    if (po.provider !== undefined) dict.provider = po.provider;
    if (po.model !== undefined) dict.model = po.model;
    if (po.ocrProvider !== undefined) dict.ocr_provider = po.ocrProvider;
    if (po.ocrModel !== undefined) dict.ocr_model = po.ocrModel;
    if (po.enableSingleShot !== undefined)
      dict.enable_single_shot = po.enableSingleShot;
    if (po.gradingWithImage !== undefined)
      dict.grading_with_image = po.gradingWithImage;
    if (po.gradingThinking !== undefined)
      dict.grading_thinking = po.gradingThinking;
    if (po.ocrPrompt !== undefined && po.ocrPrompt.length > 0)
      dict.ocr_prompt = po.ocrPrompt;
    if (po.gradingPrompt !== undefined && po.gradingPrompt.length > 0)
      dict.grading_prompt = po.gradingPrompt;
    if (po.singleShotPrompt !== undefined && po.singleShotPrompt.length > 0)
      dict.single_shot_prompt = po.singleShotPrompt;
    if (Object.keys(dict).length > 0) body.provider_overrides = dict;
  }

  const res = await fetchWithRetry("/v1/grading-tasks", {
    method: "POST",
    body,
    timeoutMs: 10_000,
    maxAttempts: 4,
  });
  return (await res.json()) as CreateTaskResponse;
}

export async function getTaskStatus(
  taskId: string,
): Promise<AkapenTaskStatusResponse> {
  const res = await fetchWithRetry(`/v1/grading-tasks/${taskId}`, {
    method: "GET",
    timeoutMs: 5_000,
    maxAttempts: 3,
  });
  return (await res.json()) as AkapenTaskStatusResponse;
}

export async function retryTask(
  taskId: string,
): Promise<{ status: string; task_id: string }> {
  const res = await fetchWithRetry(`/v1/grading-tasks/${taskId}/retry`, {
    method: "POST",
    timeoutMs: 5_000,
    maxAttempts: 3,
  });
  return (await res.json()) as { status: string; task_id: string };
}

export async function cancelTask(
  taskId: string,
): Promise<{ status: string; task_id: string }> {
  const res = await fetchWithRetry(`/v1/grading-tasks/${taskId}`, {
    method: "DELETE",
    timeoutMs: 5_000,
    maxAttempts: 3,
  });
  return (await res.json()) as { status: string; task_id: string };
}
