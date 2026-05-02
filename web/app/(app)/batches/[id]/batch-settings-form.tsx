"use client";

import { useActionState, useEffect } from "react";
import { useFormStatus } from "react-dom";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { updateBatchAction } from "@/lib/actions/batches";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" disabled={pending}>
      {pending ? "保存中…" : "保存作业设置"}
    </Button>
  );
}

export function BatchSettingsForm({
  batch,
}: {
  batch: {
    id: string;
    title: string;
    notes: string | null;
    subject: string | null;
    batchObjective: string | null;
  };
}) {
  const [state, formAction] = useActionState(updateBatchAction, undefined);

  useEffect(() => {
    if (state?.ok) toast.success("作业设置已保存");
    else if (state?.error) toast.error(state.error);
  }, [state]);

  return (
    <form action={formAction} className="grid gap-3 rounded-md border p-3">
      <input type="hidden" name="id" value={batch.id} />
      <div className="grid gap-1.5">
        <Label htmlFor="batch-title">作业标题</Label>
        <Input id="batch-title" name="title" defaultValue={batch.title} required />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="batch-subject">学科（可选）</Label>
        <Input
          id="batch-subject"
          name="subject"
          defaultValue={batch.subject ?? ""}
          placeholder="语文 / 英语 / 数学"
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="batch-objective">作业目标（可选）</Label>
        <Textarea
          id="batch-objective"
          name="batchObjective"
          rows={3}
          defaultValue={batch.batchObjective ?? ""}
          placeholder="这次作业重点考查什么能力（如审题准确性、论证结构、步骤完整性）"
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="batch-notes">备注（可选）</Label>
        <Textarea
          id="batch-notes"
          name="notes"
          rows={3}
          defaultValue={batch.notes ?? ""}
          placeholder="给批改者的整体说明"
        />
      </div>
      <div className="flex justify-end">
        <SubmitButton />
      </div>
    </form>
  );
}

