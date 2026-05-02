import type { NextAuthConfig, User } from "next-auth";
import type { JWT } from "next-auth/jwt";

// 这份 config 是 edge-safe 的子集（middleware.ts 在 edge runtime 里用它）。
// 真正的 Credentials provider + bcrypt 在 lib/auth.ts 里追加 —— 那俩都是 Node-only。
//
// 设计约束（NextAuth v5 已知）：
// - middleware 走 edge runtime → 不能 import bcryptjs / @prisma/client
// - 所以 providers: [] 留在这里，authorized() 只判断 token 是否存在
// - 拒绝访问的回调通过 redirect("/login") 由 middleware/服务器组件统一处理

/**
 * 首次签发时把 user.id / user.role 写进 JWT token。
 *
 * 抽成共享 helper 是因为 `lib/auth.ts` 的 jwt callback 必须重写整个函数（要
 * 加 stale-userId 检查），NextAuth v5 的 callbacks merge 是浅覆盖、没法 await
 * base 版本——如果"首次签发"逻辑两边各拷一份，很容易漂移（field 名字 / 默认
 * 值 / 类型断言），出问题时排查极难。这里集中一处既保证 edge 路径（middleware
 * 只走 auth.config）和 node 路径（server action / route handler 走 lib/auth）
 * 行为一致，也让以后加新字段（比如 displayName / themePref）只需改一处。
 *
 * 必须保持 edge-safe：禁止 import prisma / bcrypt / 任何 Node-only 模块。
 */
export function applyUserToToken(token: JWT, user: User | undefined): void {
  if (!user) return;
  token.userId = user.id;
  token.role = user.role ?? "teacher";
  // 给 stale-userId 检查的节流计时基准（详见 lib/auth.ts:jwt）。即便没装 stale
  // check 的 edge 路径也不影响——只是个未读的 number 字段。
  token.lastVerifiedAt = Date.now();
}

const authConfig = {
  pages: {
    signIn: "/login",
  },
  // session 走 JWT —— 因为 Credentials provider 用 DB session 不被 NextAuth 支持，
  // 所以我们靠 JWT 把 userId / role 透传到所有 server component。
  session: { strategy: "jwt" },
  callbacks: {
    authorized({ auth, request: { nextUrl } }) {
      const path = nextUrl.pathname;
      // 公共：登录页本身、签名图片 URL、健康检查、NextAuth 自家路由
      if (path === "/login") return true;
      // /logout 必须无条件放行——stale-JWT 场景下用户已被 jwt callback
      // 清 session（auth?.user 为 null），还得让 /logout 的 server component
      // 跑完 signOut 把 cookie 也清干净，否则用户会反复"看似已登录但所有
      // 操作都失败"。
      if (path === "/logout") return true;
      if (path.startsWith("/u/")) return true;
      if (path.startsWith("/api/health")) return true;
      if (path.startsWith("/api/webhooks/")) return true;
      if (path.startsWith("/api/auth/")) return true;
      // 其他全部要登录
      return !!auth?.user;
    },
    jwt({ token, user }) {
      applyUserToToken(token, user);
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = (token.userId as string) ?? "";
        session.user.role = (token.role as string) ?? "teacher";
      }
      return session;
    },
  },
  providers: [],
} satisfies NextAuthConfig;

export default authConfig;
