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

  // 全局"有写操作进行中"锁。任何写（拖动 / 删除 / 上传）期间禁掉其他写，
  // 避免乐观更新交叉返回时出现"旧响应覆盖新状态"的 race。
  const busy = pending || uploading || reordering;

  // dnd-kit sensors：
  // - MouseSensor 桌面：移动 8px 才触发拖动 → 单击删除按钮 / 单击点开图都不会
  //   被吞，门槛稳。
  // - TouchSensor 移动：长按 200ms（容差 5px）才触发 → 老师在拖把手上要明确
  //   长按才进入排序模式。注意：listeners 只挂在专用 drag handle 上（不挂在
  //   缩略图本体），这样从缩略图本体开始的 swipe 仍然能正常滚页。
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
   * 拖拽结束：optimistic 更新本地顺序 → PATCH 后端（带 previousImagePaths
   * 做乐观锁）。PATCH 期间 `busy` 为 true，整个区域禁止再次写操作（拖动 /
   * 删除 / 上传都被禁），等回包后再放开。
   *
   * 失败：
   *   - 409 + server 返回的最新 imagePaths：用 server 的为准（说明有别人改过）；
   *   - 其他错误：回滚到拖动前的旧顺序 + toast 让老师知道没保存。
   */
  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const prev = paths;
    const oldIdx = prev.indexOf(String(active.id));
    const newIdx = prev.indexOf(String(over.id));
    if (oldIdx < 0 || newIdx < 0) return;
    const next = arrayMove(prev, oldIdx, newIdx);
    setPaths(next);

    if (!submissionId) return; // 还没建 submission，不发请求
    setReordering(true);
    try {
      const res = await fetch("/api/upload", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          submissionId,
          previousImagePaths: prev,
          imagePaths: next,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        imagePaths?: string[];
        error?: string;
      };
      if (res.status === 409 && Array.isArray(j.imagePaths)) {
        // 别人抢先改了：以 server 为准，告诉老师刷新过
        setPaths(j.imagePaths);
        toast.error(j.error ?? "图序已被更新，已刷新为最新顺序");
        return;
      }
      if (!res.ok) {
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      // 成功：信 server 的 imagePaths 避免漂移
      if (Array.isArray(j.imagePaths)) setPaths(j.imagePaths);
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
                    disabled={busy}
                    onDelete={() => handleDelete(p)}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
          {paths.length >= 2 ? (
            <p className="text-xs text-muted-foreground">
              {reordering ? "保存顺序中…" : "拖动左上角拖把手调整顺序"}
              <span className="hidden md:inline">
                ；桌面端按住拖把手移动 8px 即触发
              </span>
              <span className="md:hidden">；手机长按拖把手 200ms 后再拖动</span>
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
        disabled={busy}
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
 * 可拖动的缩略图。**关键设计**：拖动 listeners 只挂在左上角专用 drag handle
 * 上，**不**挂在缩略图本体 —— 这样从缩略图开始的纵向 swipe 仍然能正常滚页面
 * （`touch-action: none` 同样只加在 handle 上）。这是 dnd-kit 官方推荐的做法
 * （详见 docs/sensors/touch-action）。
 *
 * 副作用：老师必须精确瞄准左上角小拖把手才能拖动 —— 所以 handle 始终可见
 * 且做大点（24×24px = 推荐最小触控目标），不用 hover 隐藏。
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
  // disabled 时不响应拖动 sensor activation；外层 busy（PATCH/DELETE/POST 进行
  // 中）会传 disabled=true 防并发写。
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled });
  const [broken, setBroken] = useState(false);

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : undefined,
    opacity: isDragging ? 0.85 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="relative size-20 overflow-hidden rounded-md border bg-muted"
    >
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
          className="pointer-events-none size-full select-none object-cover"
          onError={() => setBroken(true)}
        />
      )}

      {/*
        左上角 drag handle —— **只有这里**装拖动 listeners 和 touch-action:none。
        始终可见（不 hover-only），24×24 触控目标够大；半透明黑底 + 拖动 icon
        在彩色照片上辨识度足够。

        - touch-action:none 让 TouchSensor 能 preventDefault 早期 touchmove，
          否则浏览器在 ~100ms 内自己决定 scroll vs tap，TouchSensor 来不及拦。
          仅限于这个 24×24 小区域，不影响整张缩略图的 swipe 滚页行为。
        - cursor:grab / active:grabbing 给桌面用户视觉反馈。
        - disabled（busy）时不挂 listeners，禁用 cursor 提示，老师能看出"现在
          不能拖"。
      */}
      <button
        type="button"
        aria-label="拖动调整顺序"
        disabled={disabled}
        {...attributes}
        {...(disabled ? {} : listeners)}
        className="absolute left-1 top-1 z-[2] flex size-6 cursor-grab items-center justify-center rounded bg-black/60 text-white transition-opacity hover:bg-black/80 active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-50"
        style={{ touchAction: "none" }}
      >
        <GripVertical className="size-3.5" />
      </button>

      {/*
        删除按钮 —— 始终可见。**不要用 group-hover** 隐藏：触屏设备没有 hover
        状态，老师在手机上根本点不到。size-6 = 24px 触控目标够大。

        关键：onPointerDown e.stopPropagation 隔离 —— 防止跟外层任何 pointer
        监听打架（虽然 wrapper 已没装 listeners，但保留这一层防御为了将来如果
        有人把 listeners 加回去时不踩坑）。
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
