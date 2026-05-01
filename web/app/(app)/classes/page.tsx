import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";

import { CreateClassDialog } from "./create-class-dialog";

export const dynamic = "force-dynamic";

export default async function ClassesPage() {
  const session = await auth();
  if (!session?.user?.id) return null;

  const classes = await prisma.class.findMany({
    where: { ownerId: session.user.id },
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { students: true, batches: true } },
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">班级管理</h1>
          <p className="text-sm text-muted-foreground">
            创建班级 → 录入学生名单 → 在「作业批次」里给班级布置作业
          </p>
        </div>
        <CreateClassDialog />
      </div>

      {classes.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>还没有班级</CardTitle>
            <CardDescription>
              点右上角「新建班级」开始。每个班级至少需要一名学生才能上传作业。
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {classes.map((c) => (
            <Card key={c.id} className="hover:border-ring transition-colors">
              <CardHeader>
                <CardTitle>{c.name}</CardTitle>
                <CardDescription>
                  {c.school ? `${c.school} · ` : ""}
                  {c._count.students} 名学生 · {c._count.batches} 个作业批次
                </CardDescription>
              </CardHeader>
              <CardContent className="flex gap-2">
                <Button asChild variant="default" size="sm">
                  <Link href={`/classes/${c.id}`}>管理学生</Link>
                </Button>
                <Button asChild variant="outline" size="sm">
                  <Link href={`/batches?classId=${c.id}`}>作业批次</Link>
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
