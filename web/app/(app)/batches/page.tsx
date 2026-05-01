import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";

import { CreateBatchDialog } from "./create-batch-dialog";

export const dynamic = "force-dynamic";

export default async function BatchesPage({
  searchParams,
}: {
  searchParams: Promise<{ classId?: string }>;
}) {
  const sp = await searchParams;
  const session = await auth();
  if (!session?.user?.id) return null;

  const [classes, batches] = await Promise.all([
    prisma.class.findMany({
      where: { ownerId: session.user.id },
      orderBy: { createdAt: "desc" },
    }),
    prisma.homeworkBatch.findMany({
      where: {
        ownerId: session.user.id,
        ...(sp.classId ? { classId: sp.classId } : {}),
      },
      orderBy: { createdAt: "desc" },
      include: {
        class: true,
        _count: { select: { questions: true } },
      },
    }),
  ]);

  const filteredClass = sp.classId
    ? classes.find((c) => c.id === sp.classId)
    : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">作业批次</h1>
          <p className="text-sm text-[--color-muted-foreground]">
            {filteredClass
              ? `已筛选：${filteredClass.name}`
              : "为某个班级创建一份新作业，加入若干题目"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {filteredClass ? (
            <Button asChild variant="outline">
              <Link href="/batches">显示全部</Link>
            </Button>
          ) : null}
          <CreateBatchDialog
            classes={classes.map((c) => ({ id: c.id, name: c.name }))}
            defaultClassId={sp.classId}
          />
        </div>
      </div>

      {classes.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>请先创建班级</CardTitle>
            <CardDescription>
              <Link href="/classes" className="text-[--color-primary] underline-offset-4 hover:underline">
                去班级管理 →
              </Link>
            </CardDescription>
          </CardHeader>
        </Card>
      ) : batches.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>还没有作业</CardTitle>
            <CardDescription>点右上角「新建作业」开始</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {batches.map((b) => (
            <Card key={b.id} className="hover:border-[--color-ring] transition-colors">
              <CardHeader>
                <CardTitle className="line-clamp-1">{b.title}</CardTitle>
                <CardDescription>{b.class.name}</CardDescription>
              </CardHeader>
              <CardContent className="flex items-center justify-between gap-2">
                <Badge variant="secondary">{b._count.questions} 题</Badge>
                <div className="flex gap-2">
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/batches/${b.id}`}>编辑题目</Link>
                  </Button>
                  <Button asChild size="sm">
                    <Link href={`/grade/${b.id}`}>批改</Link>
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
