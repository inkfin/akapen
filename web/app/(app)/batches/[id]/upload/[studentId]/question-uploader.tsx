"use client";

import { useRef, useState, useTransition } from "react";
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Camera, GripVertical, ImageOff, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { compressImages, HeicUnsupportedError } from "@/lib/image-compress";
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
  const [reordering, setReordering] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // dnd-kit sensors：
  // - MouseSensor 桌面：移动 8px 才触发拖动 → 单击删除按钮 / 单击点开图都不会
  //   被吞，门槛稳。
  // - TouchSensor 移动：长按 200ms（容差 5px）才触发 → 老师在缩略图条上做"上
  //   下滑动滚页面"的手势不会误启动拖动；想拖动得明确按住一会。
  // - KeyboardSensor：a11y 必备，`Tab` 选中 + `Space` 抓起 + 方向键移动 +
  //   `Space` 放下；不影响主流程但能过 lighthouse / 屏幕阅读器场景。
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 5 },
    }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  async function handlePick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);

    try {
      // 上传前做客户端压缩。compressImage 内部对 < 200KB / 非 HEIC 失败都
      // 自动 fallback 原 file，不阻塞流程。但 HEIC/HEIF 输入必须能被浏览器
      // 解码（否则 .heic 落盘后 <img> 标签预览破图），解不了会抛
      // HeicUnsupportedError，这里 catch 后给老师明确引导。
      // 手机直拍 3~5 MB JPEG → ~300 KB，4G 上传从 30~60s 缩到 3~5s。
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
      if (err instanceof HeicUnsupportedError) {
        toast.error(err.message, { duration: 8000 });
      } else {
        toast.error(err instanceof Error ? err.message : "上传失败");
      }
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

  /**
   * 拖拽结束：optimistic 更新本地顺序 → fire-and-forget PATCH 后端。
   * 失败回滚 + toast，让老师知道顺序没保存（避免它以为成了下次进来又错乱）。
   */
  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    if (!submissionId) {
      // 还没上传过、没 submissionId 时不该出现拖动（缩略图条都没渲染）；
      // 防御性处理：直接更新本地，不发请求。
      setPaths((cur) => {
        const oldIdx = cur.indexOf(String(active.id));
        const newIdx = cur.indexOf(String(over.id));
        if (oldIdx < 0 || newIdx < 0) return cur;
        return arrayMove(cur, oldIdx, newIdx);
      });
      return;
    }

    const prev = paths;
    const oldIdx = prev.indexOf(String(active.id));
    const newIdx = prev.indexOf(String(over.id));
    if (oldIdx < 0 || newIdx < 0) return;
    const next = arrayMove(prev, oldIdx, newIdx);
    setPaths(next);
    setReordering(true);
    try {
      const res = await fetch("/api/upload", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ submissionId, imagePaths: next }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      // server 回的 imagePaths 应该跟 next 完全一致；信 server 的避免漂移
      const j = (await res.json()) as { imagePaths: string[] };
      setPaths(j.imagePaths);
    } catch (err) {
      setPaths(prev);
      toast.error(err instanceof Error ? err.message : "保存顺序失败");
    } finally {
      setReordering(false);
    }
  }

  return (
    <div className="grid gap-3">
      {paths.length > 0 ? (
        <>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={paths} strategy={rectSortingStrategy}>
              <div className="flex flex-wrap gap-2">
                {paths.map((p) => (
                  <SortableThumbnail
                    key={p}
                    id={p}
                    disabled={pending}
                    onDelete={() => handleDelete(p)}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
          {/* 提示行 —— 只在有 ≥2 张图时出现，避免占用屏幕。文案分桌面 / 移动 */}
          {paths.length >= 2 ? (
            <p className="text-xs text-muted-foreground">
              拖动缩略图调整顺序{reordering ? "（保存中…）" : ""}
              <span className="hidden md:inline">；桌面端按住拖把手或缩略图本体即可</span>
              <span className="md:hidden">；手机长按缩略图后再拖动</span>
            </p>
          ) : null}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">还没上传图片</p>
      )}

      {/* 拍照 / 多选。accept 包含 image/heic + image/heif —— iPhone 老师从相册
          选已存的 HEIC 不会被浏览器灰掉；client 端会先转 JPEG 再上传，落盘
          的永远是浏览器能 decode 的格式（避免 .heic 文件 <img> 标签破图）。 */}
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

/**
 * 可拖动的缩略图。listeners 只挂在缩略图本体（包括左上角拖把手），**不**挂
 * 在删除按钮上 —— 删除按钮要保持「单击 = 删除」语义，不被拖动 sensor 拦截。
 *
 * `onError` 兜底是为了万一有历史 `.heic` 文件遗留在库里（或浏览器拉图临时
 * fail），不至于让老师看到一堆破图 icon —— 显示一个占位 + 文件名末段，照样
 * 能识别和删除。
 */
function SortableThumbnail({
  id,
  disabled,
  onDelete,
}: {
  id: string;
  disabled: boolean;
  onDelete: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
  const [broken, setBroken] = useState(false);

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    // 拖动中提一层 z-index + 半透明，提示这是被抓起的；touchAction:none 必加，
    // 否则 iOS Safari 触摸时浏览器的"惯性滚动"会跟我们的拖动手势打架。
    touchAction: "none",
    zIndex: isDragging ? 10 : undefined,
    opacity: isDragging ? 0.85 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      // listeners + attributes 挂在 wrapper 上，让整个缩略图都能"按住拖动"，
      // 不需要老师精确瞄准小拖把手。删除按钮内部 e.stopPropagation 隔离。
      {...attributes}
      {...listeners}
      className="relative size-20 cursor-grab touch-none overflow-hidden rounded-md border bg-muted active:cursor-grabbing"
    >
      {/* 左上角拖把手提示 —— 桌面 hover 时显示，让用户知道"这能拖"；移动端
          长按本身就有触觉反馈，不需要常驻 icon。 */}
      <div className="pointer-events-none absolute left-1 top-1 z-[1] hidden rounded bg-black/40 p-0.5 text-white opacity-0 transition-opacity group-hover:opacity-100 md:block md:group-hover:opacity-100">
        <GripVertical className="size-3" />
      </div>

      {broken ? (
        <div className="flex size-full flex-col items-center justify-center gap-1 px-1 text-muted-foreground">
          <ImageOff className="size-5" />
          <span className="line-clamp-1 max-w-full text-[10px] leading-tight">
            {id.split("/").pop()}
          </span>
        </div>
      ) : (
        // /api/uploads-preview 是私有路径（next session 鉴权），不要替换成
        // /u/[token]——后者是给 akapen 容器拉图的签名 URL，不该泄漏到浏览器。
        // draggable=false 防止浏览器自带的图片"幽灵拖动"（会盖掉 dnd-kit 的
        // overlay，看起来像两层东西在动）。
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/uploads-preview?p=${encodeURIComponent(id)}`}
          alt={id}
          draggable={false}
          className="pointer-events-none size-full object-cover select-none"
          onError={() => setBroken(true)}
        />
      )}
      {/*
        删除按钮 —— 始终可见。**不要用 group-hover** 隐藏：触屏设备没有
        hover 状态，老师在手机上根本点不到。size-6 = 24px touch target
        在 size-20 缩略图右上角刚好够大；半透明黑底 + 红 X 在彩色照片上
        也辨识度足够。

        关键：onPointerDown e.stopPropagation 隔离 —— 否则按下删除按钮也
        会触发 dnd-kit 的 sensor activation，导致"想点删除却开始拖动"。
        这跟 dnd-kit 官方文档 `useSortable` 推荐做法一致。
      */}
      <button
        type="button"
        onClick={onDelete}
        onPointerDown={(e) => e.stopPropagation()}
        disabled={disabled}
        className="absolute right-1 top-1 z-[2] flex size-6 items-center justify-center rounded bg-black/60 text-white transition-opacity hover:bg-destructive disabled:opacity-50"
        aria-label="删除"
      >
        <Trash2 className="size-3.5" />
      </button>
    </div>
  );
}
