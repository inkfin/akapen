import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { z } from "zod";

import authConfig from "./auth.config";
import { prisma } from "./db";

// 只支持邮箱 + 密码。学生不登录（产品决策 A），无 OAuth、无邀请码。
// 想加新老师？跑 `npm run create-user`（见 scripts/create-user.ts）。

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

/**
 * Stale-JWT 防御的节流间隔（毫秒）。
 *
 * 为什么不每次都查 DB：jwt callback 在每个 server-side `auth()` 调用都会跑，
 * 每张页面 SSR、每个 server action、每条 API 路由都会触发；每次再 +1 次
 * sqlite lookup（即使带索引 ~50µs）累积起来 stage 大量没必要的 IO。
 *
 * 为什么也不能太久：DB 重建 / 备份恢复后老师手里的 stale JWT 在这个窗口
 * 内仍能"成功"通过认证，但在所有 `prisma.xxx.create({ ownerId })` 上触发
 * P2003 FK violation —— 老师只看到"创建失败"，根本不知道要重登。5 分钟是
 * 操作友好（不会动不动跳走）+ 故障可见（5 分钟内自动断）的折中。
 */
const STALE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  callbacks: {
    // 复用 authConfig 的 authorized + session callback；只覆盖 jwt
    ...authConfig.callbacks,
    async jwt({ token, user }) {
      // 首次签发：把 user.id / user.role 塞进 token（沿用原 auth.config 逻辑，
      // 这里没法直接 await 调那边的 jwt callback，所以重写一份；改动时记得
      // 跟 auth.config.ts 那边的 jwt callback 同步）
      if (user) {
        token.userId = user.id;
        token.role = (user as { role?: string }).role ?? "teacher";
        token.lastVerifiedAt = Date.now();
      }

      // 防御 stale JWT：现网遇到过 web.db 备份恢复 / 重建后，老师浏览器
      // cookie 里 token.userId 在新 DB 里不存在；任何 create 操作触发 P2003
      // FK violation，老师只看到"创建失败"。这里每 5 分钟（节流，避免每次
      // auth() 都查 DB）核对一次 userId 仍在 DB 里，不在则 return null →
      // NextAuth v5 会清 session → 下次请求 middleware redirect 到 /login。
      const lastVerified = (token.lastVerifiedAt as number | undefined) ?? 0;
      const userId = token.userId as string | undefined;
      if (userId && Date.now() - lastVerified > STALE_CHECK_INTERVAL_MS) {
        try {
          const exists = await prisma.user.findUnique({
            where: { id: userId },
            select: { id: true },
          });
          if (!exists) return null;
          token.lastVerifiedAt = Date.now();
        } catch {
          // DB 临时不可用（连接池满 / 短暂 down）：放行，避免 false
          // negative 把所有用户踢下线。下一次 auth() 还是会再次尝试。
          return token;
        }
      }
      return token;
    },
  },
  providers: [
    Credentials({
      credentials: {
        email: { label: "邮箱", type: "email" },
        password: { label: "密码", type: "password" },
      },
      async authorize(credentials) {
        const parsed = credentialsSchema.safeParse(credentials);
        if (!parsed.success) return null;
        const { email, password } = parsed.data;

        const user = await prisma.user.findUnique({ where: { email } });
        if (!user) return null;

        const ok = await bcrypt.compare(password, user.passwordHash);
        if (!ok) return null;

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
        };
      },
    }),
  ],
});
