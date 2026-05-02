"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { FeedbackMarkdown } from "@/components/feedback-markdown";
import { StudentImageGrid } from "@/components/student-image-grid";

import type { CellState } from "@/lib/grade-data";
import { parseSuggestion } from "@/lib/prompt-suggestion";

type Props = {
  batchId: string;
  student: { id: string; externalId: string; name: string };
  question: {
    id: string;
    index: number;
    prompt: string;
    requireGrading: boolean;
    provideModelAnswer: boolean;
  };
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
  modelAnswer: string | null;
  promptSuggestion: string | null;
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
  const [followupText, setFollowupText] = useState("");
  const [historyFilter, setHistoryFilter] = useState<"all" | "model_answer">("all");
  const [optimizePrompt, setOptimizePrompt] = useState(false);
  const [selectedHistoryTaskId, setSelectedHistoryTaskId] = useState<string | null>(
    cell.latest?.gradingTaskId ?? null,
  );

  type HistoryItem = {
    gradingTaskId: string;
    revision: number;
    status: string;
    mode: string;
    actionType: string;
    finalScore: number | null;
    maxScore: number | null;
    teacherInstruction: string | null;
    updatedAt: string;
    hasModelAnswer: boolean;
  };

  // 详情抽屉打开 + 已 succeeded 时按需拉一次完整 result。
  // 没用 refetchInterval：result 拿到就不会变（重批走新 GradingTask），
  // 没必要轮询；status / 重试由父组件的大盘轮询管。
  const { data: result, isFetching } = useQuery({
    queryKey: ["grade-result", selectedHistoryTaskId],
    queryFn: async (): Promise<ResultPayload | null> => {
      if (!selectedHistoryTaskId) return null;
      const r = await fetch(
        `/api/grade/result?id=${encodeURIComponent(selectedHistoryTaskId)}`,
        { cache: "no-store" },
      );
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error ?? `HTTP ${r.status}`);
      }
      return (await r.json()) as ResultPayload;
    },
    enabled: !!selectedHistoryTaskId,
    staleTime: 60_000,
  });

  const { data: historyData, isFetching: historyFetching } = useQuery({
    queryKey: ["grade-history", cell.submissionId],
    queryFn: async (): Promise<{ items: HistoryItem[] }> => {
      if (!cell.submissionId) return { items: [] };
      const r = await fetch(
        `/api/grade/history?submissionId=${encodeURIComponent(cell.submissionId)}`,
        { cache: "no-store" },
      );
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error ?? `HTTP ${r.status}`);
      }
      return (await r.json()) as { items: HistoryItem[] };
    },
    enabled: !!cell.submissionId,
    staleTime: 20_000,
  });

  const submitMut = useMutation({
    mutationFn: async (payload?: {
      actionType?: "grade" | "followup" | "model_answer_regen";
      teacherInstruction?: string;
      optimizePrompt?: boolean;
    }) => {
      if (!cell.submissionId) throw new Error("没有上传图片");
      const r = await fetch("/api/grade/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          submissionIds: [cell.submissionId],
          actionType: payload?.actionType ?? "grade",
          teacherInstruction: payload?.teacherInstruction ?? undefined,
          optimizePrompt: payload?.optimizePrompt ?? false,
        }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error ?? `HTTP ${r.status}`);
      }
      return r.json();
    },
    onSuccess: (_, vars) => {
      if (vars?.actionType === "model_answer_regen") {
        toast.success("已提交范文重生");
      } else if (vars?.actionType === "followup") {
        toast.success("已提交追问修订");
      } else {
        toast.success("已提交批改");
      }
      qc.invalidateQueries({ queryKey: ["grade-board", batchId] });
      qc.invalidateQueries({ queryKey: ["grade-history", cell.submissionId] });
      setFollowupText("");
      setOptimizePrompt(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const applySuggestionMut = useMutation({
    mutationFn: async () => {
      if (!result?.gradingTaskId) throw new Error("没有可应用的建议");
      const r = await fetch("/api/grade/apply-suggestion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gradingTaskId: result.gradingTaskId }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error ?? `HTTP ${r.status}`);
      }
      return (await r.json()) as {
        ok: boolean;
        applied: { rubric: boolean; feedbackGuide: boolean };
      };
    },
    onSuccess: (res) => {
      toast.success(
        `已应用建议（${[
          res.applied.rubric ? "给分细则" : "",
          res.applied.feedbackGuide ? "修改意见方向" : "",
        ]
          .filter(Boolean)
          .join(" + ")}）`,
      );
      qc.invalidateQueries({ queryKey: ["grade-result", selectedHistoryTaskId] });
      qc.invalidateQueries({ queryKey: ["grade-history", cell.submissionId] });
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
      qc.invalidateQueries({ queryKey: ["grade-history", cell.submissionId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const markReviewedMut = useMutation({
    mutationFn: async () => {
      if (!selectedHistoryTaskId) throw new Error("没有可操作的任务");
      const r = await fetch("/api/grade/mark-reviewed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gradingTaskId: selectedHistoryTaskId }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error ?? `HTTP ${r.status}`);
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success("已标记为已复核");
      qc.invalidateQueries({ queryKey: ["grade-board", batchId] });
      qc.invalidateQueries({ queryKey: ["grade-result", selectedHistoryTaskId] });
      qc.invalidateQueries({ queryKey: ["grade-history", cell.submissionId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const status = cell.latest?.status ?? (cell.submissionId ? "已交未批" : "未交");
  const historyItems = historyData?.items ?? [];
  const filteredHistory = useMemo(
    () =>
      historyItems.filter((item) => {
        if (historyFilter === "all") return true;
        return item.actionType === "model_answer_regen" || item.hasModelAnswer;
      }),
    [historyItems, historyFilter],
  );
  const selectedHistoryItem = historyItems.find((x) => x.gradingTaskId === selectedHistoryTaskId);
  const hasScore = result?.finalScore !== null && result?.finalScore !== undefined;
  const suggestion = parseSuggestion(result?.promptSuggestion ?? null);

  useEffect(() => {
    setSelectedHistoryTaskId(cell.latest?.gradingTaskId ?? null);
  }, [cell.latest?.gradingTaskId]);

  useEffect(() => {
    if (filteredHistory.length === 0) return;
    if (!selectedHistoryTaskId) {
      setSelectedHistoryTaskId(filteredHistory[0].gradingTaskId);
      return;
    }
    if (!filteredHistory.some((x) => x.gradingTaskId === selectedHistoryTaskId)) {
      setSelectedHistoryTaskId(filteredHistory[0].gradingTaskId);
    }
  }, [filteredHistory, selectedHistoryTaskId]);

  return (
    <Sheet
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      {/*
        宽度策略（Tailwind 默认 rem→px 按 16px root；与下面 class 一一对应）：
        - 手机（默认）：w-full max-w-md → 约 448px 封顶，再窄则全宽
        - sm: max-w-xl → 36rem ≈ 576px
        - md: max-w-2xl → 42rem ≈ 672px
        - lg: max-w-3xl → 48rem ≈ 768px
        - xl: max-w-4xl → 56rem ≈ 896px
        cn() + tailwind-merge 会覆盖 ui/sheet.tsx 自带的 sm:max-w-lg。
      */}
      <SheetContent className="overflow-y-auto sm:max-w-xl md:max-w-2xl lg:max-w-3xl xl:max-w-4xl">
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
            {selectedHistoryItem &&
            selectedHistoryItem.gradingTaskId !== cell.latest?.gradingTaskId ? (
              <Badge variant="secondary">正在查看 r{selectedHistoryItem.revision}</Badge>
            ) : null}
            {cell.latest?.status === "succeeded" && !hasScore ? (
              question.requireGrading ? (
                <Badge variant="destructive">应打未打</Badge>
              ) : (
                <Badge variant="info">只批注</Badge>
              )
            ) : null}
          </div>
          {hasScore ? (
            <div className="text-2xl font-semibold">
              {result!.finalScore}
              {result!.maxScore ? (
                <span className="text-base text-muted-foreground">
                  {" / "}{result!.maxScore}
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
          {cell.latest?.reviewFlag ? (
            <div className="mt-2 flex justify-end">
              <Button
                size="sm"
                variant="outline"
                onClick={() => markReviewedMut.mutate()}
                disabled={markReviewedMut.isPending}
              >
                {markReviewedMut.isPending ? "处理中…" : "已复核，去掉标记"}
              </Button>
            </div>
          ) : null}
        </div>

        <section className="rounded-lg border p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-medium">历史记录</div>
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant={historyFilter === "all" ? "default" : "outline"}
                onClick={() => setHistoryFilter("all")}
                disabled={historyFetching}
              >
                全体历史
              </Button>
              <Button
                size="sm"
                variant={historyFilter === "model_answer" ? "default" : "outline"}
                onClick={() => setHistoryFilter("model_answer")}
                disabled={historyFetching}
              >
                范文历史
              </Button>
            </div>
          </div>
          {historyFetching ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              正在加载历史…
            </div>
          ) : filteredHistory.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {historyFilter === "model_answer"
                ? "暂无范文重生相关历史"
                : "暂无历史记录"}
            </p>
          ) : (
            <div className="space-y-1">
              {filteredHistory.map((item) => {
                const actionLabel =
                  item.actionType === "followup"
                    ? "追问修订"
                    : item.actionType === "model_answer_regen"
                      ? "重生范文"
                      : "常规批改";
                return (
                  <button
                    type="button"
                    key={item.gradingTaskId}
                    onClick={() => setSelectedHistoryTaskId(item.gradingTaskId)}
                    className={`w-full rounded-md border px-2 py-1 text-left text-xs transition-colors ${
                      selectedHistoryTaskId === item.gradingTaskId
                        ? "border-primary bg-primary/10"
                        : "bg-muted/20 hover:bg-muted/40"
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant="outline">r{item.revision}</Badge>
                      <Badge variant="secondary">{actionLabel}</Badge>
                      <Badge>{item.status}</Badge>
                      {item.hasModelAnswer ? (
                        <Badge variant="info">含范文</Badge>
                      ) : null}
                      {typeof item.finalScore === "number" ? (
                        <span className="font-mono text-muted-foreground">
                          {item.finalScore}
                          {typeof item.maxScore === "number"
                            ? ` / ${item.maxScore}`
                            : ""}
                        </span>
                      ) : null}
                      <span className="ml-auto text-[11px] text-muted-foreground/80">
                        {new Date(item.updatedAt).toLocaleString()}
                      </span>
                    </div>
                    {item.teacherInstruction ? (
                      <p className="mt-0.5 line-clamp-1 text-muted-foreground">
                        追问：{item.teacherInstruction}
                      </p>
                    ) : null}
                  </button>
                );
              })}
            </div>
          )}
        </section>

        {/* 操作 */}
        <div className="flex gap-2">
          <Button
            onClick={() => submitMut.mutate({ actionType: "grade" })}
            disabled={submitMut.isPending || !cell.submissionId}
          >
            {submitMut.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Sparkles className="size-4" />
            )}
            {cell.latest ? "重批（新一轮）" : "提交批改"}
          </Button>
          {question.provideModelAnswer ? (
            <Button
              variant="outline"
              onClick={() =>
                submitMut.mutate({ actionType: "model_answer_regen" })
              }
              disabled={submitMut.isPending || !cell.submissionId}
            >
              {submitMut.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Sparkles className="size-4" />
              )}
              重生范文
            </Button>
          ) : null}
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
        {question.provideModelAnswer ? (
          <p className="text-xs text-muted-foreground">
            「重生范文」会重新发起一次批改请求并附带新范文，分数可能发生轻微变化。
          </p>
        ) : null}

        {cell.latest ? (
          <section className="rounded-md border p-3">
            <div className="mb-2 text-sm font-medium">追问修订</div>
            <div className="space-y-2">
              <Textarea
                rows={4}
                value={followupText}
                onChange={(e) => setFollowupText(e.target.value)}
                placeholder="例如：这题扣分偏重，请结合原文再复核一次；若有依据可上调 2~3 分。"
              />
              <div className="flex justify-end">
                <Button
                  size="sm"
                  onClick={() =>
                    submitMut.mutate({
                      actionType: "followup",
                      teacherInstruction: followupText.trim(),
                      optimizePrompt,
                    })
                  }
                  disabled={
                    submitMut.isPending || followupText.trim().length === 0
                  }
                >
                  {submitMut.isPending ? "提交中…" : "提交追问"}
                </Button>
              </div>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <Checkbox
                  checked={optimizePrompt}
                  onCheckedChange={(v) => setOptimizePrompt(v === true)}
                />
                本次追问同时生成 prompt 优化建议（仅题目级，不改全局模板）
              </label>
            </div>
          </section>
        ) : null}

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
                <FeedbackMarkdown className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
                  {result.feedback}
                </FeedbackMarkdown>
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
              <section className="space-y-1 rounded-md border p-2">
                <div className="text-xs text-muted-foreground">模型转写后的正文</div>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap text-xs">
                  {result.transcription}
                </pre>
              </section>
            ) : null}
            {result?.modelAnswer ? (
              <section className="space-y-1">
                <div className="text-sm font-medium">修改后范文</div>
                <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/20 p-2 text-xs">
                  {result.modelAnswer}
                </pre>
              </section>
            ) : null}
            {result?.notes ? (
              <p className="text-xs text-muted-foreground">
                <span className="font-medium">备注：</span>
                {result.notes}
              </p>
            ) : null}
            {suggestion ? (
              <section className="space-y-2 rounded-md border p-3">
                <div className="text-sm font-medium">Prompt 优化建议（AI）</div>
                {suggestion.reason ? (
                  <p className="text-xs text-muted-foreground">
                    原因：{suggestion.reason}
                  </p>
                ) : null}
                {suggestion.suggestedRubric ? (
                  <div className="space-y-1">
                    <div className="text-xs font-medium">建议给分细则</div>
                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded border bg-muted/20 p-2 text-xs">
                      {suggestion.suggestedRubric}
                    </pre>
                  </div>
                ) : null}
                {suggestion.suggestedFeedbackGuide ? (
                  <div className="space-y-1">
                    <div className="text-xs font-medium">建议修改意见方向</div>
                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded border bg-muted/20 p-2 text-xs">
                      {suggestion.suggestedFeedbackGuide}
                    </pre>
                  </div>
                ) : null}
                {(suggestion.suggestedRubric || suggestion.suggestedFeedbackGuide) ? (
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        if (!window.confirm("将用 AI 建议覆盖当前题目规则，是否继续？")) return;
                        applySuggestionMut.mutate();
                      }}
                      disabled={applySuggestionMut.isPending}
                    >
                      {applySuggestionMut.isPending ? "应用中…" : "应用到本题"}
                    </Button>
                  </div>
                ) : null}
              </section>
            ) : null}
          </div>
        ) : null}

        {/* 图片：缩略图条 + 单击放大查看（lightbox） */}
        {cell.imagePaths.length > 0 ? (
          <div className="grid gap-2">
            <div className="text-sm font-medium">
              学生答题图（{cell.imagePaths.length}）
              <span className="ml-1 text-xs font-normal text-muted-foreground">
                · 单击放大
              </span>
            </div>
            {/* 抽屉宽度有限，桌面也只放 2 列保持图够大 */}
            <StudentImageGrid
              paths={cell.imagePaths}
              className="grid-cols-2 sm:grid-cols-2"
            />
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
