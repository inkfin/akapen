import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  AlertCircle,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FeedbackMarkdown } from "@/components/feedback-markdown";
import { StudentImageGrid } from "@/components/student-image-grid";
import { auth } from "@/lib/auth";
import {
  loadStudentReport,
  type StudentReportData,
  type StudentReportQuestion,
} from "@/lib/results-data";
import { cn } from "@/lib/utils";

import { CopyButton, PrintButton } from "./copy-buttons";

export const dynamic = "force-dynamic";

export default async function StudentReportPage({
  params,
}: {
  params: Promise<{ id: string; studentId: string }>;
}) {
  const { id, studentId } = await params;
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const data = await loadStudentReport(id, studentId, session.user.id);
  if (!data) notFound();

  // 给「复制全部」用的纯文本拼接；放在 server 端编完一次，client 直接闭包返回。
  const fullText = buildFullReportText(data);

  return (
    <div className="space-y-4">
      <ReportHeader data={data} fullText={fullText} />
      <div className="space-y-3 print:space-y-2">
        {data.questions.map((q) => (
          <QuestionCard key={q.questionId} q={q} />
        ))}
      </div>
    </div>
  );
}

// ──────────────── 子组件（server） ────────────────

function ReportHeader({
  data,
  fullText,
}: {
  data: StudentReportData;
  fullText: string;
}) {
  return (
    <div className="space-y-3 print:space-y-2">
      <div className="flex items-center justify-between gap-2 print:hidden">
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="icon">
            <Link
              href={`/results/${data.batchId}`}
              aria-label="返回成绩总览"
            >
              <ArrowLeft className="size-4" />
            </Link>
          </Button>
          <div>
            <h1 className="text-xl font-semibold">
              {data.student.name}{" "}
              <span className="text-base font-normal text-muted-foreground">
                {data.student.externalId}
              </span>
            </h1>
            <p className="text-sm text-muted-foreground">
              {data.batchTitle} · {data.className}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <CopyButton
            text={fullText}
            label="复制整份成绩单"
            variant="default"
          />
          <PrintButton />
          <Button asChild variant="outline" size="sm">
            <Link href={`/grade/${data.batchId}`}>
              <ClipboardCheck className="size-4" /> 去批改
            </Link>
          </Button>
        </div>
      </div>

      {/* 顶部汇总：在屏幕里是个小 stat row，打印时变成一段说明 */}
      <div className="rounded-lg border bg-card p-4 print:border-0 print:p-0">
        <div className="hidden print:block">
          <h1 className="text-lg font-semibold">
            {data.student.name}（{data.student.externalId}） · {data.batchTitle}
          </h1>
          <p className="text-sm text-muted-foreground">{data.className}</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-4 print:grid-cols-4">
          <Stat label="总分">
            {data.totalMax > 0 ? (
              <span className="text-2xl font-semibold">
                {data.totalScore}
                <span className="text-base font-normal text-muted-foreground">
                  {" / "}
                  {data.totalMax}
                </span>
              </span>
            ) : (
              <span className="text-base text-muted-foreground">—</span>
            )}
          </Stat>
          <Stat label="平均得分率">
            {data.averagePercent === null ? (
              <span className="text-base text-muted-foreground">—</span>
            ) : (
              <span
                className={cn(
                  "text-2xl font-semibold",
                  data.averagePercent >= 80
                    ? "text-emerald-600 dark:text-emerald-400"
                    : data.averagePercent >= 60
                      ? "text-sky-600 dark:text-sky-400"
                      : "text-amber-600 dark:text-amber-400",
                )}
              >
                {data.averagePercent.toFixed(1)}%
              </span>
            )}
          </Stat>
          <Stat label="已批 / 应批">
            <span className="text-2xl font-semibold">
              {data.actuallyScored}
              <span className="text-base font-normal text-muted-foreground">
                {" / "}
                {data.expectedScored}
              </span>
            </span>
          </Stat>
          <Stat label="未交 / 待复核">
            <span className="text-base">
              {data.unsubmittedCount > 0 ? (
                <Badge variant="outline" className="mr-1">
                  未交 {data.unsubmittedCount}
                </Badge>
              ) : null}
              {data.needsReviewCount > 0 ? (
                <Badge variant="warning">复核 {data.needsReviewCount}</Badge>
              ) : null}
              {data.unsubmittedCount === 0 && data.needsReviewCount === 0 ? (
                <span className="text-muted-foreground">—</span>
              ) : null}
            </span>
          </Stat>
        </div>
      </div>

      {/* 同班级邻居导航 —— 老师过份子时常用 */}
      <div className="flex items-center justify-between gap-2 print:hidden">
        <div>
          {data.prevStudentId ? (
            <Button asChild variant="ghost" size="sm">
              <Link
                href={`/results/${data.batchId}/students/${data.prevStudentId}`}
              >
                <ChevronLeft className="size-4" /> 上一位学生
              </Link>
            </Button>
          ) : null}
        </div>
        <div>
          {data.nextStudentId ? (
            <Button asChild variant="ghost" size="sm">
              <Link
                href={`/results/${data.batchId}/students/${data.nextStudentId}`}
              >
                下一位学生 <ChevronRight className="size-4" />
              </Link>
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div>{children}</div>
    </div>
  );
}

function QuestionCard({ q }: { q: StudentReportQuestion }) {
  const isPending =
    q.status === "queued" || q.status === "running" || q.status === "pending";
  const succeeded = q.status === "succeeded";
  const failed = q.status === "failed";
  const noSub = !q.hasSubmission;

  return (
    <article className="overflow-hidden rounded-lg border bg-card print:break-inside-avoid">
      {/* 题头：题号、分数、状态 */}
      <header className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/30 px-4 py-2.5 print:bg-transparent">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="text-sm">
            第 {q.index} 题
          </Badge>
          {q.requireGrading ? (
            <Badge variant="outline">打分</Badge>
          ) : (
            <Badge variant="info">只批注</Badge>
          )}
          <ScoreBadge q={q} />
          {q.reviewFlag ? <Badge variant="warning">待复核</Badge> : null}
          {isPending ? <Badge variant="info">批改中</Badge> : null}
          {failed ? <Badge variant="destructive">批改失败</Badge> : null}
          {noSub ? <Badge variant="outline">未交</Badge> : null}
        </div>
        {succeeded && q.result.feedback ? (
          <CopyButton
            text={buildSingleQuestionText(q)}
            label="复制本题"
            variant="ghost"
          />
        ) : null}
      </header>

      <div className="space-y-3 px-4 py-3 text-sm">
        {/* 题干 */}
        <section>
          <div className="text-xs text-muted-foreground">题干</div>
          <p className="mt-0.5 whitespace-pre-wrap leading-relaxed">{q.prompt}</p>
        </section>

        {/* 错误 / 状态提示 */}
        {failed && q.errorMessage ? (
          <section className="flex gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <div className="text-xs leading-relaxed">
              {q.errorCode ? (
                <span className="font-mono">[{q.errorCode}] </span>
              ) : null}
              {q.errorMessage}
            </div>
          </section>
        ) : null}
        {noSub ? (
          <section className="text-xs text-muted-foreground">
            学生本题未上传图片。
          </section>
        ) : null}
        {isPending ? (
          <section className="text-xs text-sky-600 dark:text-sky-400">
            正在批改中，稍后刷新本页查看结果。
          </section>
        ) : null}

        {/* 评语 —— 这是最重要、老师最常复制的内容，给最多视觉权重 */}
        {q.result.feedback ? (
          <section className="space-y-1">
            <div className="text-xs text-muted-foreground">
              评语 / 修改建议
            </div>
            <FeedbackMarkdown className="rounded-md border bg-muted/30 px-3 py-2 print:bg-transparent print:border-0 print:px-0">
              {q.result.feedback}
            </FeedbackMarkdown>
          </section>
        ) : succeeded ? (
          <section className="text-xs text-muted-foreground italic">
            模型本题没有给出评语。
          </section>
        ) : null}

        {/* 维度细分 */}
        {q.result.dimensionScores.length > 0 ? (
          <section className="space-y-1">
            <div className="text-xs text-muted-foreground">维度细分</div>
            <div className="overflow-hidden rounded-md border">
              <table className="w-full text-xs">
                <thead className="bg-muted/50 print:bg-transparent">
                  <tr className="border-b">
                    <th className="p-2 text-left font-medium">维度</th>
                    <th className="p-2 text-right font-medium">得分</th>
                    <th className="p-2 text-left font-medium">扣分点</th>
                  </tr>
                </thead>
                <tbody>
                  {q.result.dimensionScores.map((d, i) => (
                    <tr key={i} className="border-b last:border-0">
                      <td className="p-2 align-top">{d.name}</td>
                      <td className="p-2 text-right align-top font-mono">
                        {d.score}
                        {d.max > 0 ? (
                          <span className="text-muted-foreground"> / {d.max}</span>
                        ) : null}
                      </td>
                      <td className="p-2 align-top">
                        {d.deductions.length === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <ul className="space-y-0.5">
                            {d.deductions.map((x, j) => (
                              <li key={j}>
                                <span className="font-medium">{x.rule}</span>{" "}
                                <span className="text-muted-foreground">
                                  −{x.points}
                                </span>
                                {x.evidence ? (
                                  <span className="ml-1 text-muted-foreground">
                                    「{x.evidence}」
                                  </span>
                                ) : null}
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        {/* 转写 + 原图 折叠（默认收起，避免成绩单过长；打印时如果需要可手动展开） */}
        {q.result.transcription ? (
          <details className="rounded-md border p-2 print:hidden">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              模型转写后的正文
            </summary>
            <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap text-xs">
              {q.result.transcription}
            </pre>
          </details>
        ) : null}
        {q.result.modelAnswer ? (
          <details className="rounded-md border p-2">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              修改后范文
            </summary>
            <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap text-xs">
              {q.result.modelAnswer}
            </pre>
          </details>
        ) : null}
        {q.imagePaths.length > 0 ? (
          <details className="rounded-md border p-2 print:hidden">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              学生原图（{q.imagePaths.length}） · 单击放大
            </summary>
            <div className="mt-2">
              <StudentImageGrid paths={q.imagePaths} />
            </div>
          </details>
        ) : null}

        {/* 复核理由 / 备注 */}
        {q.result.reviewReasons.length > 0 ? (
          <section className="text-xs text-muted-foreground">
            <span className="font-medium">复核原因：</span>
            {q.result.reviewReasons.join("、")}
          </section>
        ) : null}
        {q.result.notes ? (
          <section className="text-xs text-muted-foreground">
            <span className="font-medium">备注：</span>
            {q.result.notes}
          </section>
        ) : null}
      </div>
    </article>
  );
}

function ScoreBadge({ q }: { q: StudentReportQuestion }) {
  if (!q.requireGrading) return null;
  if (q.status !== "succeeded") return null;
  if (typeof q.result.finalScore !== "number") {
    return <Badge variant="destructive">应打未打</Badge>;
  }
  const v = q.result.finalScore;
  const m = q.result.maxScore;
  const pct = m && m > 0 ? (v / m) * 100 : null;
  const variant: React.ComponentProps<typeof Badge>["variant"] =
    pct === null ? "default" : pct >= 80 ? "success" : pct >= 60 ? "info" : "warning";
  return (
    <Badge variant={variant} className="font-mono">
      {v}
      {m ? <span className="opacity-70"> / {m}</span> : null}
    </Badge>
  );
}

// ──────────────── 文本拼接（给「复制」用） ────────────────

function buildSingleQuestionText(q: StudentReportQuestion): string {
  const lines: string[] = [`第 ${q.index} 题`];
  if (q.prompt) lines.push(`题干：${q.prompt}`);
  if (q.requireGrading && q.status === "succeeded") {
    if (typeof q.result.finalScore === "number") {
      const m = q.result.maxScore;
      lines.push(`得分：${q.result.finalScore}${m ? ` / ${m}` : ""}`);
    } else {
      lines.push("得分：未给出");
    }
  } else if (!q.requireGrading) {
    lines.push("（只批注，不打分）");
  }
  if (q.result.feedback) {
    lines.push("");
    lines.push(q.result.feedback);
  }
  if (q.result.dimensionScores.length > 0) {
    lines.push("");
    lines.push("维度细分：");
    for (const d of q.result.dimensionScores) {
      lines.push(`- ${d.name}：${d.score}${d.max > 0 ? ` / ${d.max}` : ""}`);
      for (const x of d.deductions) {
        lines.push(
          `    · ${x.rule}（−${x.points}）${x.evidence ? `「${x.evidence}」` : ""}`,
        );
      }
    }
  }
  if (q.reviewFlag) lines.push("（需复核）");
  return lines.join("\n");
}

function buildFullReportText(d: StudentReportData): string {
  const head = [
    `${d.student.name}（${d.student.externalId}） · ${d.batchTitle}`,
    `班级：${d.className}`,
  ];
  if (d.totalMax > 0) {
    head.push(
      `总分：${d.totalScore} / ${d.totalMax}` +
        (d.averagePercent !== null
          ? `（平均得分率 ${d.averagePercent.toFixed(1)}%）`
          : ""),
    );
  }
  head.push(
    `已批 ${d.actuallyScored}/${d.expectedScored} · 未交 ${d.unsubmittedCount} · 待复核 ${d.needsReviewCount}`,
  );
  const body = d.questions.map((q) => buildSingleQuestionText(q));
  return [head.join("\n"), "", ...intersperse(body, "\n────────\n")].join("\n");
}

function intersperse<T>(arr: T[], sep: T): T[] {
  const out: T[] = [];
  for (let i = 0; i < arr.length; i++) {
    if (i > 0) out.push(sep);
    out.push(arr[i]);
  }
  return out;
}
