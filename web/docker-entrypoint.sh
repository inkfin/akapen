#!/bin/sh
set -e

# 应用 Prisma migrations。第一次启动会建所有表；后续启动若 schema 没变则无操作。
# 这里 *不* 退出失败：prisma migrate deploy 在 SQLite 文件被 readonly 挂载等异常情
# 况下会非零退出，但 Next.js 服务本身仍可以以"只读"模式起来给老师 debug。
echo "[entrypoint] DATABASE_URL=$DATABASE_URL"
echo "[entrypoint] running prisma migrate deploy..."
node ./node_modules/prisma/build/index.js migrate deploy || {
  echo "[entrypoint] WARNING: prisma migrate deploy failed; starting anyway"
}

echo "[entrypoint] launching: $*"
exec "$@"
