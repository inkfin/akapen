"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

// 局部 QueryClientProvider —— 只在批改大盘页用到，没必要塞进根 layout 给所有页面背运行时成本。
export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // 失焦后不刷新（老师点别的窗口回来不刷掉本地选择状态）
            refetchOnWindowFocus: false,
            // 网络断了 1s 退避试 2 次
            retry: 2,
            retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10000),
            staleTime: 0,
          },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
