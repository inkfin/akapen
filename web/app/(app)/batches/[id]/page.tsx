import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  BarChart3,
  ClipboardCheck,
  Smartphone,
  Trash2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { deleteQuestionAction } from "@/lib/actions/batches";

import { UpsertQuestionDialog } from "./upsert-question-dialog";

export const dynamic = "force-dynamic";

export default async function BatchDetailPage({
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
      class: { include: { _count: { select: { students: true } } } },
      questions: { orderBy: { index: "asc" } },
    },
  });
  if (!batch) notFound();

  const nextIndex =
    (batch.questions[batch.questions.length - 1]?.index ?? 0) + 1;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button asChild variant="ghost" size="icon">
            <Link href="/batches">
              <ArrowLeft className="size-4" />
            </Link>
          </Button>
          <div>
            <h1 className="text-xl font-semibold">{batch.title}</h1>
            <p className="text-sm text-muted-foreground">
              {batch.class.name} · {batch.class._count.students} 名学生 · {batch.questions.length} 题
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link href={`/batches/${batch.id}/upload`}>
              <Smartphone className="size-4" /> 移动端上传
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href={`/results/${batch.id}`}>
              <BarChart3 className="size-4" /> 看成绩
            </Link>
          </Button>
          <Button asChild>
            <Link href={`/grade/${batch.id}`}>
              <ClipboardCheck className="size-4" /> 进入批改
            </Link>
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>题目列表</CardTitle>
          <UpsertQuestionDialog batchId={batch.id} defaultIndex={nextIndex} />
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16">题号</TableHead>
                <TableHead className="w-24">类型</TableHead>
                <TableHead>题干</TableHead>
                <TableHead className="w-64">给分细则</TableHead>
                <TableHead className="w-56">修改意见</TableHead>
                <TableHead className="w-24 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {batch.questions.length === 0 ? (
                <TableEmpty colSpan={6} message="还没有题目 —— 点右上角「添加题目」" />
              ) : (
                batch.questions.map((q) => {
                  const hasCustomPrompt =
                    !!q.customGradingPrompt || !!q.customSingleShotPrompt;
                  return (
                    <TableRow key={q.id}>
                      <TableCell className="font-mono">{q.index}</TableCell>
                      <TableCell>
                        {q.requireGrading ? (
                          <Badge variant="default">打分</Badge>
                        ) : (
                          <Badge variant="info">只批注</Badge>
                        )}
                      </TableCell>
                      <TableCell className="max-w-md whitespace-pre-wrap">
                        {q.prompt}
                      </TableCell>
                      <TableCell className="max-w-xs space-y-1">
                        {q.requireGrading ? (
                          q.rubric && q.rubric.trim() ? (
                            <p className="line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground">
                              {q.rubric}
                            </p>
                          ) : (
                            <p className="text-xs text-destructive">
                              缺给分细则 —— 请补全
                            </p>
                          )
                        ) : (
                          <p className="text-xs text-muted-foreground/70">
                            （已关掉打分）
                          </p>
                        )}
                        {hasCustomPrompt ? (
                          <p className="text-[11px] text-amber-600 dark:text-amber-400">
                            ⚙ 已覆盖全局 prompt
                          </p>
                        ) : null}
                      </TableCell>
                      <TableCell className="max-w-xs">
                        {q.feedbackGuide && q.feedbackGuide.trim() ? (
                          <p className="line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground">
                            {q.feedbackGuide}
                          </p>
                        ) : (
                          <p className="text-xs text-muted-foreground/70">
                            （默认指南）
                          </p>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <UpsertQuestionDialog
                            batchId={batch.id}
                            defaultIndex={q.index}
                            existing={{
                              id: q.id,
                              index: q.index,
                              prompt: q.prompt,
                              requireGrading: q.requireGrading,
                              rubric: q.rubric,
                              feedbackGuide: q.feedbackGuide,
                              customGradingPrompt: q.customGradingPrompt,
                              customSingleShotPrompt: q.customSingleShotPrompt,
                            }}
                          />
                          <form action={deleteQuestionAction}>
                            <input type="hidden" name="id" value={q.id} />
                            <input
                              type="hidden"
                              name="batchId"
                              value={batch.id}
                            />
                            <Button
                              type="submit"
                              variant="ghost"
                              size="icon"
                              aria-label={`删除第 ${q.index} 题`}
                            >
                              <Trash2 className="size-4 text-destructive" />
                            </Button>
                          </form>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
