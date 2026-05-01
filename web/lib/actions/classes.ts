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

const classCreate = z.object({
  name: z.string().min(1).max(64),
  school: optionalText(128),
});

export async function createClassAction(
  _prev: { error?: string } | undefined,
  formData: FormData,
): Promise<{ error?: string; ok?: true } | undefined> {
  const userId = await requireUserId();
  const parsed = classCreate.safeParse({
    name: formData.get("name"),
    school: formData.get("school"),
  });
  if (!parsed.success) return { error: "班级名称不能为空" };

  await prisma.class.create({
    data: {
      name: parsed.data.name.trim(),
      school: parsed.data.school.trim() || null,
      ownerId: userId,
    },
  });
  revalidatePath("/classes");
  return { ok: true };
}

export async function deleteClassAction(formData: FormData) {
  await requireUserId();
  const id = String(formData.get("id"));
  if (!id) return;
  await prisma.class.delete({ where: { id } });
  revalidatePath("/classes");
  redirect("/classes");
}

const studentCreate = z.object({
  classId: z.string().min(1),
  // 支持单条或批量粘贴："2024001 王伟" 多行
  bulk: z.string().min(1).max(8000),
});

export async function createStudentsAction(
  _prev: { error?: string; created?: number } | undefined,
  formData: FormData,
): Promise<{ error?: string; created?: number } | undefined> {
  await requireUserId();
  const parsed = studentCreate.safeParse({
    classId: formData.get("classId"),
    bulk: formData.get("bulk"),
  });
  if (!parsed.success) return { error: "请填写学号和姓名" };

  const lines = parsed.data.bulk
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  // 每行：「学号<空白或逗号或制表符>姓名」
  const rows: { externalId: string; name: string }[] = [];
  for (const line of lines) {
    const m = line.match(/^(\S+)[\s,]+(.+)$/);
    if (m) rows.push({ externalId: m[1], name: m[2].trim() });
  }
  if (rows.length === 0) return { error: "没解析到有效行（每行应是「学号 姓名」）" };

  const result = await prisma.student.createMany({
    data: rows.map((r) => ({ ...r, classId: parsed.data.classId })),
  });
  revalidatePath(`/classes/${parsed.data.classId}`);
  return { created: result.count };
}

export async function deleteStudentAction(formData: FormData) {
  await requireUserId();
  const id = String(formData.get("id"));
  const classId = String(formData.get("classId"));
  if (!id) return;
  await prisma.student.delete({ where: { id } });
  if (classId) revalidatePath(`/classes/${classId}`);
}
