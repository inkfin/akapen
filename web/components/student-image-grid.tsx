"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";

import { cn } from "@/lib/utils";

type Props = {
  /** 学生答题原图相对路径数组（喂给 /api/uploads-preview）。 */
  paths: string[];
  /**
   * 缩略图 grid 容器的 className override。默认两列、桌面三列。
   * 调用方需要更紧凑布局可传 `grid-cols-2`。
   */
  className?: string;
};

/**
 * 学生答题原图缩略图条 + 单击全屏 lightbox 放大查看。
 *
 * 使用场景：
 * - `grade/[id]` 详情抽屉里看缩略图想确认细节
 * - `results/[id]/students/[studentId]` 成绩单折叠面板
 *
 * 行为约定：
 * - 缩略图本身是 `<button>`，回车 / 空格 / 点击都能打开 lightbox
 * - lightbox：Esc 关闭、← / → 翻页（桌面），移动端水平 swipe 翻页
 * - 同一时间只可能一个 lightbox 实例（局部 state，不依赖全局）
 *
 * 不要做的事：
 * - 不要在缩略图上加 `draggable={false}`：这里没有 dnd，反而会让无障碍工具
 *   误判（参考 `question-uploader.tsx` 那里是因为 dnd-kit 才禁用拖动）
 * - 不要替换 `/api/uploads-preview` 为 `/u/[token]`——后者只给 akapen 容器拉图，
 *   暴露给老师浏览器会让签名 secret 路径泄漏
 */
export function StudentImageGrid({ paths, className }: Props) {
  const [openAt, setOpenAt] = useState<number | null>(null);

  if (paths.length === 0) return null;

  return (
    <>
      <div
        className={cn(
          "grid grid-cols-2 gap-2 sm:grid-cols-3",
          className,
        )}
      >
        {paths.map((p, i) => (
          <button
            key={p}
            type="button"
            onClick={() => setOpenAt(i)}
            aria-label={`查看第 ${i + 1} 张原图`}
            className="group relative block overflow-hidden rounded-md border bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            style={{ aspectRatio: "3/4" }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/uploads-preview?p=${encodeURIComponent(p)}`}
              alt={p}
              loading="lazy"
              className="size-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
            />
            {paths.length > 1 ? (
              <span className="absolute right-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">
                {i + 1}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {openAt !== null ? (
        <Lightbox
          paths={paths}
          index={openAt}
          onIndex={setOpenAt}
          onClose={() => setOpenAt(null)}
        />
      ) : null}
    </>
  );
}

function Lightbox({
  paths,
  index,
  onIndex,
  onClose,
}: {
  paths: string[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const total = paths.length;

  const goPrev = useCallback(() => {
    if (index > 0) onIndex(index - 1);
  }, [index, onIndex]);

  const goNext = useCallback(() => {
    if (index < total - 1) onIndex(index + 1);
  }, [index, total, onIndex]);

  // 键盘 + 锁 body scroll（避免移动端拉到底层页面）
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") goPrev();
      else if (e.key === "ArrowRight") goNext();
    }
    window.addEventListener("keydown", onKey);

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [goPrev, goNext, onClose]);

  // 简易水平 swipe 翻页：阈值 50px，竖向滑动 / 多指捏合不触发
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  function onTouchStart(e: React.TouchEvent) {
    if (e.touches.length !== 1) {
      touchStartRef.current = null;
      return;
    }
    touchStartRef.current = {
      x: e.touches[0].clientX,
      y: e.touches[0].clientY,
    };
  }
  function onTouchEnd(e: React.TouchEvent) {
    const start = touchStartRef.current;
    touchStartRef.current = null;
    if (!start || e.changedTouches.length !== 1) return;
    const dx = e.changedTouches[0].clientX - start.x;
    const dy = e.changedTouches[0].clientY - start.y;
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy)) return;
    if (dx > 0) goPrev();
    else goNext();
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/95"
      role="dialog"
      aria-modal="true"
      aria-label="原图查看"
      onClick={onClose}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        aria-label="关闭"
        className="absolute right-3 top-3 z-[2] flex size-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
      >
        <X className="size-5" />
      </button>

      {index > 0 ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            goPrev();
          }}
          aria-label="上一张"
          className="absolute left-3 z-[2] hidden size-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 sm:flex"
        >
          <ChevronLeft className="size-6" />
        </button>
      ) : null}

      {index < total - 1 ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            goNext();
          }}
          aria-label="下一张"
          className="absolute right-3 z-[2] hidden size-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 sm:flex"
        >
          <ChevronRight className="size-6" />
        </button>
      ) : null}

      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/api/uploads-preview?p=${encodeURIComponent(paths[index])}`}
        alt={paths[index]}
        className="max-h-[92vh] max-w-[95vw] select-none object-contain"
        onClick={(e) => e.stopPropagation()}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        draggable={false}
      />

      {total > 1 ? (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-white/10 px-3 py-1 text-xs font-medium text-white">
          {index + 1} / {total}
        </div>
      ) : null}
    </div>
  );
}
