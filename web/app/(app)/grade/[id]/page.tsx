import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

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
              <Link href="/batches">
                <ArrowLeft className="size-4" />
              </Link>
            </Button>
            <div>
              <h1 className="text-xl font-semibold">{data.batchTitle}</h1>
              <p className="text-sm text-[--color-muted-foreground]">
                {data.className} · {data.students.length} 名学生 · {data.questions.length} 题
              </p>
            </div>
          </div>
        </div>
        <GradeBoard initialData={data} batchId={data.batchId} />
      </div>
    </QueryProvider>
  );
}
