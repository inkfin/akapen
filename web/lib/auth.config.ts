import type { NextAuthConfig } from "next-auth";

// 这份 config 是 edge-safe 的子集（middleware.ts 在 edge runtime 里用它）。
// 真正的 Credentials provider + bcrypt 在 lib/auth.ts 里追加 —— 那俩都是 Node-only。
//
// 设计约束（NextAuth v5 已知）：
// - middleware 走 edge runtime → 不能 import bcryptjs / @prisma/client
// - 所以 providers: [] 留在这里，authorized() 只判断 token 是否存在
// - 拒绝访问的回调通过 redirect("/login") 由 middleware/服务器组件统一处理

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
      if (path.startsWith("/u/")) return true;
      if (path.startsWith("/api/health")) return true;
      if (path.startsWith("/api/webhooks/")) return true;
      if (path.startsWith("/api/auth/")) return true;
      // 其他全部要登录
      return !!auth?.user;
    },
    jwt({ token, user }) {
      // 首次签发：把 user.id / user.role 塞进 token
      if (user) {
        token.userId = user.id;
        token.role = user.role ?? "teacher";
      }
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
