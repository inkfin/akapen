"use client";

import { useRef, useState, useTransition } from "react";
import { Camera, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { compressImages } from "@/lib/image-compress";
import { UPLOAD_ACCEPT } from "@/lib/uploads-shared";

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

    try {
      // 上传前做客户端压缩。compressImage 内部对 < 200KB / HEIC / 失败都
      // 自动 fallback 原 file，不阻塞流程。手机直拍 3~5 MB → ~300 KB，4G
      // 上传从 30~60s 缩到 3~5s（详见 web/lib/image-compress.ts）。
      const original = Array.from(files);
      const compressed = await compressImages(original);

      const fd = new FormData();
      fd.set("batchId", batchId);
      fd.set("studentId", studentId);
      fd.set("questionId", questionId);
      for (let i = 0; i < compressed.length; i++) {
        const blob = compressed[i];
        const fallbackName = original[i].name;
        fd.append(
          "files",
          blob instanceof File
            ? blob
            : new File([blob], fallbackName, { type: blob.type }),
        );
      }

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
              className="relative size-20 overflow-hidden rounded-md border bg-muted"
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
              {/*
                删除按钮 —— 始终可见。**不要用 group-hover** 隐藏：触屏设备没有
                hover 状态，老师在手机上根本点不到。size-6 = 24px touch target
                在 size-20 缩略图右上角刚好够大；半透明黑底 + 红 X 在彩色照片上
                也辨识度足够。
              */}
              <button
                type="button"
                onClick={() => handleDelete(p)}
                disabled={pending}
                className="absolute right-1 top-1 flex size-6 items-center justify-center rounded bg-black/60 text-white transition-opacity hover:bg-destructive disabled:opacity-50"
                aria-label="删除"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">还没上传图片</p>
      )}

      {/* 拍照 / 多选。accept 包含 image/heic + image/heif —— iPhone 老师从相册
          选已存的 HEIC 不会被浏览器灰掉；后端走 pillow-heif 透明解码。 */}
      <input
        ref={inputRef}
        type="file"
        accept={UPLOAD_ACCEPT}
        capture="environment"
        multiple
        className="hidden"
        onChange={handlePick}
      />
      <Button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={uploading}
        className="min-h-11 w-full"
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
