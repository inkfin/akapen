"use client";

import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { createBatchAction } from "@/lib/actions/batches";

function Submit() {
  const { pending } = useFormStatus();
  return <Button type="submit" disabled={pending}>{pending ? "创建中..." : "创建"}</Button>;
}

export function CreateBatchDialog({
  classes,
  defaultClassId,
}: {
  classes: { id: string; name: string }[];
  defaultClassId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(createBatchAction, undefined);
  const router = useRouter();

  useEffect(() => {
    if (state?.id) {
      toast.success("作业已创建，请添加题目");
      setOpen(false);
      router.push(`/batches/${state.id}`);
    } else if (state?.error) {
      toast.error(state.error);
    }
  }, [state, router]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="size-4" /> 新建作业
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建作业批次</DialogTitle>
        </DialogHeader>
        <form action={formAction} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="classId">班级</Label>
            <select
              id="classId"
              name="classId"
              required
              defaultValue={defaultClassId ?? classes[0]?.id ?? ""}
              className="flex h-9 w-full rounded-md border bg-transparent px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {classes.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="title">作业标题</Label>
            <Input id="title" name="title" required placeholder="9月第一次作文" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="notes">备注（可选）</Label>
            <Textarea id="notes" name="notes" rows={3} placeholder="给批改者的整体说明" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="batchSubject">学科（可选）</Label>
            <Input id="batchSubject" name="batchSubject" placeholder="语文 / 英语 / 数学" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="batchObjective">作业目标（可选）</Label>
            <Textarea
              id="batchObjective"
              name="batchObjective"
              rows={3}
              placeholder="这次作业重点考查什么能力（如审题准确性、论证结构、步骤完整性）"
            />
          </div>
          <DialogFooter>
            <Submit />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
