import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, ClipboardCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { auth } from "@/lib/auth";
import { loadResultsDetail } from "@/lib/results-data";

import { ResultsBoard } from "./results-board";

export const dynamic = "force-dynamic";

export default async function ResultsDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const data = await loadResultsDetail(id, session.user.id);
  if (!data) notFound();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="icon">
            <Link href="/results" aria-label="返回成绩列表">
              <ArrowLeft className="size-4" />
            </Link>
          </Button>
          <div>
            <h1 className="text-xl font-semibold">{data.batchTitle}</h1>
            <p className="text-sm text-muted-foreground">
              成绩总览 · {data.className} · {data.students.length} 名学生 ·{" "}
              {data.questions.length} 题
            </p>
          </div>
          {data.hasInFlight ? (
            <Badge variant="info">部分批改进行中</Badge>
          ) : null}
        </div>
        <Button asChild variant="outline">
          <Link href={`/grade/${data.batchId}`}>
            <ClipboardCheck className="size-4" /> 去批改 / 重批
          </Link>
        </Button>
      </div>

      <ResultsBoard data={data} />
    </div>
  );
}
