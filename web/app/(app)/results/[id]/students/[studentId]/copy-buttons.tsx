"use client";

import { useState } from "react";
import { Check, Copy, Printer } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

/**
 * 通用复制按钮：把 prop 里的文本写入剪贴板，1.5s 内显示 Check 图标做 affordance。
 *
 * 注意：text 必须是 string（或可序列化的 prop）—— Next.js 不允许 server component
 * 把函数 prop 传给 client component。需要的拼接已经在 server 端预编好。
 *
 * 用 navigator.clipboard.writeText —— 在 https / localhost 都可用；
 * 老 IE / 不安全 origin 会拒绝，这里不做兜底（老师不会用 IE 改作业）。
 */
export function CopyButton({
  text,
  label,
  variant = "outline",
  size = "sm",
}: {
  text: string;
  label: string;
  variant?: React.ComponentProps<typeof Button>["variant"];
  size?: React.ComponentProps<typeof Button>["size"];
}) {
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success(`${label}已复制（${text.length} 字）`);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      toast.error(`复制失败：${(e as Error).message}`);
    }
  }

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      onClick={onCopy}
      aria-label={`复制${label}`}
    >
      {copied ? (
        <Check className="size-4 text-emerald-600" />
      ) : (
        <Copy className="size-4" />
      )}
      {label}
    </Button>
  );
}

/**
 * 调用 window.print() 让浏览器打印当前页面 / 导 PDF。
 * 单独写一个 client 组件而不是 inline `javascript:` URL —— 后者过 ESLint 会被骂，
 * 且 CSP 严格的环境会被拦。
 */
export function PrintButton() {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => window.print()}
      aria-label="打印为 PDF（浏览器原生）"
    >
      <Printer className="size-4" /> 打印 / PDF
    </Button>
  );
}
