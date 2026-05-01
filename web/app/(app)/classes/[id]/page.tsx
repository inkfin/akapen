import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Trash2 } from "lucide-react";

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
import { deleteStudentAction } from "@/lib/actions/classes";

import { AddStudentsDialog } from "./add-students-dialog";

export const dynamic = "force-dynamic";

export default async function ClassDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.id) return null;

  const cls = await prisma.class.findFirst({
    where: { id, ownerId: session.user.id },
    include: {
      students: { orderBy: [{ externalId: "asc" }] },
      _count: { select: { batches: true } },
    },
  });
  if (!cls) notFound();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button asChild variant="ghost" size="icon">
            <Link href="/classes">
              <ArrowLeft className="size-4" />
            </Link>
          </Button>
          <div>
            <h1 className="text-xl font-semibold">{cls.name}</h1>
            <p className="text-sm text-[--color-muted-foreground]">
              {cls.school ?? "未填学校"} · {cls.students.length} 名学生 · {cls._count.batches} 个作业批次
            </p>
          </div>
        </div>
        <AddStudentsDialog classId={cls.id} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>学生名单</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-32">学号</TableHead>
                <TableHead>姓名</TableHead>
                <TableHead className="w-20 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cls.students.length === 0 ? (
                <TableEmpty colSpan={3} message="还没有学生 —— 用右上角「批量添加」一次粘多行" />
              ) : (
                cls.students.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-mono">{s.externalId}</TableCell>
                    <TableCell>{s.name}</TableCell>
                    <TableCell className="text-right">
                      <form action={deleteStudentAction}>
                        <input type="hidden" name="id" value={s.id} />
                        <input type="hidden" name="classId" value={cls.id} />
                        <Button
                          type="submit"
                          variant="ghost"
                          size="icon"
                          aria-label={`删除 ${s.name}`}
                        >
                          <Trash2 className="size-4 text-[--color-destructive]" />
                        </Button>
                      </form>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
