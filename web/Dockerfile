# syntax=docker/dockerfile:1.7

# ───────────────────────────────────────────────────────────────────────────
# 三阶段构建：deps（装包）/ build（编译）/ runtime（最小运行时）
# 选 alpine 镜像基础 + 标准化用户 web(uid=1000)，与 backend 容器对齐。
# 镜像约 ~280MB（不大但比 plain node:slim 还小，因 next standalone 已经裁过了）。
# ───────────────────────────────────────────────────────────────────────────

# ---- 1. deps：纯装依赖，命中后续 build 用 ----
FROM node:22-alpine AS deps
WORKDIR /app

# 只把 package.json + lock 复制过来，让这一层 cache 命中能省到秒级
COPY package.json package-lock.json* .npmrc* ./
RUN npm ci --no-audit --no-fund

# ---- 2. build：跑 prisma generate + next build → standalone output ----
FROM node:22-alpine AS build
WORKDIR /app

# next build 期间会 fetch 在线 telemetry，关掉
ENV NEXT_TELEMETRY_DISABLED=1
# build 时 DB / API key 没有也得能跑（next 只需要让代码导入路径解析过）
ENV DATABASE_URL=file:./placeholder.db
ENV AUTH_SECRET=build-time-placeholder-32-chars-aaaa
ENV IMAGE_URL_SECRET=build-time-placeholder-32-chars-bb
ENV WEBHOOK_SECRET=build-time-placeholder-32-chars-cc
ENV AKAPEN_BASE_URL=http://placeholder
ENV AKAPEN_API_KEY=placeholder
ENV WEB_PUBLIC_BASE_URL=http://placeholder

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# package.json 的 build 脚本已经包含 prisma generate
RUN npm run build

# 把 prisma CLI + 引擎从 build stage 单独捞出来给 runtime 用。
# standalone trace 不会自动包含 prisma CLI（它不是 import 进来的，是命令行工具）。
# ~80MB 但能让我们在 entrypoint 里跑 `prisma migrate deploy` 自动建表。
RUN mkdir -p /tmp/prisma-pack \
 && cp -R /app/node_modules/prisma /tmp/prisma-pack/prisma \
 && cp -R /app/node_modules/@prisma /tmp/prisma-pack/@prisma

# ---- 3. runtime：最小镜像 ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# wget 用于 HEALTHCHECK；libstdc++ / openssl 是 prisma 的依赖
RUN apk add --no-cache wget openssl libstdc++

# 与 backend 容器一致的非 root 用户（uid=1000），给 host volume 挂载用
RUN addgroup -S -g 1000 web && adduser -S -D -u 1000 -G web web

# Next.js standalone：自带 server.js 入口和必要的 node_modules
COPY --from=build --chown=web:web /app/.next/standalone ./
# standalone 不包括 .next/static 和 public，要单独拷
COPY --from=build --chown=web:web /app/.next/static ./.next/static
COPY --from=build --chown=web:web /app/public ./public

# Prisma 运行时所需
COPY --from=build --chown=web:web /app/prisma ./prisma
COPY --from=build --chown=web:web /tmp/prisma-pack/prisma ./node_modules/prisma
COPY --from=build --chown=web:web /tmp/prisma-pack/@prisma ./node_modules/@prisma

# 挂数据卷的目录预创建好（再 chown 给 web）
RUN mkdir -p /app/data/uploads && chown -R web:web /app/data

COPY --chown=web:web docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

USER web
EXPOSE 3000

# Docker 健康检查：只 ping /api/health（不查 DB），避免 DB cold open 时挂掉
HEALTHCHECK --interval=20s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- --spider http://127.0.0.1:3000/api/health || exit 1

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
