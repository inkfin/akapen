"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";

async function requireUserId() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  return session.user.id;
}

const batchCreate = z.object({
  classId: z.string().min(1),
  title: z.string().min(1).max(128),
  notes: z.string().max(2000).optional().or(z.literal("")),
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
      notes: parsed.data.notes?.trim() || null,
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

const questionCreate = z.object({
  batchId: z.string().min(1),
  index: z.coerce.number().int().min(1).max(99),
  prompt: z.string().min(1).max(4000),
  rubric: z.string().max(4000).optional().or(z.literal("")),
  maxScore: z.coerce.number().min(0).max(100).default(100),
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
    maxScore: formData.get("maxScore"),
  });
  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? "题目数据无效" };
  }

  await prisma.question.upsert({
    where: {
      batchId_index: { batchId: parsed.data.batchId, index: parsed.data.index },
    },
    create: {
      batchId: parsed.data.batchId,
      index: parsed.data.index,
      prompt: parsed.data.prompt.trim(),
      rubric: parsed.data.rubric?.trim() || null,
      maxScore: parsed.data.maxScore,
    },
    update: {
      prompt: parsed.data.prompt.trim(),
      rubric: parsed.data.rubric?.trim() || null,
      maxScore: parsed.data.maxScore,
    },
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
