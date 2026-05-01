"use client";

import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { Plus } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { createStudentsAction } from "@/lib/actions/classes";

function Submit() {
  const { pending } = useFormStatus();
  return <Button type="submit" disabled={pending}>{pending ? "保存中..." : "保存"}</Button>;
}

export function AddStudentsDialog({ classId }: { classId: string }) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(createStudentsAction, undefined);

  useEffect(() => {
    if (state?.created !== undefined) {
      toast.success(`已添加 ${state.created} 名学生`);
      setOpen(false);
    } else if (state?.error) {
      toast.error(state.error);
    }
  }, [state]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="size-4" /> 批量添加学生
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>批量添加学生</DialogTitle>
          <DialogDescription>
            每行一名学生，格式：「学号 姓名」（中间用空格、Tab 或逗号分隔均可）。
          </DialogDescription>
        </DialogHeader>
        <form action={formAction} className="grid gap-4">
          <input type="hidden" name="classId" value={classId} />
          <div className="grid gap-2">
            <Label htmlFor="bulk">学号 + 姓名（每行一个）</Label>
            <Textarea
              id="bulk"
              name="bulk"
              required
              rows={10}
              className="font-mono"
              placeholder={`2024001 王伟\n2024002 李娜\n2024003,张敏`}
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
