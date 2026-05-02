"use client";

/**
 * 响应式对话框 —— 桌面走 shadcn `Dialog`（居中），移动端走 vaul `Drawer`
 * （底部上滑、可全屏）。
 *
 * 设计动机（详见 `.cursor/plans/agent_extract_endpoint_v1_*.plan.md` §移动端约束）：
 * - 默认 shadcn Dialog 在 < md 屏幕上是固定居中 + 两边白边，输入框获得焦点
 *   时 iOS Safari 键盘弹起会顶飞 dialog，体验差。
 * - vaul Drawer 是 mobile-native 的下拉/上滑面板，键盘行为友好 + 留出全屏空间。
 *
 * 使用约定：
 * - API 跟 shadcn `Dialog` 完全一致，迁移成本零；
 *   `<ResponsiveDialog>` ↔ `<Dialog>`、`<ResponsiveDialogContent>` ↔ `<DialogContent>` 等。
 * - 调用方零感知响应式分支；想强制走某种形态？做不到，这是有意设计——
 *   保证整站 dialog 在同一屏幕尺寸下行为一致。
 * - 如果某个 dialog 真的不需要 mobile 优化（比如纯桌面后台页），直接用 shadcn
 *   `Dialog` 就行，不走这个包装。
 *
 * Hydration 安全策略：
 * - SSR 阶段 isDesktop 默认为 true（按桌面渲染，避免 mobile 内容 flash 然后
 *   切换的视觉抖动）；
 * - 客户端 mount 之后再用 matchMedia 真实判断；
 * - 这意味着首屏在 mobile 上会有一帧的桌面内容闪烁；shadcn Dialog 的 portal
 *   动画足够快，肉眼基本无感。
 */

import * as React from "react";
import { Drawer } from "vaul";
import { X } from "lucide-react";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * 响应式断点。`md` 在 tailwind 默认是 768px——平板 portrait 临界点。
 * 大于等于 768 走 Dialog，小于走 Drawer。改了这个值整站行为一致变化。
 */
const DESKTOP_QUERY = "(min-width: 768px)";

/**
 * Hydration-safe `matchMedia` hook。SSR 阶段返 true（按桌面）。
 *
 * 为什么默认 true：用户跟我们承诺的协议是「桌面 / 移动端两套体验」，
 * 而桌面 Dialog 在 mobile 上 fallback 也能用（只是体验差），但 mobile Drawer
 * 在桌面上看着很奇怪（占满底部）。所以默认偏向桌面，避免桌面用户 flash。
 */
function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = React.useState(true);

  React.useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(DESKTOP_QUERY);
    setIsDesktop(mql.matches);
    const listener = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mql.addEventListener("change", listener);
    return () => mql.removeEventListener("change", listener);
  }, []);

  return isDesktop;
}

/**
 * 用 React context 把"当前 dialog 走哪个分支"广播给子组件，
 * 避免每个 ResponsiveDialog* 子组件各自调一次 useIsDesktop（性能 + 一致性）。
 *
 * 子组件 mount 时如果发现拿不到 context（比如调用方忘了用 ResponsiveDialog
 * 包），fallback 到 useIsDesktop 自查；既不会崩也不会强一致，开发期忘了能
 * 看出问题。
 */
type Variant = "dialog" | "drawer";
const VariantContext = React.createContext<Variant | null>(null);

function useVariant(): Variant {
  const ctx = React.useContext(VariantContext);
  const fallback = useIsDesktop();
  if (ctx) return ctx;
  return fallback ? "dialog" : "drawer";
}

// ──────────────────── Root ────────────────────

type RootProps = {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
};

export function ResponsiveDialog({ children, ...props }: RootProps) {
  const isDesktop = useIsDesktop();
  const variant: Variant = isDesktop ? "dialog" : "drawer";

  return (
    <VariantContext.Provider value={variant}>
      {variant === "dialog" ? (
        <Dialog {...props}>{children}</Dialog>
      ) : (
        // vaul 的 shouldScaleBackground 会把背景轻微缩放露出 drawer，移动端 native 感
        <Drawer.Root {...props} shouldScaleBackground>
          {children}
        </Drawer.Root>
      )}
    </VariantContext.Provider>
  );
}

// ──────────────────── Trigger ────────────────────

export const ResponsiveDialogTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { asChild?: boolean }
>(({ asChild, ...props }, ref) => {
  const variant = useVariant();
  if (variant === "dialog") {
    return <DialogTrigger ref={ref} asChild={asChild} {...props} />;
  }
  return <Drawer.Trigger ref={ref} asChild={asChild} {...props} />;
});
ResponsiveDialogTrigger.displayName = "ResponsiveDialogTrigger";

// ──────────────────── Content ────────────────────

type ContentProps = React.HTMLAttributes<HTMLDivElement> & {
  /** Drawer 模式下的最小高度比例，默认 50% 视口；想全屏给 100% */
  drawerHeight?: string;
};

export const ResponsiveDialogContent = React.forwardRef<
  HTMLDivElement,
  ContentProps
>(({ className, children, drawerHeight, ...props }, ref) => {
  const variant = useVariant();
  if (variant === "dialog") {
    return (
      <DialogContent ref={ref} className={className} {...props}>
        {children}
      </DialogContent>
    );
  }
  return (
    <Drawer.Portal>
      <Drawer.Overlay className="fixed inset-0 z-50 bg-black/50" />
      <Drawer.Content
        ref={ref}
        className={cn(
          // 底部上滑面板：圆角 + max 高度避免占满全屏挡掉 url bar
          "fixed inset-x-0 bottom-0 z-50 mt-24 flex flex-col rounded-t-[10px] border bg-background",
          drawerHeight ?? "max-h-[90vh]",
          className,
        )}
        // 透传剩余 props（id / data-* / aria-* / inline style / event handlers）
        // 让两个分支真正"drop-in 互换"，避免迁移时桌面正常移动端静默失效。
        {...props}
      >
        {/* 顶部把手：让用户看出来「这是个可下拉关闭的面板」 */}
        <div className="mx-auto mt-3 h-1.5 w-12 shrink-0 rounded-full bg-muted" />
        {/* 内容区：scroll-y 自带，避免 dialog 内长内容溢出屏外 */}
        <div className="flex-1 overflow-y-auto p-6 pt-4">{children}</div>
      </Drawer.Content>
    </Drawer.Portal>
  );
});
ResponsiveDialogContent.displayName = "ResponsiveDialogContent";

// ──────────────────── Header / Footer / Title / Description / Close ────────────────────
//
// 桌面端直接复用 shadcn DialogHeader 等；移动端 Drawer 没必要额外语义包装，
// 直接用 div + Drawer.Title 就行。

export function ResponsiveDialogHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  const variant = useVariant();
  if (variant === "dialog") {
    return <DialogHeader className={className} {...props} />;
  }
  return (
    <div
      className={cn("flex flex-col gap-1.5 text-left", className)}
      {...props}
    />
  );
}

export function ResponsiveDialogFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  const variant = useVariant();
  if (variant === "dialog") {
    return <DialogFooter className={className} {...props} />;
  }
  return (
    <div
      // 移动端按钮纵向排列，主操作在上 / 取消在下；最重要的"主按钮"应该出现
      // 在 children 列表的第一项（视觉最显眼），调用方注意顺序。
      className={cn("mt-4 flex flex-col gap-2", className)}
      {...props}
    />
  );
}

export const ResponsiveDialogTitle = React.forwardRef<
  HTMLHeadingElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => {
  const variant = useVariant();
  if (variant === "dialog") {
    return <DialogTitle ref={ref} className={className} {...props} />;
  }
  return (
    <Drawer.Title
      ref={ref}
      className={cn(
        "text-lg font-semibold leading-none tracking-tight",
        className,
      )}
      {...props}
    />
  );
});
ResponsiveDialogTitle.displayName = "ResponsiveDialogTitle";

export const ResponsiveDialogDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => {
  const variant = useVariant();
  if (variant === "dialog") {
    return <DialogDescription ref={ref} className={className} {...props} />;
  }
  return (
    <Drawer.Description
      ref={ref}
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
});
ResponsiveDialogDescription.displayName = "ResponsiveDialogDescription";

export const ResponsiveDialogClose = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { asChild?: boolean }
>(({ asChild, className, children, ...props }, ref) => {
  const variant = useVariant();
  if (variant === "dialog") {
    return (
      <DialogClose ref={ref} asChild={asChild} className={className} {...props}>
        {children}
      </DialogClose>
    );
  }
  return (
    <Drawer.Close ref={ref} asChild={asChild} className={className} {...props}>
      {children}
    </Drawer.Close>
  );
});
ResponsiveDialogClose.displayName = "ResponsiveDialogClose";

/**
 * 可选：右上角小 X 关闭按钮（Drawer 模式不显示，因为 Drawer 已经能下拉关闭+
 * 顶部有把手提示；强行加 X 反而冗余）。
 */
export function ResponsiveDialogXClose() {
  const variant = useVariant();
  if (variant !== "dialog") return null;
  return (
    <DialogClose className="absolute right-4 top-4 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none">
      <X className="size-4" />
      <span className="sr-only">关闭</span>
    </DialogClose>
  );
}
