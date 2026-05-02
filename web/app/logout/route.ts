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
 * 同源校验：
 * - 拒绝跨站请求（Sec-Fetch-Site === "cross-site" / "same-site" 之外的
 *   Origin host）—— 防止恶意第三方站点 `<img src="//akapen/logout">` 静默
 *   把老师退出。
 * - 允许 `Sec-Fetch-Site: none`（地址栏直接输入 / 书签）和 `same-origin`
 *   （站内点击 / form submit）。
 * - 老浏览器没 Sec-Fetch-Site：fallback 到 Origin / Referer host 比对，
 *   两者都没有则按"地址栏输入"放行（与 fetch-site=none 同语义）。
 */
function isSameSiteRequest(req: Request): boolean {
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite) {
    // "none" = 地址栏 / 书签；"same-origin" = 同源 fetch；"same-site" = 同
    // eTLD+1（罕见，比如 a.example.com → b.example.com）。其他值（"cross-site"
    // / 未知）一律拒。
    return (
      fetchSite === "none" ||
      fetchSite === "same-origin" ||
      fetchSite === "same-site"
    );
  }
  // 老浏览器 fallback
  const origin = req.headers.get("origin") ?? req.headers.get("referer");
  if (!origin) return true; // 视同地址栏直接输入
  try {
    return new URL(origin).host === new URL(req.url).host;
  } catch {
    return false;
  }
}

export async function GET(req: Request) {
  if (!isSameSiteRequest(req)) {
    return new NextResponse("forbidden", { status: 403 });
  }
  await signOut({ redirect: false });
  return NextResponse.redirect(new URL("/login?from=logout", req.url));
}

export const POST = GET;
