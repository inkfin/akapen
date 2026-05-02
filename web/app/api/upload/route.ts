import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  MAX_IMAGES_PER_SUBMISSION,
  MAX_UPLOAD_BYTES,
  UPLOAD_ROOT,
  detectImageType,
  extOf,
} from "@/lib/uploads";

// 只能跑在 Node runtime（要写文件 + crypto + Prisma）
export const runtime = "nodejs";

// FormData 字段约定：
//   batchId / studentId / questionId（普通字符串）
//   files                              （File，可重复，前端用同名 key append）
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "invalid multipart" }, { status: 400 });
  }

  const batchId = String(form.get("batchId") ?? "");
  const studentId = String(form.get("studentId") ?? "");
  const questionId = String(form.get("questionId") ?? "");
  const files = form.getAll("files");
  if (!batchId || !studentId || !questionId || files.length === 0) {
    return NextResponse.json({ error: "缺少字段" }, { status: 400 });
  }

  // 三方归属校验：batch 是当前老师的，student 在 batch 的 class 下，question 在 batch 下
  const batch = await prisma.homeworkBatch.findFirst({
    where: { id: batchId, ownerId: session.user.id },
  });
  if (!batch) {
    return NextResponse.json({ error: "作业不存在" }, { status: 404 });
  }
  const [student, question] = await Promise.all([
    prisma.student.findFirst({
      where: { id: studentId, classId: batch.classId },
    }),
    prisma.question.findFirst({ where: { id: questionId, batchId } }),
  ]);
  if (!student) {
    return NextResponse.json({ error: "学生不属于该班级" }, { status: 400 });
  }
  if (!question) {
    return NextResponse.json({ error: "题目不属于该作业" }, { status: 400 });
  }

  // 落盘目录
  const dir = path.join(UPLOAD_ROOT, batchId, studentId, questionId);
  await fs.mkdir(dir, { recursive: true });

  const savedRel: string[] = [];
  for (const f of files) {
    if (!(f instanceof File)) continue;
    if (f.size === 0) continue;
    if (f.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: `${f.name} 超出 ${(MAX_UPLOAD_BYTES / 1024 / 1024).toFixed(1)}MB 上限` },
        { status: 413 },
      );
    }
    const buf = new Uint8Array(await f.arrayBuffer());
    const type = detectImageType(buf);
    if (!type) {
      return NextResponse.json(
        {
          error: `${f.name} 不是支持的图片格式（仅 JPEG / PNG / WebP / HEIC）`,
        },
        { status: 415 },
      );
    }
    const sha = crypto
      .createHash("sha256")
      .update(buf)
      .digest("hex")
      .slice(0, 16);
    const filename = `${sha}.${extOf(type)}`;
    const full = path.join(dir, filename);
    // 同 sha 已经在了就不重写（幂等：拍照晃了一下产生不同 sha 才会真存）
    try {
      await fs.access(full);
    } catch {
      await fs.writeFile(full, buf);
    }
    // 关键：存相对 UPLOAD_ROOT 的路径，跨容器重启 / 换路径都不影响
    savedRel.push(path.posix.join(batchId, studentId, questionId, filename));
  }

  // 合并到 Submission（已有则合并 + 去重 + 截顶）
  const existing = await prisma.submission.findUnique({
    where: { questionId_studentId: { questionId, studentId } },
  });
  const oldPaths: string[] = existing
    ? safeParseStringArray(existing.imagePaths)
    : [];
  const merged = Array.from(new Set([...oldPaths, ...savedRel])).slice(
    0,
    MAX_IMAGES_PER_SUBMISSION,
  );

  const submission = await prisma.submission.upsert({
    where: { questionId_studentId: { questionId, studentId } },
    create: {
      questionId,
      studentId,
      imagePaths: JSON.stringify(merged),
    },
    update: {
      imagePaths: JSON.stringify(merged),
    },
  });

  return NextResponse.json({
    submissionId: submission.id,
    imagePaths: merged,
    addedCount: savedRel.length,
  });
}

// 删除单张图：传 path 字符串，从 Submission.imagePaths 里去掉，并删盘上的文件。
export async function DELETE(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const { submissionId, imagePath } = await req.json().catch(() => ({}));
  if (!submissionId || !imagePath) {
    return NextResponse.json({ error: "缺少字段" }, { status: 400 });
  }
  // 安全检查：path 必须是 batchId/studentId/questionId/file 形式，不能跳出 UPLOAD_ROOT
  if (
    typeof imagePath !== "string" ||
    imagePath.includes("..") ||
    imagePath.startsWith("/")
  ) {
    return NextResponse.json({ error: "非法路径" }, { status: 400 });
  }
  const submission = await prisma.submission.findUnique({
    where: { id: submissionId },
    include: {
      question: {
        include: {
          batch: { select: { ownerId: true, id: true } },
        },
      },
    },
  });
  if (!submission || submission.question.batch.ownerId !== session.user.id) {
    return NextResponse.json({ error: "无权操作" }, { status: 404 });
  }

  const old: string[] = safeParseStringArray(submission.imagePaths);
  const next = old.filter((p) => p !== imagePath);
  if (next.length === old.length) {
    return NextResponse.json({ error: "没有这张图" }, { status: 404 });
  }
  await prisma.submission.update({
    where: { id: submissionId },
    data: { imagePaths: JSON.stringify(next) },
  });
  // 物理删除（best effort，缺了也无所谓）
  await fs
    .unlink(path.join(UPLOAD_ROOT, imagePath))
    .catch(() => undefined);

  return NextResponse.json({ imagePaths: next });
}

function safeParseStringArray(s: string | null | undefined): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
