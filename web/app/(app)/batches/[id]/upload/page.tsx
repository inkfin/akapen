import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

// 移动端页面 1/2：选学生。布局是大块卡片，按 ID 排序，方便老师拿手机一个一个录。
export default async function UploadPickStudentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.id) return null;

  const batch = await prisma.homeworkBatch.findFirst({
    where: { id, ownerId: session.user.id },
    include: {
      class: { include: { students: { orderBy: { externalId: "asc" } } } },
      questions: { orderBy: { index: "asc" } },
    },
  });
  if (!batch) notFound();

  // 每个学生在这份 batch 下的「已交题数」 = 在这些 questionId 里有 Submission 的题数
  const submissionCounts = await prisma.submission.groupBy({
    by: ["studentId"],
    where: { questionId: { in: batch.questions.map((q) => q.id) } },
    _count: { _all: true },
  });
  const countByStudent = new Map(
    submissionCounts.map((r) => [r.studentId, r._count._all]),
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button asChild variant="ghost" size="icon">
          <Link href={`/batches/${batch.id}`}>
            <ArrowLeft className="size-4" />
          </Link>
        </Button>
        <div>
          <h1 className="text-lg font-semibold">{batch.title}</h1>
          <p className="text-sm text-muted-foreground">
            选择学生 → 上传图片
          </p>
        </div>
      </div>

      {batch.questions.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            还没有题目，先去
            <Link
              href={`/batches/${batch.id}`}
              className="mx-1 text-primary underline"
            >
              添加题目
            </Link>
            再来上传。
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-2">
          {batch.class.students.map((s) => {
            const done = countByStudent.get(s.id) ?? 0;
            const total = batch.questions.length;
            return (
              <Link
                key={s.id}
                href={`/batches/${batch.id}/upload/${s.id}`}
                className="block"
              >
                <Card className="hover:border-ring transition-colors active:scale-[0.99]">
                  <CardContent className="flex items-center justify-between p-4">
                    <div>
                      <div className="font-medium">{s.name}</div>
                      <div className="text-xs text-muted-foreground font-mono">
                        {s.externalId}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge
                        variant={
                          done === 0
                            ? "outline"
                            : done < total
                              ? "warning"
                              : "success"
                        }
                      >
                        {done} / {total}
                      </Badge>
                      <ChevronRight className="size-4 text-muted-foreground" />
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
