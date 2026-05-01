import Link from "next/link";
import { redirect } from "next/navigation";
import { BarChart3, ClipboardCheck, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { auth } from "@/lib/auth";
import { loadResultsList } from "@/lib/results-data";

export const dynamic = "force-dynamic";

export default async function ResultsListPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const groups = await loadResultsList(session.user.id);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">成绩</h1>
        <p className="text-sm text-muted-foreground">
          按班级查看每份作业的批改进度、平均分、需复核数。点进去看分学生 / 分题统计。
          想动手批改 / 重批某题，请用<strong>「作业批次 → 进入批改」</strong>。
        </p>
      </div>

      {groups.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            还没有任何作业批次 ——
            先去
            <Link href="/batches" className="mx-1 underline">
              「作业批次」
            </Link>
            创建。
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <section key={group.classId} className="space-y-2">
              <div className="flex items-center gap-2">
                <Users className="size-4 text-muted-foreground" />
                <h2 className="text-base font-semibold">{group.className}</h2>
                <Badge variant="outline">{group.batches.length} 份作业</Badge>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {group.batches.map((b) => (
                  <Card key={b.id} className="flex flex-col">
                    <CardHeader>
                      <CardTitle className="line-clamp-2 text-base">
                        {b.title}
                      </CardTitle>
                      <p className="text-xs text-muted-foreground">
                        {b.questionCount} 题 · {b.studentCount} 名学生 · 更新于{" "}
                        {new Date(b.updatedAt).toLocaleDateString()}
                      </p>
                    </CardHeader>
                    <CardContent className="flex-1 space-y-3">
                      <div className="grid grid-cols-3 gap-2 text-center">
                        <Stat
                          label="完成率"
                          value={`${Math.round(b.completion * 100)}%`}
                          tone={
                            b.completion >= 0.99
                              ? "success"
                              : b.completion >= 0.5
                                ? "info"
                                : "warning"
                          }
                        />
                        <Stat
                          label="平均分"
                          value={
                            b.averagePercent === null
                              ? "—"
                              : `${b.averagePercent.toFixed(1)}%`
                          }
                          tone={
                            b.averagePercent === null
                              ? "muted"
                              : b.averagePercent >= 80
                                ? "success"
                                : b.averagePercent >= 60
                                  ? "info"
                                  : "warning"
                          }
                        />
                        <Stat
                          label="待复核"
                          value={String(b.needsReviewCount)}
                          tone={b.needsReviewCount > 0 ? "warning" : "muted"}
                        />
                      </div>
                      <div className="flex gap-2">
                        <Button
                          asChild
                          size="sm"
                          variant="outline"
                          className="flex-1"
                        >
                          <Link href={`/grade/${b.id}`}>
                            <ClipboardCheck className="size-4" /> 去批改
                          </Link>
                        </Button>
                        <Button asChild size="sm" className="flex-1">
                          <Link href={`/results/${b.id}`}>
                            <BarChart3 className="size-4" /> 看详情
                          </Link>
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "success" | "info" | "warning" | "muted";
}) {
  const cls =
    tone === "success"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "info"
        ? "text-sky-600 dark:text-sky-400"
        : tone === "warning"
          ? "text-amber-600 dark:text-amber-400"
          : "text-muted-foreground";
  return (
    <div className="rounded-md border p-2">
      <div className={`text-base font-semibold ${cls}`}>{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}
