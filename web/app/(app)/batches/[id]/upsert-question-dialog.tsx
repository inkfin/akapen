"use client";

import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { Pencil, Plus } from "lucide-react";
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
  rubric: string | null;
  maxScore: number;
};

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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{existing ? `编辑第 ${existing.index} 题` : "添加题目"}</DialogTitle>
          <DialogDescription>
            题干会作为 question_context 送给批改 LLM；评分要点选填，给模型多一份提示。
          </DialogDescription>
        </DialogHeader>
        <form action={formAction} className="grid gap-4">
          <input type="hidden" name="batchId" value={batchId} />
          <div className="grid grid-cols-2 gap-3">
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
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="maxScore">满分</Label>
              <Input
                id="maxScore"
                name="maxScore"
                type="number"
                min={0}
                max={100}
                step="0.5"
                required
                defaultValue={existing?.maxScore ?? 100}
              />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="prompt">题干</Label>
            <Textarea
              id="prompt"
              name="prompt"
              required
              rows={4}
              defaultValue={existing?.prompt ?? ""}
              placeholder="请用 200 字以内描述「家乡的秋天」"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="rubric">评分要点 / 参考答案（可选）</Label>
            <Textarea
              id="rubric"
              name="rubric"
              rows={4}
              defaultValue={existing?.rubric ?? ""}
              placeholder="给模型多一份提示。例如：要求结构完整、辞藻丰富、有真情实感"
            />
          </div>
          <DialogFooter>
            <Submit existing={!!existing} />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
