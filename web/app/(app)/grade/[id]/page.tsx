import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, BarChart3 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { auth } from "@/lib/auth";
import { loadGradeBoard } from "@/lib/grade-data";
import { QueryProvider } from "@/components/query-provider";

import { GradeBoard } from "./grade-board";

export const dynamic = "force-dynamic";

export default async function GradePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.id) return null;

  const data = await loadGradeBoard(id, session.user.id);
  if (!data) notFound();

  return (
    <QueryProvider>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" size="icon">
              <Link href={`/batches/${data.batchId}`} aria-label="返回作业批次">
                <ArrowLeft className="size-4" />
              </Link>
            </Button>
            <div>
              <h1 className="text-xl font-semibold">{data.batchTitle}</h1>
              <p className="text-sm text-muted-foreground">
                批改大盘 · {data.className} · {data.students.length} 名学生 · {data.questions.length} 题
              </p>
            </div>
          </div>
          {/* 跳到只读的成绩页 —— 给"已经批完想看汇总"的老师一个清晰出口 */}
          <Button asChild variant="outline">
            <Link href={`/results/${data.batchId}`}>
              <BarChart3 className="size-4" /> 看成绩
            </Link>
          </Button>
        </div>
        <GradeBoard initialData={data} batchId={data.batchId} />
      </div>
    </QueryProvider>
  );
}
