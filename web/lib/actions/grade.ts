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
  type CreateTaskInput as AkapenCreateTaskInput,
} from "@/lib/akapen";
import { buildSignedImageUrl } from "@/lib/hmac";
import { getWebSettings, type WebSettingsView } from "@/lib/actions/settings";
import { substituteRubric } from "@/lib/model-catalog";

/**
 * 把用户的 WebSettings + 单道题目的 rubric / feedbackGuide / customPrompt
 * 拼成 ProviderOverrides。
 *
 * 三层 prompt 决策（优先级从高到低）：
 *   1. question.customSingleShotPrompt / customGradingPrompt → 整段覆盖，
 *      不再注入 rubric / feedbackGuide
 *   2. WebSettings.singleShotPrompt / gradingPrompt （含 {rubric} 占位符）→
 *      用 question.rubric + feedbackGuide 替换占位符；rubric 为空时切到
 *      "只批注 / 不打分"指令；feedbackGuide 为空时用通用默认指南
 *   3. 都为空 → 不传 prompt 字段，backend 用自己 backend/prompts/*.md 默认
 *      （不推荐：backend 默认 prompt 没有 rubric 概念，所有题目按一刀切的
 *      100 分作文打分）
 *
 * 「前端配置 / 后端只服务」边界：backend 不读 data/settings.json，所有
 * 决策都在 web 这边敲定，传 finalize 的 prompt 过去即可。
 */
function buildProviderOverridesForQuestion(
  s: WebSettingsView,
  batch: {
    subject: string | null;
    batchObjective: string | null;
  },
  question: {
    requireGrading: boolean;
    rubric: string | null;
    feedbackGuide: string | null;
    customGradingPrompt: string | null;
    customSingleShotPrompt: string | null;
    thinkingOverride: string | null;
    provideModelAnswer: boolean;
    modelAnswerGuide: string | null;
  },
): AkapenCreateTaskInput["providerOverrides"] {
  // 三层回落决定 effective feedback guide：
  // 题目级 > 老师全局（settings.defaultFeedbackGuide） > model-catalog 硬编码
  // （substituteRubric 内部把 null/空 串切到硬编码 DEFAULT_FEEDBACK_GUIDE）
  const effectiveFeedbackGuide =
    (question.feedbackGuide && question.feedbackGuide.trim()) ||
    (s.defaultFeedbackGuide && s.defaultFeedbackGuide.trim()) ||
    null;

  const subOpts = {
    persona: s.defaultPersona,
    batchSubject: batch.subject,
    batchObjective: batch.batchObjective,
    requireGrading: question.requireGrading,
    rubric: question.rubric,
    feedbackGuide: effectiveFeedbackGuide,
    provideModelAnswer: question.provideModelAnswer,
    modelAnswerGuide: question.modelAnswerGuide,
  };

  // single-shot prompt：custom > settings.singleShotPrompt 替换 rubric > 不传
  const singleShotPrompt = question.customSingleShotPrompt
    ? question.customSingleShotPrompt
    : s.singleShotPrompt
      ? substituteRubric(s.singleShotPrompt, subOpts)
      : undefined;

  // grading prompt：custom > settings.gradingPrompt 替换 rubric > 不传
  const gradingPrompt = question.customGradingPrompt
    ? question.customGradingPrompt
    : s.gradingPrompt
      ? substituteRubric(s.gradingPrompt, subOpts)
      : undefined;

  const thinkingOverride = (question.thinkingOverride ?? "").toLowerCase().trim();
  const gradingThinking =
    thinkingOverride === "force_on"
      ? true
      : thinkingOverride === "force_off"
        ? false
        : s.gradingThinking;

  return {
    provider: s.gradingProvider,
    model: s.gradingModel,
    ocrProvider: s.ocrProvider,
    ocrModel: s.ocrModel,
    enableSingleShot: s.enableSingleShot,
    gradingWithImage: s.gradingWithImage,
    gradingThinking,
    ocrPrompt: s.ocrPrompt || undefined,
    gradingPrompt,
    singleShotPrompt,
  };
}

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
  options?: {
    questionContextOverride?: string;
    mode?: "grade" | "revise";
    actionType?: "grade" | "followup" | "model_answer_regen";
    teacherInstruction?: string;
  },
): Promise<{ ok: number; failed: number; errors: string[] }> {
  const userId = await requireUserId();
  const result = { ok: 0, failed: 0, errors: [] as string[] };

  // 老师全局设置（model / prompts 模板 / 行为开关），所有题共用
  const settings = await getWebSettings();

  const mode = options?.mode ?? "grade";
  const actionType = options?.actionType ?? "grade";
  const teacherInstruction = (options?.teacherInstruction ?? "").trim();

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
        mode,
        actionType,
        teacherInstruction: teacherInstruction || null,
        status: "pending",
        attempts: 1,
      },
    });

    try {
      const imageUrls = paths.map((p) => buildSignedImageUrl(p, 1800));

      // 每题独立的 prompt overrides（注入 rubric 或走 customPrompt 覆盖）
      const providerOverrides = buildProviderOverridesForQuestion(
        settings,
        sub.question.batch,
        sub.question,
      );

      // 拼 question_context：题干（+ 给分细则 / 修改意见指引，如果填了）
      // 注意：rubric / feedbackGuide 已经塞进 prompt 模板了，question_context 这里
      // 再带一份是给 backend 在 prompt 顶部额外提示用的，让模型对题目背景多一份认知。
      // requireGrading=false 时不重复带"给分细则"段，避免 prompt 自相矛盾；
      // feedbackGuide 留空时也省略，让模型自己用默认 feedback 方向。
      const ctxParts: string[] = [sub.question.prompt];
      if (sub.question.requireGrading && sub.question.rubric && sub.question.rubric.trim()) {
        ctxParts.push(`本题给分细则：\n${sub.question.rubric.trim()}`);
      }
      if (sub.question.feedbackGuide && sub.question.feedbackGuide.trim()) {
        ctxParts.push(`修改意见方向：\n${sub.question.feedbackGuide.trim()}`);
      }
      if (teacherInstruction) {
        ctxParts.push(`老师追问/补充要求：\n${teacherInstruction}`);
      }
      const ctx = ctxParts.join("\n\n");

      const akapenRes = await createGradingTask({
        studentId: sub.student.externalId,
        studentName: sub.student.name,
        imageUrls,
        idempotencyKey,
        callbackUrl: getCallbackUrl(),
        rubricId: sub.question.id,
        questionContext: options?.questionContextOverride ?? ctx,
        providerOverrides,
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
