// NextAuth v5 把所有 /api/auth/* 路由都挂到这一个 catch-all 上。
// signin / signout / callback / session / csrf 都由这里处理。

import { handlers } from "@/lib/auth";

export const { GET, POST } = handlers;
