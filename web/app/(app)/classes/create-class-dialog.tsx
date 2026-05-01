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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createClassAction } from "@/lib/actions/classes";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "保存中..." : "保存"}
    </Button>
  );
}

export function CreateClassDialog() {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(createClassAction, undefined);

  useEffect(() => {
    if (state?.ok) {
      toast.success("班级已创建");
      setOpen(false);
    } else if (state?.error) {
      toast.error(state.error);
    }
  }, [state]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="size-4" /> 新建班级
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建班级</DialogTitle>
          <DialogDescription>填写班级名称，可选填学校</DialogDescription>
        </DialogHeader>
        <form action={formAction} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="name">班级名称</Label>
            <Input id="name" name="name" required placeholder="2024 高一(3)班" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="school">学校（可选）</Label>
            <Input id="school" name="school" placeholder="深圳实验中学" />
          </div>
          <DialogFooter>
            <Submit />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
