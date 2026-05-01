"use client";

import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { ChevronDown, ChevronRight, Pencil, Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { upsertQuestionAction } from "@/lib/actions/batches";

function Submit({ existing }: { existing?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "保存中..." : existing ? "保存修改" : "添加"}
    </Button>
  );
}

type Existing = {
  id: string;
  index: number;
  prompt: string;
  rubric: string;
  customGradingPrompt: string | null;
  customSingleShotPrompt: string | null;
};

const RUBRIC_PLACEHOLDER_TEXT = `示例：

本题满分 30 分。
- 立意紧扣题目（10 分）：是否回答了题目要求；论点是否清晰
- 论据 / 例证（10 分）：列举的事例是否真实；与论点是否相关
- 语言表达（10 分）：用词、语法、句式

严重跑题（题目要点完全未涉及）→ 立意维度最多 3 分，总分一般不超过 10。`;

export function UpsertQuestionDialog({
  batchId,
  defaultIndex,
  existing,
}: {
  batchId: string;
  defaultIndex: number;
  existing?: Existing;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(upsertQuestionAction, undefined);
  const [advancedOpen, setAdvancedOpen] = useState(
    !!(existing?.customGradingPrompt || existing?.customSingleShotPrompt),
  );

  useEffect(() => {
    if (state?.ok) {
      toast.success(existing ? "已保存修改" : "题目已添加");
      setOpen(false);
    } else if (state?.error) {
      toast.error(state.error);
    }
  }, [state, existing]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {existing ? (
          <Button variant="ghost" size="icon" aria-label="编辑题目">
            <Pencil className="size-4" />
          </Button>
        ) : (
          <Button>
            <Plus className="size-4" /> 添加题目
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>{existing ? `编辑第 ${existing.index} 题` : "添加题目"}</DialogTitle>
          <DialogDescription>
            题干 + 评分细则会一起送给 LLM。每道题独立配评分细则（满分、给分点）。
          </DialogDescription>
        </DialogHeader>
        <form action={formAction} className="grid gap-4">
          <input type="hidden" name="batchId" value={batchId} />
          <div className="grid gap-2">
            <Label htmlFor="index">题号</Label>
            <Input
              id="index"
              name="index"
              type="number"
              min={1}
              max={99}
              required
              defaultValue={existing?.index ?? defaultIndex}
              className="max-w-32"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="prompt">题干 *</Label>
            <Textarea
              id="prompt"
              name="prompt"
              required
              rows={3}
              defaultValue={existing?.prompt ?? ""}
              placeholder="请用 200 字以内描述「家乡的秋天」"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="rubric">
              评分细则（rubric）*{" "}
              <span className="text-xs font-normal text-muted-foreground">
                必填，决定本题如何打分
              </span>
            </Label>
            <Textarea
              id="rubric"
              name="rubric"
              required
              rows={6}
              defaultValue={existing?.rubric ?? ""}
              placeholder={RUBRIC_PLACEHOLDER_TEXT}
            />
            <p className="text-xs text-muted-foreground">
              老师只需要写"本题满分多少分 + 给分点 / 扣分项"，输出 JSON 格式 /
              评分流程等技术细节由「设置」里的全局 prompt 框架负责。
            </p>
          </div>

          {/* ─── 高级：覆盖全局 prompt ─── */}
          <div className="rounded-md border">
            <button
              type="button"
              onClick={() => setAdvancedOpen((v) => !v)}
              className="flex w-full items-center gap-2 p-3 text-left text-sm font-medium"
            >
              {advancedOpen ? (
                <ChevronDown className="size-4" />
              ) : (
                <ChevronRight className="size-4" />
              )}
              高级：单题自定义 prompt（极少需要）
            </button>
            {advancedOpen ? (
              <div className="space-y-4 border-t p-3">
                <p className="text-xs text-muted-foreground">
                  填了下面任意一栏，会**整段替换**全局批改 prompt，不再走 {"{rubric}"}{" "}
                  注入。仅当本题题型与全局模板差异巨大时使用（比如全局是中文作文，本题是数学应用题）。
                </p>
                <div className="grid gap-2">
                  <Label htmlFor="customSingleShotPrompt" className="text-xs">
                    自定义 single-shot prompt（视觉一次过模式）
                  </Label>
                  <Textarea
                    id="customSingleShotPrompt"
                    name="customSingleShotPrompt"
                    rows={6}
                    defaultValue={existing?.customSingleShotPrompt ?? ""}
                    placeholder="留空 = 用「设置」里的全局 single-shot prompt（推荐）"
                    className="font-mono text-xs"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="customGradingPrompt" className="text-xs">
                    自定义批改 prompt（OCR + 批改两步模式）
                  </Label>
                  <Textarea
                    id="customGradingPrompt"
                    name="customGradingPrompt"
                    rows={6}
                    defaultValue={existing?.customGradingPrompt ?? ""}
                    placeholder="留空 = 用「设置」里的全局批改 prompt"
                    className="font-mono text-xs"
                  />
                </div>
              </div>
            ) : null}
          </div>

          <DialogFooter>
            <Submit existing={!!existing} />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
