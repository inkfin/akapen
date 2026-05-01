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
  });
  if (!parsed.success) return { error: "请选择班级并填写标题" };

  const batch = await prisma.homeworkBatch.create({
    data: {
      classId: parsed.data.classId,
      ownerId: userId,
      title: parsed.data.title.trim(),
      notes: parsed.data.notes.trim() || null,
    },
  });
  revalidatePath("/batches");
  return { id: batch.id };
}

export async function deleteBatchAction(formData: FormData) {
  await requireUserId();
  const id = String(formData.get("id"));
  if (!id) return;
  await prisma.homeworkBatch.delete({ where: { id } });
  revalidatePath("/batches");
  redirect("/batches");
}

// 题目层评分细则 —— 必填。老师必须为每题填一段自然语言的"满分多少 / 给分点"，
// 全局 prompt 模板里的 {rubric} 占位符会被替换成这段。
//
// customGradingPrompt / customSingleShotPrompt 是高级口子：填了就**整段覆盖**
// 全局 prompt（不再走 {rubric} 替换），适合题型与全局模板差异大的场景。
// 它们是条件渲染的（藏在「高级」折叠里），所以必须用 optionalText —— 老师没
// 展开时这俩 key 在 FormData 里就根本不存在，naive schema 会爆 "Invalid input"。
const questionCreate = z.object({
  batchId: z.string().min(1),
  index: z.coerce.number().int().min(1).max(99),
  prompt: z.string().min(1).max(4000),
  rubric: z
    .string()
    .trim()
    .min(4, "评分细则太短：至少写出本题满分和给分点")
    .max(4000),
  customGradingPrompt: optionalText(16000),
  customSingleShotPrompt: optionalText(16000),
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
    rubric: formData.get("rubric"),
    customGradingPrompt: formData.get("customGradingPrompt"),
    customSingleShotPrompt: formData.get("customSingleShotPrompt"),
  });
  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? "题目数据无效" };
  }

  const data = {
    prompt: parsed.data.prompt.trim(),
    rubric: parsed.data.rubric.trim(),
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
