"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, RotateCcw, X } from "lucide-react";

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
 * - lightbox 翻页：← / → 键 / 角按钮（桌面），单指 swipe（移动）
 * - lightbox 缩放：双击 toggle 1×↔2×、wheel（桌面），双指 pinch（移动）
 *   缩放范围 [1×, 4×]；缩放后翻页按钮 / swipe 自动停用，避免与拖动冲突
 * - 切换图片 / Esc 关闭：自动复位 (scale=1, 居中)
 * - 同一时间只可能一个 lightbox 实例（局部 state，不依赖全局）
 *
 * 不要做的事：
 * - 不要在缩略图上加 `draggable={false}`：这里没有 dnd，反而会让无障碍工具
 *   误判（参考 `question-uploader.tsx` 那里是因为 dnd-kit 才禁用拖动）
 * - 不要替换 `/api/uploads-preview` 为 `/u/[token]`——后者只给 akapen 容器拉图，
 *   暴露给老师浏览器会让签名 secret 路径泄漏
 * - 不要把 lightbox 渲染回组件树本地：grade detail Sheet 的 SheetContent
 *   带 `slide-in-from-right` transform 类，会让 fixed 后代相对它定位
 *   （CSS 规范），lightbox 就被困在 480px 抽屉里。永远 portal 到 body。
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
          // key 带 index：实际 paths 来自 sha-命名的 imagePaths，重复概率极低；
          // 但客户端拖拽 / 服务端写入未完全收敛时短暂重复也能稳。
          <button
            key={`${i}_${p}`}
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

/* ------------------------------------------------------------------ */
/* Lightbox + 自实现 zoom/pan                                          */
/* ------------------------------------------------------------------ */
/**
 * 缩放规则：
 * - scale ∈ [MIN_SCALE, MAX_SCALE]
 * - 双击：scale = 1 时放到 ZOOM_STEP，否则归位
 * - 桌面 wheel：以鼠标位置为锚缩放
 * - 移动 pinch：以两指中点为锚缩放
 * - scale > 1 时：单指 / 鼠标拖动平移；不再触发翻页 swipe
 * - scale = 1 时：单指水平滑动 ≥SWIPE_THRESHOLD 触发翻页
 * - 切换图片 / 关闭：自动 reset 回 (scale=1, tx=0, ty=0)
 *
 * 不依赖第三方 zoom 库（react-zoom-pan-pinch 体积比这一份逻辑还大）。
 */
const MIN_SCALE = 1;
const MAX_SCALE = 4;
const ZOOM_STEP = 2;
const WHEEL_ZOOM_STEP = 1.15;
const SWIPE_THRESHOLD = 50;

type Transform = { scale: number; tx: number; ty: number };
const IDENTITY: Transform = { scale: 1, tx: 0, ty: 0 };

function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

/**
 * 以容器中心为参考系，把 scale 从 oldScale → newScale，且让 (focalX, focalY)
 * （相对 stage 中心的偏移）这一图上的点不动。
 *
 * transform-origin = center center，CSS transform 序列是 translate→scale，
 * 对图本地一点 P（相对图中心）：屏幕位置（相对 stage 中心）= tx + P*s
 * 解 tx_new = focalX - (focalX - tx_old) * (newScale / oldScale)
 *
 * 调用方负责把「鼠标 / 手指中心」转成「相对 stage 中心」的偏移。
 */
function zoomAround(
  prev: Transform,
  newScale: number,
  focalX: number,
  focalY: number,
): Transform {
  const s2 = clampScale(newScale);
  if (s2 === prev.scale) return prev;
  const ratio = s2 / prev.scale;
  return {
    scale: s2,
    tx: focalX - (focalX - prev.tx) * ratio,
    ty: focalY - (focalY - prev.ty) * ratio,
  };
}

/** 把鼠标 / 手指位置转成「相对 stage 中心」的偏移。 */
function focalRelCenter(
  el: HTMLElement | null,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  if (!el) return { x: 0, y: 0 };
  const r = el.getBoundingClientRect();
  return {
    x: clientX - r.left - r.width / 2,
    y: clientY - r.top - r.height / 2,
  };
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
  const [t, setT] = useState<Transform>(IDENTITY);
  // SSR-safe portal target：mount 后才生效（document 不在 server 端可用）
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const reset = useCallback(() => setT(IDENTITY), []);

  const goPrev = useCallback(() => {
    if (index > 0) {
      reset();
      onIndex(index - 1);
    }
  }, [index, onIndex, reset]);

  const goNext = useCallback(() => {
    if (index < total - 1) {
      reset();
      onIndex(index + 1);
    }
  }, [index, total, onIndex, reset]);

  // 键盘 + 锁 body scroll + 关闭时还原触发元素的焦点
  useEffect(() => {
    // 保存 lightbox 打开前最后聚焦的元素（一般是触发缩略图按钮）
    const prevFocused = (document.activeElement as HTMLElement | null) ?? null;

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") goPrev();
      else if (e.key === "ArrowRight") goNext();
      else if (e.key === "0") reset();
    }
    window.addEventListener("keydown", onKey);

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      // 关闭后把焦点还给原触发缩略图按钮（screen reader / 键盘用户体验）
      if (prevFocused && typeof prevFocused.focus === "function") {
        try {
          prevFocused.focus();
        } catch {
          // 元素已卸载或被禁用，安静吃掉
        }
      }
    };
  }, [goPrev, goNext, onClose, reset]);

  // 进入 lightbox 后把焦点放到关闭按钮，方便键盘用户立即 Esc / Tab。
  // 用 `inert` 隔离 lightbox 之外的 body 子树，配合 portal 一起做出和 Radix
  // Dialog 等价的 focus trap：键盘 / 鼠标 / 屏幕阅读器都进不去 lightbox 之外。
  // 依赖 `mounted`：portal 第一次 render 时 ref 还没挂上，要等到 mounted=true。
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!mounted) return;
    closeBtnRef.current?.focus();

    // 把 body 里所有非 lightbox 兄弟节点设 inert，记录原状态以便还原。
    const root = rootRef.current;
    const siblings = Array.from(document.body.children).filter(
      (el) => el !== root,
    );
    const wasInert = siblings.map((el) => el.hasAttribute("inert"));
    siblings.forEach((el) => el.setAttribute("inert", ""));
    return () => {
      siblings.forEach((el, i) => {
        if (!wasInert[i]) el.removeAttribute("inert");
      });
    };
  }, [mounted]);

  /* ---------- wheel 缩放（桌面） ---------- */
  // 用 ref + 非被动监听器，为了 preventDefault（react onWheel 默认是 passive，
  // preventDefault 会被忽略，导致页面跟着滚 / lightbox 内 scale 跳动）。
  // deps 含 `mounted`：portal 在 mounted=false 第一次 render 不挂 DOM，
  // ref 还没指到节点；mounted 翻 true 后 effect 重跑才能拿到 stage 元素。
  const stageRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!mounted) return;
    const el = stageRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const f = focalRelCenter(el, e.clientX, e.clientY);
      setT((prev) => {
        const factor = e.deltaY < 0 ? WHEEL_ZOOM_STEP : 1 / WHEEL_ZOOM_STEP;
        return zoomAround(prev, prev.scale * factor, f.x, f.y);
      });
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [mounted]);

  /* ---------- 触摸：单指拖动（缩放后） / 双指 pinch / 单指 swipe（未缩放） ---------- */
  type TouchSession =
    | {
        kind: "pan";
        startX: number;
        startY: number;
        startTx: number;
        startTy: number;
      }
    | {
        kind: "pinch";
        startDist: number;
        startScale: number;
        startTx: number;
        startTy: number;
        startMidX: number; // 容器内坐标（rect 相对）
        startMidY: number;
      }
    | {
        kind: "swipe";
        startX: number;
        startY: number;
      };
  const touchRef = useRef<TouchSession | null>(null);

  function midRelCenter(e: React.TouchEvent): { x: number; y: number } {
    const t1 = e.touches[0];
    const t2 = e.touches[1];
    return focalRelCenter(
      stageRef.current,
      (t1.clientX + t2.clientX) / 2,
      (t1.clientY + t2.clientY) / 2,
    );
  }

  function onTouchStart(e: React.TouchEvent) {
    if (e.touches.length === 2) {
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      const mid = midRelCenter(e);
      touchRef.current = {
        kind: "pinch",
        startDist: dist || 1,
        startScale: t.scale,
        startTx: t.tx,
        startTy: t.ty,
        startMidX: mid.x,
        startMidY: mid.y,
      };
      return;
    }
    if (e.touches.length === 1) {
      if (t.scale > 1) {
        touchRef.current = {
          kind: "pan",
          startX: e.touches[0].clientX,
          startY: e.touches[0].clientY,
          startTx: t.tx,
          startTy: t.ty,
        };
      } else {
        touchRef.current = {
          kind: "swipe",
          startX: e.touches[0].clientX,
          startY: e.touches[0].clientY,
        };
      }
    }
  }

  function onTouchMove(e: React.TouchEvent) {
    const s = touchRef.current;
    if (!s) return;
    if (s.kind === "pinch" && e.touches.length === 2) {
      e.preventDefault();
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      const ratio = (dist || 1) / s.startDist;
      const newScale = clampScale(s.startScale * ratio);
      // 用 startMidX/Y 作为锚（手指位置实时变也 OK，但 startMid 更稳）
      const r = newScale / s.startScale;
      setT({
        scale: newScale,
        tx: s.startMidX - (s.startMidX - s.startTx) * r,
        ty: s.startMidY - (s.startMidY - s.startTy) * r,
      });
    } else if (s.kind === "pan" && e.touches.length === 1) {
      e.preventDefault();
      const dx = e.touches[0].clientX - s.startX;
      const dy = e.touches[0].clientY - s.startY;
      setT((prev) => ({ scale: prev.scale, tx: s.startTx + dx, ty: s.startTy + dy }));
    }
  }

  function onTouchEnd(e: React.TouchEvent) {
    const s = touchRef.current;
    touchRef.current = null;
    if (!s || s.kind !== "swipe") return;
    if (e.changedTouches.length !== 1) return;
    const dx = e.changedTouches[0].clientX - s.startX;
    const dy = e.changedTouches[0].clientY - s.startY;
    if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dx) < Math.abs(dy)) return;
    if (dx > 0) goPrev();
    else goNext();
  }

  /* ---------- 鼠标拖动（桌面，scale > 1 时） ---------- */
  const mouseRef = useRef<{
    startX: number;
    startY: number;
    startTx: number;
    startTy: number;
  } | null>(null);
  function onMouseDown(e: React.MouseEvent) {
    if (t.scale <= 1) return;
    e.preventDefault();
    mouseRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startTx: t.tx,
      startTy: t.ty,
    };
  }
  useEffect(() => {
    function onMove(e: MouseEvent) {
      const m = mouseRef.current;
      if (!m) return;
      setT((prev) => ({
        scale: prev.scale,
        tx: m.startTx + (e.clientX - m.startX),
        ty: m.startTy + (e.clientY - m.startY),
      }));
    }
    function onUp() {
      mouseRef.current = null;
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  /* ---------- 双击切换 1x / ZOOM_STEP ---------- */
  function onDoubleClick(e: React.MouseEvent) {
    e.stopPropagation();
    const f = focalRelCenter(stageRef.current, e.clientX, e.clientY);
    setT((prev) =>
      prev.scale > 1 ? IDENTITY : zoomAround(prev, ZOOM_STEP, f.x, f.y),
    );
  }

  const isZoomed = t.scale > 1;

  // lightbox 圆形按钮统一样式：白色环作 focus-visible 指示，跟黑底反差好。
  const btnClass =
    "flex size-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80 focus-visible:ring-offset-2 focus-visible:ring-offset-black";

  if (!mounted) return null;

  const ui = (
    <div
      ref={rootRef}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/95"
      role="dialog"
      aria-modal="true"
      aria-label="原图查看"
      onClick={onClose}
    >
      {/* 顶部右侧操作条：倍率 + 复位 + 关闭 */}
      <div className="absolute right-3 top-3 z-[2] flex items-center gap-2">
        {isZoomed ? (
          <>
            <span className="rounded-full bg-white/10 px-2 py-1 text-xs font-medium text-white">
              {t.scale.toFixed(1)}×
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                reset();
              }}
              aria-label="复位 (键盘 0)"
              className={btnClass}
            >
              <RotateCcw className="size-5" />
            </button>
          </>
        ) : null}
        <button
          ref={closeBtnRef}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          aria-label="关闭 (Esc)"
          className={btnClass}
        >
          <X className="size-5" />
        </button>
      </div>

      {!isZoomed && index > 0 ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            goPrev();
          }}
          aria-label="上一张 (←)"
          className={cn("absolute left-3 z-[2] hidden sm:flex", btnClass)}
        >
          <ChevronLeft className="size-6" />
        </button>
      ) : null}

      {!isZoomed && index < total - 1 ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            goNext();
          }}
          aria-label="下一张 (→)"
          className={cn("absolute right-3 z-[2] hidden sm:flex", btnClass)}
        >
          <ChevronRight className="size-6" />
        </button>
      ) : null}

      {/* stage：吃掉 wheel / touch / 拖动；不要给它 onClick={onClose}，
          否则双击触发的 dbl click 会同时被 dialog 的 onClick 关掉 */}
      <div
        ref={stageRef}
        className="relative flex size-full items-center justify-center overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={onDoubleClick}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onMouseDown={onMouseDown}
        style={{
          // touchAction:none 才能截获原生 pinch / 横向 pan，自己接管
          touchAction: "none",
          cursor: isZoomed
            ? mouseRef.current
              ? "grabbing"
              : "grab"
            : "zoom-in",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/api/uploads-preview?p=${encodeURIComponent(paths[index])}`}
          alt={paths[index]}
          className="max-h-[92vh] max-w-[95vw] select-none object-contain"
          draggable={false}
          style={{
            transform: `translate3d(${t.tx}px, ${t.ty}px, 0) scale(${t.scale})`,
            transformOrigin: "center center",
            transition: touchRef.current || mouseRef.current ? "none" : "transform 0.15s ease-out",
            willChange: "transform",
          }}
        />
      </div>

      {total > 1 ? (
        <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-white/10 px-3 py-1 text-xs font-medium text-white">
          {index + 1} / {total}
        </div>
      ) : null}
    </div>
  );

  // CSS 规范：transform 不为 none 的祖先会成为 fixed 后代的 containing block。
  // grade detail 抽屉的 SheetContent 带 `slide-in-from-right` transform 类，
  // 不 portal 的话 lightbox 的 fixed inset-0 会被困在 480px 抽屉里。
  return createPortal(ui, document.body);
}
