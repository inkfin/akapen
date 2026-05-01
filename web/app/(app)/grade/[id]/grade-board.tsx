"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Play, RefreshCw, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

import type { CellState, GradeBoardData } from "@/lib/grade-data";

import { CellDetailSheet } from "./cell-detail-sheet";

// ───── 配色：把 GradingTask.status 映射到徽章变体 + 中文文案 ─────

type CellLabel = {
  text: string;
  variant: React.ComponentProps<typeof Badge>["variant"];
  pending: boolean; // 是否需要继续轮询
};

function describeCell(c: CellState): CellLabel {
  if (!c.submissionId) {
    return { text: "未交", variant: "outline", pending: false };
  }
  if (!c.latest) {
    return { text: "已交未批", variant: "info", pending: false };
  }
  const t = c.latest;
  // 满分以 LLM 真实输出的 max_score 为准（每题 rubric 不同 → max 不同）。
  // 还没拿到（任务跑挂 / 老数据）就只显示 finalScore，不再有占位满分。
  // finalScore=null 且 status=succeeded → "只批注"模式（题目没填 rubric）：
  // 模型只给修改建议，没分数。徽章用 info 蓝色和"已批注"文案区分于普通"已批"。
  switch (t.status) {
    case "succeeded": {
      if (t.finalScore === null) {
        return {
          text: t.reviewFlag ? "已批注 ⚠" : "已批注",
          variant: t.reviewFlag ? "warning" : "info",
          pending: false,
        };
      }
      const text = t.maxScore
        ? `${t.finalScore}/${t.maxScore}`
        : `${t.finalScore} 分`;
      return {
        text: `${text}${t.reviewFlag ? " ⚠" : ""}`,
        variant: t.reviewFlag ? "warning" : "success",
        pending: false,
      };
    }
    case "failed":
      return { text: "失败", variant: "destructive", pending: false };
    case "queued":
    case "running":
    case "pending":
      return { text: "批改中", variant: "info", pending: true };
    default:
      return { text: t.status, variant: "secondary", pending: true };
  }
}

// ───── 主组件 ─────

export function GradeBoard({
  initialData,
  batchId,
}: {
  initialData: GradeBoardData;
  batchId: string;
}) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set()); // submissionId 集合
  const [detailFor, setDetailFor] = useState<{
    studentId: string;
    questionId: string;
  } | null>(null);

  // 关键：refetchInterval 是个函数，根据当前 data 决定要不要继续轮询
  // 没有 pending cell 时停轮询，省 CPU 也省日志
  const { data } = useQuery({
    queryKey: ["grade-board", batchId],
    queryFn: async () => {
      const r = await fetch(`/api/grade/status?batchId=${batchId}`, {
        cache: "no-store",
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as GradeBoardData;
    },
    initialData,
    refetchInterval: (q) => {
      const d = q.state.data;
      if (!d) return 3000;
      const hasPending = Object.values(d.cells).some((row) =>
        Object.values(row).some(
          (c) =>
            c.latest &&
            (c.latest.status === "queued" ||
              c.latest.status === "running" ||
              c.latest.status === "pending"),
        ),
      );
      return hasPending ? 3000 : false;
    },
  });

  // 派生：哪些 (studentId, questionId) 单元格当前可被选中（有 submission）
  const selectableMap = useMemo(() => {
    const m = new Map<string, string>(); // submissionId → "studentId::questionId"
    if (!data) return m;
    for (const q of data.questions) {
      for (const s of data.students) {
        const c = data.cells[q.id]?.[s.id];
        if (c?.submissionId) m.set(c.submissionId, `${s.id}::${q.id}`);
      }
    }
    return m;
  }, [data]);

  function toggle(submissionId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(submissionId)) next.delete(submissionId);
      else next.add(submissionId);
      return next;
    });
  }

  function selectColumn(questionId: string, on: boolean) {
    if (!data) return;
    setSelected((prev) => {
      const next = new Set(prev);
      for (const s of data.students) {
        const c = data.cells[questionId]?.[s.id];
        if (c?.submissionId) {
          if (on) next.add(c.submissionId);
          else next.delete(c.submissionId);
        }
      }
      return next;
    });
  }

  function selectRow(studentId: string, on: boolean) {
    if (!data) return;
    setSelected((prev) => {
      const next = new Set(prev);
      for (const q of data.questions) {
        const c = data.cells[q.id]?.[studentId];
        if (c?.submissionId) {
          if (on) next.add(c.submissionId);
          else next.delete(c.submissionId);
        }
      }
      return next;
    });
  }

  function selectAll(on: boolean) {
    if (!on) {
      setSelected(new Set());
      return;
    }
    setSelected(new Set(selectableMap.keys()));
  }

  const submitMut = useMutation({
    mutationFn: async (ids: string[]) => {
      const r = await fetch("/api/grade/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ submissionIds: ids }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error ?? `HTTP ${r.status}`);
      }
      return (await r.json()) as {
        ok: number;
        failed: number;
        errors: string[];
      };
    },
    onSuccess: (res, ids) => {
      if (res.ok > 0) toast.success(`已提交 ${res.ok} 项批改`);
      if (res.failed > 0) {
        toast.error(`${res.failed} 项失败：\n${res.errors.slice(0, 3).join("\n")}`);
      }
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ["grade-board", batchId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!data) return null;

  const allSelectable = selectableMap.size;
  const allSelected =
    allSelectable > 0 && selected.size === allSelectable;
  const someSelected = selected.size > 0 && !allSelected;

  const detailCell =
    detailFor && data.cells[detailFor.questionId]?.[detailFor.studentId]
      ? data.cells[detailFor.questionId][detailFor.studentId]
      : null;
  const detailStudent = detailFor
    ? data.students.find((s) => s.id === detailFor.studentId)
    : null;
  const detailQuestion = detailFor
    ? data.questions.find((q) => q.id === detailFor.questionId)
    : null;

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-3">
        <Checkbox
          checked={allSelected ? true : someSelected ? "indeterminate" : false}
          onCheckedChange={(v) => selectAll(v === true)}
          aria-label="全选"
        />
        <span className="text-sm text-muted-foreground">
          已选 {selected.size} / {allSelectable} 单元格
        </span>
        <div className="flex-1" />
        <Button
          variant="outline"
          size="sm"
          onClick={() => setSelected(new Set())}
          disabled={selected.size === 0}
        >
          清空选择
        </Button>
        <Button
          size="sm"
          disabled={selected.size === 0 || submitMut.isPending}
          onClick={() => submitMut.mutate(Array.from(selected))}
        >
          {submitMut.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Sparkles className="size-4" />
          )}
          一键批改
        </Button>
      </div>

      {/* Matrix */}
      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="w-10 p-2"></th>
              <th className="min-w-32 p-2 text-left">学生</th>
              {data.questions.map((q) => {
                const colSelectable = data.students.filter(
                  (s) => data.cells[q.id]?.[s.id]?.submissionId,
                ).length;
                const colSelected = data.students.filter((s) => {
                  const sub = data.cells[q.id]?.[s.id]?.submissionId;
                  return sub && selected.has(sub);
                }).length;
                const allCol = colSelectable > 0 && colSelected === colSelectable;
                const someCol = colSelected > 0 && !allCol;
                return (
                  <th
                    key={q.id}
                    className="min-w-28 border-l p-2 text-center"
                    title={q.prompt}
                  >
                    <div className="flex flex-col items-center gap-1">
                      <span>第 {q.index} 题</span>
                      <Checkbox
                        checked={allCol ? true : someCol ? "indeterminate" : false}
                        onCheckedChange={(v) => selectColumn(q.id, v === true)}
                        aria-label={`选中第 ${q.index} 题所有已交`}
                      />
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {data.students.map((s) => {
              const rowSelectable = data.questions.filter(
                (q) => data.cells[q.id]?.[s.id]?.submissionId,
              ).length;
              const rowSelected = data.questions.filter((q) => {
                const sub = data.cells[q.id]?.[s.id]?.submissionId;
                return sub && selected.has(sub);
              }).length;
              const allRow = rowSelectable > 0 && rowSelected === rowSelectable;
              const someRow = rowSelected > 0 && !allRow;
              return (
                <tr key={s.id} className="border-b last:border-0">
                  <td className="p-2 text-center">
                    <Checkbox
                      checked={allRow ? true : someRow ? "indeterminate" : false}
                      onCheckedChange={(v) => selectRow(s.id, v === true)}
                      disabled={rowSelectable === 0}
                      aria-label={`选中 ${s.name} 所有已交`}
                    />
                  </td>
                  <td className="p-2">
                    <div className="font-medium">{s.name}</div>
                    <div className="font-mono text-xs text-muted-foreground">
                      {s.externalId}
                    </div>
                  </td>
                  {data.questions.map((q) => {
                    const c = data.cells[q.id]?.[s.id];
                    if (!c) return <td key={q.id} className="border-l p-2" />;
                    const label = describeCell(c);
                    const isSelected =
                      c.submissionId && selected.has(c.submissionId);
                    return (
                      <td
                        key={q.id}
                        className="border-l p-2 text-center align-middle"
                      >
                        <div className="flex flex-col items-center gap-1">
                          <button
                            type="button"
                            onClick={() =>
                              setDetailFor({
                                studentId: s.id,
                                questionId: q.id,
                              })
                            }
                            className="flex w-full justify-center"
                            disabled={!c.submissionId}
                          >
                            <Badge variant={label.variant}>
                              {label.pending ? (
                                <Loader2 className="mr-1 size-3 animate-spin" />
                              ) : null}
                              {label.text}
                            </Badge>
                          </button>
                          {c.submissionId ? (
                            <Checkbox
                              checked={!!isSelected}
                              onCheckedChange={() =>
                                c.submissionId && toggle(c.submissionId)
                              }
                              aria-label={`选中 ${s.name} 第 ${q.index} 题`}
                            />
                          ) : null}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 详情抽屉 */}
      {detailFor && detailCell && detailStudent && detailQuestion ? (
        <CellDetailSheet
          batchId={batchId}
          student={detailStudent}
          question={detailQuestion}
          cell={detailCell}
          onClose={() => setDetailFor(null)}
        />
      ) : null}
    </div>
  );
}
