import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";

import { QuestionUploader } from "./question-uploader";

export const dynamic = "force-dynamic";

// 移动端页面 2/2：在该学生 × 该作业下，逐题上传图片。
export default async function UploadPerStudentPage({
  params,
}: {
  params: Promise<{ id: string; studentId: string }>;
}) {
  const { id, studentId } = await params;
  const session = await auth();
  if (!session?.user?.id) return null;

  const batch = await prisma.homeworkBatch.findFirst({
    where: { id, ownerId: session.user.id },
    include: {
      class: { include: { students: { where: { id: studentId } } } },
      questions: {
        orderBy: { index: "asc" },
        include: {
          submissions: { where: { studentId } },
        },
      },
    },
  });
  if (!batch || batch.class.students.length === 0) notFound();

  const student = batch.class.students[0];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button asChild variant="ghost" size="icon">
          <Link href={`/batches/${batch.id}/upload`}>
            <ArrowLeft className="size-4" />
          </Link>
        </Button>
        <div>
          <h1 className="text-lg font-semibold">
            {student.name}{" "}
            <span className="text-sm font-mono text-[--color-muted-foreground]">
              {student.externalId}
            </span>
          </h1>
          <p className="text-sm text-[--color-muted-foreground]">{batch.title}</p>
        </div>
      </div>

      <div className="grid gap-4">
        {batch.questions.map((q) => {
          const sub = q.submissions[0];
          const paths: string[] = sub
            ? safeArr(sub.imagePaths)
            : [];
          return (
            <Card key={q.id}>
              <CardHeader>
                <CardTitle className="text-base">
                  第 {q.index} 题
                  <span className="ml-2 text-xs font-normal text-[--color-muted-foreground]">
                    {paths.length} 张图
                  </span>
                </CardTitle>
                <p className="text-sm text-[--color-foreground] line-clamp-2">
                  {q.prompt}
                </p>
              </CardHeader>
              <CardContent>
                <QuestionUploader
                  batchId={batch.id}
                  studentId={student.id}
                  questionId={q.id}
                  submissionId={sub?.id ?? null}
                  initialPaths={paths}
                />
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
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
