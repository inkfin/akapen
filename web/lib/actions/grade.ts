"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  AkapenError,
  createGradingTask,
  makeIdempotencyKey,
  retryTask as akapenRetryTask,
} from "@/lib/akapen";
import { buildSignedImageUrl } from "@/lib/hmac";

async function requireUserId() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  return session.user.id;
}

function getCallbackUrl(): string {
  // 给 akapen 的回调地址。同机部署 = http://web:3000；
  // 跨机部署 = 必须能让 backend 容器解析的公网域名。
  const base = (process.env.WEB_PUBLIC_BASE_URL ?? "http://web:3000").replace(
    /\/+$/,
    "",
  );
  return `${base}/api/webhooks/akapen`;
}

function safeArr(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * 给一组 (submissionId) 提交批改。
 *
 * 行为：
 *   - 对每个 submission 生成新一行 GradingTask（revision = 上一条 + 1，没有就 1）
 *   - 为每张图签 30 分钟有效期的 image URL
 *   - 拼 question_context（题干 + 评分要点） → akapen
 *   - 成功收到 akapen 返回的 task_id 后落库 status="queued"
 *   - 失败则落 status="failed"、errorCode/Message，让 UI 显示出来用户能立刻重试
 */
export async function gradeSubmissionsAction(
  submissionIds: string[],
  options?: { questionContextOverride?: string },
): Promise<{ ok: number; failed: number; errors: string[] }> {
  const userId = await requireUserId();
  const result = { ok: 0, failed: 0, errors: [] as string[] };

  // 一次性把 submission + 关联实体取出来，避免 N+1
  const submissions = await prisma.submission.findMany({
    where: {
      id: { in: submissionIds },
      // 通过 question→batch.ownerId 验证 ownership
      question: { batch: { ownerId: userId } },
    },
    include: {
      student: true,
      question: { include: { batch: true } },
      gradings: { select: { revision: true } },
    },
  });

  for (const sub of submissions) {
    const paths = safeArr(sub.imagePaths);
    if (paths.length === 0) {
      result.failed++;
      result.errors.push(`${sub.student.name} 第${sub.question.index}题 没有图片`);
      continue;
    }

    const revision =
      sub.gradings.length === 0
        ? 1
        : Math.max(...sub.gradings.map((g) => g.revision)) + 1;
    const idempotencyKey = makeIdempotencyKey(sub.id, revision);

    // 先在我方 DB 记一行 pending 任务，让 UI 立刻能反馈
    const local = await prisma.gradingTask.create({
      data: {
        submissionId: sub.id,
        idempotencyKey,
        revision,
        status: "pending",
        attempts: 1,
      },
    });

    try {
      const imageUrls = paths.map((p) => buildSignedImageUrl(p, 1800));

      // 拼 question_context：题干 + 评分要点
      const ctx = sub.question.rubric
        ? `${sub.question.prompt}\n\n参考答案/评分要点：\n${sub.question.rubric}`
        : sub.question.prompt;

      const akapenRes = await createGradingTask({
        studentId: sub.student.externalId,
        studentName: sub.student.name,
        imageUrls,
        idempotencyKey,
        callbackUrl: getCallbackUrl(),
        rubricId: sub.question.id,
        questionContext: options?.questionContextOverride ?? ctx,
      });

      await prisma.gradingTask.update({
        where: { id: local.id },
        data: {
          akapenTaskId: akapenRes.task_id,
          status: "queued",
        },
      });
      result.ok++;
    } catch (e) {
      const msg =
        e instanceof AkapenError
          ? e.message
          : e instanceof Error
            ? e.message
            : "unknown";
      const code =
        e instanceof AkapenError ? `HTTP_${e.status}` : "NETWORK_ERROR";
      await prisma.gradingTask.update({
        where: { id: local.id },
        data: {
          status: "failed",
          errorCode: code,
          errorMessage: msg.slice(0, 500),
        },
      });
      result.failed++;
      result.errors.push(`${sub.student.name} 第${sub.question.index}题 → ${msg.slice(0, 100)}`);
    }
  }

  // 撞进哪个 batch 重新渲染：从第一个 submission 反查
  if (submissions.length > 0) {
    const batchId = submissions[0].question.batchId;
    revalidatePath(`/grade/${batchId}`);
  }
  return result;
}

/**
 * 对已有的 GradingTask 走 akapen 自家的 retry（不重新生成 idempotency_key）。
 *
 * 用途：akapen 那边因瞬时错误失败时，不增加 web 这边的 revision，
 * 也不增加 LLM 调用次数（akapen 内部 _refresh_task_context 会复用）。
 *
 * 注意：要求 GradingTask.akapenTaskId 不为 null（即上次是真的提交到 akapen 了）。
 */
export async function retryGradingTaskAction(
  gradingTaskId: string,
): Promise<{ ok: boolean; error?: string }> {
  await requireUserId();
  const t = await prisma.gradingTask.findUnique({
    where: { id: gradingTaskId },
    include: {
      submission: {
        include: { question: { include: { batch: true } } },
      },
    },
  });
  if (!t || t.submission.question.batch.ownerId !== (await auth())?.user?.id) {
    return { ok: false, error: "任务不存在或无权操作" };
  }
  if (!t.akapenTaskId) {
    return { ok: false, error: "上一次没成功提交到中台，请用「重批」重新开始" };
  }
  try {
    await akapenRetryTask(t.akapenTaskId);
    await prisma.gradingTask.update({
      where: { id: gradingTaskId },
      data: { status: "queued", attempts: { increment: 1 } },
    });
    revalidatePath(`/grade/${t.submission.question.batchId}`);
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    return { ok: false, error: msg };
  }
}
