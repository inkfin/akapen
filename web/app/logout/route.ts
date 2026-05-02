import { NextResponse } from "next/server";

import { signOut } from "@/lib/auth";

/**
 * 强制退出登录的稳定 URL —— 老师即便没找到 UI 上的"退出"按钮，也能直接
 * 在浏览器地址栏敲 `/logout` 退出。
 *
 * 为什么不直接让用户访问 `/api/auth/signout`：NextAuth v5 的那条 GET URL
 * 不再渲染确认页（v4 才有），实际只支持 POST + CSRF token，老师 GET 进
 * 去会看到 404 / 空白页，体验差。
 *
 * 为什么用 route handler 而不是 page.tsx：NextAuth 的 `signOut()` 必须能
 * 写 cookies（清掉 session token）。server component 里 `cookies()` 是
 * readonly 的，调 signOut 会抛错；route handler 的 GET / POST 上下文
 * 是 fully writable 的。
 *
 * GET 退出的安全考量：第三方站点 `<img src="//akapen/logout">` 能静默
 * 把老师退出。退出操作风险有限（最坏重登），先接受这个 trade-off；将来
 * 想加 CSRF token 再改 POST + form submit。
 *
 * `redirect: false` + 手动 NextResponse.redirect：让我们能控制 redirect URL
 * 带上 `?from=logout` 提示登录页 "刚刚退出过"（虽然现在登录页还没用这个
 * 参数显示什么，预留 hook）。
 */
export async function GET(req: Request) {
  await signOut({ redirect: false });
  return NextResponse.redirect(new URL("/login?from=logout", req.url));
}

export const POST = GET;
