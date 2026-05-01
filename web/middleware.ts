import NextAuth from "next-auth";

import authConfig from "./lib/auth.config";

// edge runtime 中间件：所有非 /api、非 /u、非 /_next、非 favicon 的请求过这里。
// 由 lib/auth.config.ts 里 authorized() 决定放行还是 302 → /login。
export const { auth: middleware } = NextAuth(authConfig);

export const config = {
  matcher: ["/((?!api|u|_next/static|_next/image|favicon.ico).*)"],
};
