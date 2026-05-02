// 扩展 NextAuth 默认 Session/User，把我们的 role + id 注入到 session.user。
// 不会引入运行时代码，只增类型。

import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface User {
    role?: string;
  }

  interface Session {
    user: {
      id: string;
      role: string;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    userId?: string;
    role?: string;
    /**
     * 上次成功验证 `userId` 仍存在 DB（或刚签发）的时间戳（ms）。
     * 给 lib/auth.ts 的 stale-userId 节流用。
     */
    lastVerifiedAt?: number;
  }
}
