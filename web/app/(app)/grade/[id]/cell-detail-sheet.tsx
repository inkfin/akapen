"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
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
  question: { id: string; index: number; prompt: string; maxScore: number };
  cell: CellState;
  onClose: () => void;
};

export function CellDetailSheet({
  batchId,
  student,
  question,
  cell,
  onClose,
}: Props) {
  const qc = useQueryClient();

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
          <div className="mb-2 flex items-center gap-2">
            <span className="text-sm font-medium">当前状态：</span>
            <Badge>{status}</Badge>
            {cell.latest?.reviewFlag ? (
              <Badge variant="warning">待复核</Badge>
            ) : null}
            {cell.latest?.revision && cell.latest.revision > 1 ? (
              <Badge variant="outline">第 {cell.latest.revision} 次</Badge>
            ) : null}
          </div>
          {cell.latest?.finalScore !== null &&
          cell.latest?.finalScore !== undefined ? (
            <div className="text-2xl font-semibold">
              {cell.latest.finalScore} <span className="text-base text-[--color-muted-foreground]">/ {question.maxScore}</span>
            </div>
          ) : null}
          {cell.latest?.errorMessage ? (
            <p className="mt-2 text-sm text-[--color-destructive]">
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
              中台重试（不计费）
            </Button>
          ) : null}
        </div>

        {/* 图片轮播：宽度撑满，高度 auto */}
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
          <p className="text-sm text-[--color-muted-foreground]">
            学生还没有上传图片。请去「移动端上传」录入照片再批改。
          </p>
        )}
      </SheetContent>
    </Sheet>
  );
}
