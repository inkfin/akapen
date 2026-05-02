import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { z } from "zod";

import authConfig, { applyUserToToken } from "./auth.config";
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

/**
 * stale-check 失败时的退避间隔（毫秒）。
 *
 * DB 临时不可用（连接池满 / 短暂 down / 部署窗口）会让 prisma.findUnique
 * 抛错。如果 catch 里直接 return token 不更新计时器，节流条件 `now -
 * lastVerifiedAt > INTERVAL` 始终成立 → 每次 auth() 都立刻再发一次 query
 * → 故障期形成请求风暴，DB 雪上加霜。
 *
 * 这里把 lastVerifiedAt 推到 `now - INTERVAL + RETRY_BACKOFF`，让下次允许
 * 检查的时间被推迟 30 秒。trade-off：故障恢复后最迟 30s 内就重新核对，
 * 同时整个故障期把 stale-check 的 query 量限制在 1/30s/conn。
 */
const STALE_CHECK_RETRY_BACKOFF_MS = 30 * 1000;

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  callbacks: {
    // 复用 authConfig 的 authorized + session callback；只覆盖 jwt
    ...authConfig.callbacks,
    async jwt({ token, user }) {
      // 首次签发：用 auth.config.ts 共享的 helper（保持 edge / node 路径一致）。
      // NextAuth v5 callbacks merge 是浅覆盖、没法 await base 版本，所以这里
      // 必须手动调一次；helper 抽出来避免两处实现漂移。
      applyUserToToken(token, user);

      // 防御 stale JWT：现网遇到过 web.db 备份恢复 / 重建后，老师浏览器
      // cookie 里 token.userId 在新 DB 里不存在；任何 create 操作触发 P2003
      // FK violation，老师只看到"创建失败"。这里每 5 分钟（节流，避免每次
      // auth() 都查 DB）核对一次 userId 仍在 DB 里，不在则 return null →
      // NextAuth v5 会清 session → 下次请求 middleware redirect 到 /login。
      const lastVerified = token.lastVerifiedAt ?? 0;
      const userId = token.userId;
      if (userId && Date.now() - lastVerified > STALE_CHECK_INTERVAL_MS) {
        try {
          const exists = await prisma.user.findUnique({
            where: { id: userId },
            select: { id: true },
          });
          if (!exists) return null;
          token.lastVerifiedAt = Date.now();
        } catch (err) {
          // DB 临时不可用：放行避免 false negative 把所有用户踢下线，但
          // 必须更新 lastVerifiedAt 让"30s 后才允许下次检查"，否则节流条件
          // 每次 auth() 都满足 → 故障期请求风暴。
          // 推到 `now - INTERVAL + RETRY_BACKOFF` 等价于"下次检查 30s 后到期"。
          token.lastVerifiedAt =
            Date.now() - STALE_CHECK_INTERVAL_MS + STALE_CHECK_RETRY_BACKOFF_MS;
          // eslint-disable-next-line no-console
          console.warn(
            "[auth.jwt] stale-userId check failed, will retry in",
            STALE_CHECK_RETRY_BACKOFF_MS,
            "ms:",
            err instanceof Error ? err.message : String(err),
          );
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
