import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn/ui 标配 className 合并：clsx 处理条件逻辑 + tailwind-merge 去冲突。 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
