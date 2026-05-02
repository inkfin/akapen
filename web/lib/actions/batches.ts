"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { optionalText } from "@/lib/zod-helpers";

async function requireUserId() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  return session.user.id;
}

const batchCreate = z.object({
  classId: z.string().min(1),
  title: z.string().min(1).max(128),
  notes: optionalText(2000),
  batchSubject: optionalText(128),
  batchObjective: optionalText(2000),
});

export async function createBatchAction(
  _prev: { error?: string; id?: string } | undefined,
  formData: FormData,
): Promise<{ error?: string; id?: string } | undefined> {
  const userId = await requireUserId();
  const parsed = batchCreate.safeParse({
    classId: formData.get("classId"),
    title: formData.get("title"),
    notes: formData.get("notes"),
    batchSubject: formData.get("batchSubject"),
    batchObjective: formData.get("batchObjective"),
  });
  if (!parsed.success) return { error: "请选择班级并填写标题" };

  const batch = await prisma.homeworkBatch.create({
    data: {
      classId: parsed.data.classId,
      ownerId: userId,
      title: parsed.data.title.trim(),
      notes: parsed.data.notes.trim() || null,
      batchSubject: parsed.data.batchSubject.trim() || null,
      batchObjective: parsed.data.batchObjective.trim() || null,
    },
  });
  revalidatePath("/batches");
  return { id: batch.id };
}

const batchUpdate = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(128),
  notes: optionalText(2000),
  batchSubject: optionalText(128),
  batchObjective: optionalText(2000),
});

export async function updateBatchAction(
  _prev: { ok?: true; error?: string } | undefined,
  formData: FormData,
): Promise<{ ok?: true; error?: string } | undefined> {
  const userId = await requireUserId();
  const parsed = batchUpdate.safeParse({
    id: formData.get("id"),
    title: formData.get("title"),
    notes: formData.get("notes"),
    batchSubject: formData.get("batchSubject"),
    batchObjective: formData.get("batchObjective"),
  });
  if (!parsed.success) return { error: "作业设置无效" };

  const updated = await prisma.homeworkBatch.updateMany({
    where: { id: parsed.data.id, ownerId: userId },
    data: {
      title: parsed.data.title.trim(),
      notes: parsed.data.notes.trim() || null,
      batchSubject: parsed.data.batchSubject.trim() || null,
      batchObjective: parsed.data.batchObjective.trim() || null,
    },
  });
  if (updated.count === 0) return { error: "作业不存在或无权修改" };
  revalidatePath(`/batches/${parsed.data.id}`);
  revalidatePath("/batches");
  return { ok: true };
}

export async function deleteBatchAction(formData: FormData) {
  await requireUserId();
  const id = String(formData.get("id"));
  if (!id) return;
  await prisma.homeworkBatch.delete({ where: { id } });
  revalidatePath("/batches");
  redirect("/batches");
}

// 题目层批改要求：
// - requireGrading（是否打分）：true = 走给分细则评分；false = 只批注。
// - rubric（给分细则）：requireGrading=true 时**必填**（非空白）；=false 时可留空。
// - feedbackGuide（修改意见指南）：填了 = 按指引写 feedback；留空 = 用通用默认指南。
//
// customGradingPrompt / customSingleShotPrompt 是高级口子：填了就**整段覆盖**
// 全局 prompt（不再走 {rubric} 替换），适合题型与全局模板差异大的场景。
// 它们是条件渲染的（藏在「高级」折叠里），所以必须用 optionalText —— 老师没
// 展开时这俩 key 在 FormData 里就根本不存在，naive schema 会爆 "Invalid input"。
//
// FormData 里 checkbox / switch 没勾选时根本不会发字段；勾了就发 "on"/"true"/"1"。
// 用 z.preprocess 把缺省也归一化成 boolean，免得 z.coerce.boolean() 把 undefined
// 当 false（实际上 z.coerce.boolean(undefined)=false 倒也 ok）；这里更稳妥的写法
// 是显式列明几种"开"的字面值。
const requireGradingSchema = z.preprocess((v) => {
  if (typeof v === "boolean") return v;
  if (v === undefined || v === null) return true; // 默认打分
  const s = String(v).toLowerCase();
  return s === "on" || s === "true" || s === "1" || s === "yes";
}, z.boolean());

const thinkingOverrideSchema = z.preprocess((v) => {
  if (v === undefined || v === null) return "";
  return String(v).trim().toLowerCase();
}, z.enum(["", "force_on", "force_off"]));

const questionCreate = z
  .object({
    batchId: z.string().min(1),
    index: z.coerce.number().int().min(1).max(99),
    prompt: z.string().min(1).max(4000),
    requireGrading: requireGradingSchema,
    rubric: optionalText(4000),
    feedbackGuide: optionalText(4000),
    thinkingOverride: thinkingOverrideSchema,
    provideModelAnswer: z.preprocess((v) => {
      if (typeof v === "boolean") return v;
      if (v === undefined || v === null) return false;
      const s = String(v).toLowerCase();
      return s === "on" || s === "true" || s === "1" || s === "yes";
    }, z.boolean()),
    modelAnswerGuide: optionalText(4000),
    customGradingPrompt: optionalText(16000),
    customSingleShotPrompt: optionalText(16000),
  })
  .superRefine((val, ctx) => {
    if (val.requireGrading && val.rubric.trim() === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rubric"],
        message: "需要打分时，给分细则不能为空",
      });
    }
    const normalizedThinking = val.thinkingOverride.trim().toLowerCase();
    if (
      normalizedThinking !== "" &&
      normalizedThinking !== "force_on" &&
      normalizedThinking !== "force_off"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["thinkingOverride"],
        message: "思考模式覆盖只能是 force_on / force_off 或留空",
      });
    }
  });

export async function upsertQuestionAction(
  _prev: { error?: string; ok?: true } | undefined,
  formData: FormData,
): Promise<{ error?: string; ok?: true } | undefined> {
  await requireUserId();
  const parsed = questionCreate.safeParse({
    batchId: formData.get("batchId"),
    index: formData.get("index"),
    prompt: formData.get("prompt"),
    requireGrading: formData.get("requireGrading"),
    rubric: formData.get("rubric"),
    feedbackGuide: formData.get("feedbackGuide"),
    thinkingOverride: formData.get("thinkingOverride"),
    provideModelAnswer: formData.get("provideModelAnswer"),
    modelAnswerGuide: formData.get("modelAnswerGuide"),
    customGradingPrompt: formData.get("customGradingPrompt"),
    customSingleShotPrompt: formData.get("customSingleShotPrompt"),
  });
  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? "题目数据无效" };
  }

  const data = {
    prompt: parsed.data.prompt.trim(),
    requireGrading: parsed.data.requireGrading,
    rubric: parsed.data.rubric.trim() || null,
    feedbackGuide: parsed.data.feedbackGuide.trim() || null,
    thinkingOverride: parsed.data.thinkingOverride.trim() || null,
    provideModelAnswer: parsed.data.provideModelAnswer,
    modelAnswerGuide: parsed.data.modelAnswerGuide.trim() || null,
    customGradingPrompt: parsed.data.customGradingPrompt.trim() || null,
    customSingleShotPrompt: parsed.data.customSingleShotPrompt.trim() || null,
  };

  await prisma.question.upsert({
    where: {
      batchId_index: { batchId: parsed.data.batchId, index: parsed.data.index },
    },
    create: {
      batchId: parsed.data.batchId,
      index: parsed.data.index,
      ...data,
    },
    update: data,
  });
  revalidatePath(`/batches/${parsed.data.batchId}`);
  return { ok: true };
}

export async function deleteQuestionAction(formData: FormData) {
  await requireUserId();
  const id = String(formData.get("id"));
  const batchId = String(formData.get("batchId"));
  if (!id) return;
  await prisma.question.delete({ where: { id } });
  if (batchId) revalidatePath(`/batches/${batchId}`);
}
