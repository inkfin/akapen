"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

import type { CellState } from "@/lib/grade-data";

type Props = {
  batchId: string;
  student: { id: string; externalId: string; name: string };
  question: { id: string; index: number; prompt: string };
  cell: CellState;
  onClose: () => void;
};

// 与 /api/grade/result 路由响应保持同步；放在这里好让组件内可以推断字段。
type ResultPayload = {
  gradingTaskId: string;
  status: string;
  finalScore: number | null;
  maxScore: number | null;
  reviewFlag: boolean;
  reviewReasons: string[];
  feedback: string;
  confidence: number | null;
  notes: string | null;
  dimensionScores: Array<{
    name: string;
    score: number;
    max: number;
    deductions: Array<{ rule: string; points: number; evidence: string | null }>;
  }>;
  transcription: string;
  errorCode: string | null;
  errorMessage: string | null;
};

export function CellDetailSheet({
  batchId,
  student,
  question,
  cell,
  onClose,
}: Props) {
  const qc = useQueryClient();

  // 详情抽屉打开 + 已 succeeded 时按需拉一次完整 result。
  // 没用 refetchInterval：result 拿到就不会变（重批走新 GradingTask），
  // 没必要轮询；status / 重试由父组件的大盘轮询管。
  const { data: result, isFetching } = useQuery({
    queryKey: ["grade-result", cell.latest?.gradingTaskId],
    queryFn: async (): Promise<ResultPayload | null> => {
      if (!cell.latest) return null;
      const r = await fetch(
        `/api/grade/result?id=${encodeURIComponent(cell.latest.gradingTaskId)}`,
        { cache: "no-store" },
      );
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error ?? `HTTP ${r.status}`);
      }
      return (await r.json()) as ResultPayload;
    },
    enabled: !!cell.latest && cell.latest.status === "succeeded",
    staleTime: 60_000,
  });

  const submitMut = useMutation({
    mutationFn: async () => {
      if (!cell.submissionId) throw new Error("没有上传图片");
      const r = await fetch("/api/grade/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ submissionIds: [cell.submissionId] }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error ?? `HTTP ${r.status}`);
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success("已提交批改");
      qc.invalidateQueries({ queryKey: ["grade-board", batchId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const retryMut = useMutation({
    mutationFn: async () => {
      if (!cell.latest) throw new Error("没有可重试的任务");
      const r = await fetch("/api/grade/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gradingTaskId: cell.latest.gradingTaskId }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error ?? `HTTP ${r.status}`);
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success("已发起重试");
      qc.invalidateQueries({ queryKey: ["grade-board", batchId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const status = cell.latest?.status ?? (cell.submissionId ? "已交未批" : "未交");
  const hasScore =
    cell.latest?.finalScore !== null && cell.latest?.finalScore !== undefined;

  return (
    <Sheet
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <SheetContent className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>
            {student.name}（{student.externalId}） · 第 {question.index} 题
          </SheetTitle>
          <SheetDescription className="line-clamp-2">
            {question.prompt}
          </SheetDescription>
        </SheetHeader>

        {/* 当前状态 */}
        <div className="rounded-lg border p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">当前状态：</span>
            <Badge>{status}</Badge>
            {cell.latest?.reviewFlag ? (
              <Badge variant="warning">待复核</Badge>
            ) : null}
            {cell.latest?.revision && cell.latest.revision > 1 ? (
              <Badge variant="outline">第 {cell.latest.revision} 次</Badge>
            ) : null}
            {cell.latest?.status === "succeeded" && !hasScore ? (
              <Badge variant="info">只批注</Badge>
            ) : null}
          </div>
          {hasScore ? (
            <div className="text-2xl font-semibold">
              {cell.latest!.finalScore}
              {cell.latest!.maxScore ? (
                <span className="text-base text-muted-foreground">
                  {" / "}{cell.latest!.maxScore}
                </span>
              ) : (
                <span className="text-base text-muted-foreground"> 分</span>
              )}
            </div>
          ) : null}
          {cell.latest?.errorMessage ? (
            <p className="mt-2 text-sm text-destructive">
              {cell.latest.errorCode ? `[${cell.latest.errorCode}] ` : ""}
              {cell.latest.errorMessage}
            </p>
          ) : null}
        </div>

        {/* 操作 */}
        <div className="flex gap-2">
          <Button
            onClick={() => submitMut.mutate()}
            disabled={submitMut.isPending || !cell.submissionId}
          >
            {submitMut.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Sparkles className="size-4" />
            )}
            {cell.latest ? "重批（新一轮）" : "提交批改"}
          </Button>
          {cell.latest?.akapenTaskId && cell.latest.status === "failed" ? (
            <Button
              variant="outline"
              onClick={() => retryMut.mutate()}
              disabled={retryMut.isPending}
            >
              {retryMut.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              再试一次（不重新计费）
            </Button>
          ) : null}
        </div>

        {/* LLM 输出：feedback / 维度 / 转写 */}
        {cell.latest?.status === "succeeded" ? (
          <div className="space-y-3">
            {isFetching && !result ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> 正在加载批改详情…
              </div>
            ) : null}
            {result?.feedback ? (
              <section className="space-y-1">
                <div className="text-sm font-medium">
                  {hasScore ? "评语 / 改进建议" : "修改建议"}
                </div>
                <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm whitespace-pre-wrap leading-relaxed">
                  {result.feedback}
                </div>
              </section>
            ) : null}
            {result && result.dimensionScores.length > 0 ? (
              <section className="space-y-1">
                <div className="text-sm font-medium">维度细分</div>
                <div className="overflow-hidden rounded-md border">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/50">
                      <tr className="border-b">
                        <th className="p-2 text-left">维度</th>
                        <th className="p-2 text-right">得分</th>
                        <th className="p-2 text-left">扣分点</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.dimensionScores.map((d, i) => (
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
                              <ul className="space-y-1">
                                {d.deductions.map((x, j) => (
                                  <li key={j}>
                                    <span className="font-medium">{x.rule}</span>{" "}
                                    <span className="text-muted-foreground">−{x.points}</span>
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
            {result?.transcription ? (
              <details className="rounded-md border p-2">
                <summary className="cursor-pointer text-xs text-muted-foreground">
                  模型转写后的正文
                </summary>
                <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap text-xs">
                  {result.transcription}
                </pre>
              </details>
            ) : null}
            {result?.notes ? (
              <p className="text-xs text-muted-foreground">
                <span className="font-medium">备注：</span>
                {result.notes}
              </p>
            ) : null}
          </div>
        ) : null}

        {/* 图片：宽度撑满，高度 auto */}
        {cell.imagePaths.length > 0 ? (
          <div className="grid gap-2">
            <div className="text-sm font-medium">学生答题图（{cell.imagePaths.length}）</div>
            <div className="grid grid-cols-2 gap-2">
              {cell.imagePaths.map((p) => (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  key={p}
                  src={`/api/uploads-preview?p=${encodeURIComponent(p)}`}
                  alt={p}
                  className="rounded-md border object-cover"
                  style={{ aspectRatio: "3/4" }}
                />
              ))}
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            学生还没有上传图片。请去「移动端上传」录入照片再批改。
          </p>
        )}
      </SheetContent>
    </Sheet>
  );
}
