"use client";

import { useRef, useState, useTransition } from "react";
import { Camera, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

type Props = {
  batchId: string;
  studentId: string;
  questionId: string;
  submissionId: string | null;
  initialPaths: string[];
};

export function QuestionUploader({
  batchId,
  studentId,
  questionId,
  submissionId: initialSubmissionId,
  initialPaths,
}: Props) {
  const [paths, setPaths] = useState<string[]>(initialPaths);
  const [submissionId, setSubmissionId] = useState(initialSubmissionId);
  const [pending, startTransition] = useTransition();
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handlePick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);

    const fd = new FormData();
    fd.set("batchId", batchId);
    fd.set("studentId", studentId);
    fd.set("questionId", questionId);
    for (const f of Array.from(files)) fd.append("files", f);

    try {
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const j = (await res.json()) as {
        submissionId: string;
        imagePaths: string[];
      };
      setSubmissionId(j.submissionId);
      setPaths(j.imagePaths);
      toast.success(`已上传 ${files.length} 张`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "上传失败");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  function handleDelete(p: string) {
    if (!submissionId) return;
    startTransition(async () => {
      try {
        const res = await fetch("/api/upload", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ submissionId, imagePath: p }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error ?? `HTTP ${res.status}`);
        }
        const j = (await res.json()) as { imagePaths: string[] };
        setPaths(j.imagePaths);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "删除失败");
      }
    });
  }

  return (
    <div className="grid gap-3">
      {/* 缩略图条：已上传的图 */}
      {paths.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {paths.map((p) => (
            <div
              key={p}
              className="group relative size-20 overflow-hidden rounded-md border bg-[--color-muted]"
            >
              {/* 缩略图直接走我们 own /api/uploads-preview 内部路由（图片是私有的，要走 next 鉴权）。
                  这里在 client 里只能 fetch 然后 createObjectURL；但更简单的：用一个内部
                  鉴权的图片路径。我们暂时直接用 /uploads-preview 路由（实现简单）。
                  注意：/u/[token] 是给外部 akapen 用的签名 URL，不能在浏览器侧滥用。 */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/uploads-preview?p=${encodeURIComponent(p)}`}
                alt={p}
                className="size-full object-cover"
              />
              <button
                type="button"
                onClick={() => handleDelete(p)}
                disabled={pending}
                className="absolute right-1 top-1 hidden size-6 items-center justify-center rounded bg-[--color-destructive] text-[--color-destructive-foreground] group-hover:flex"
                aria-label="删除"
              >
                <Trash2 className="size-3" />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-[--color-muted-foreground]">还没上传图片</p>
      )}

      {/* 拍照 / 多选 */}
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        multiple
        className="hidden"
        onChange={handlePick}
      />
      <Button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={uploading}
        className="w-full"
      >
        {uploading ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Camera className="size-4" />
        )}
        {uploading ? "上传中..." : "拍照 / 选图上传"}
      </Button>
    </div>
  );
}
