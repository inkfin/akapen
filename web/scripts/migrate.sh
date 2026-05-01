#!/usr/bin/env bash
# 包装 prisma migrate dev，避免几个常见坑（详见 AGENTS.md §12.2.5）。
#
# 改了 web/prisma/schema.prisma 后跑：
#
#     ./web/scripts/migrate.sh --name <短描述>
#
# 等价于在 web/ 目录跑 `npx prisma migrate dev --name xxx --skip-seed`，但是：
#
# 1. **强制绝对 DATABASE_URL** —— 覆盖 web/.env 里 `file:/app/data/web.db`（容器内
#    路径），用宿主机绝对路径 `file:<repo>/web/data/web.db` 指向真实运行时 DB。
#    不写绝对路径的话，prisma SQLite 会按 `schema.prisma` 所在目录解析
#    `file:./data/web.db`，结果跑去 `web/prisma/data/web.db` 创建 stray DB，
#    migration 应用到错的 DB 上 —— 真正的 web/data/web.db 没动，启动后查不一致。
#
# 2. **stray DB 防呆** —— 一上来就检查 web/prisma/data/ 是不是已经被某次错位
#    跑出来了。检测到就拒绝继续，要求先 rm -rf 干净。
#
# 3. **强制 --name** —— 没名字 prisma 会进交互式问，agent 跑就卡死了。
#
# 不想用 wrapper 直接 npx prisma migrate dev 也行，但要自己负责 DATABASE_URL
# 是绝对路径、且不会落到 web/prisma/data/。
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$ROOT/web"

red()    { printf "\033[31m%s\033[0m\n" "$*" >&2; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
blue()   { printf "\033[34m%s\033[0m\n" "$*"; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }

# ───── 1. 检查 stray DB ─────

if [[ -e "$ROOT/web/prisma/data" || -e "$ROOT/web/prisma/dev.db" || -e "$ROOT/web/prisma/dev.db-journal" ]]; then
  red "发现 web/prisma/ 下有 stray DB 文件 —— 是上次有人裸跑 npx prisma migrate dev"
  red "用了相对路径 file:./data/web.db 留下的痕迹（被 prisma 解析成 web/prisma/data/）。"
  red ""
  red "清理后再跑："
  red "  rm -rf web/prisma/data web/prisma/dev.db web/prisma/dev.db-journal"
  exit 1
fi

# ───── 2. 检查参数 ─────

if [[ $# -eq 0 ]] || [[ "${1:-}" != "--name" ]] || [[ -z "${2:-}" ]]; then
  red "用法：./web/scripts/migrate.sh --name <短描述>"
  red ""
  red "  例：./web/scripts/migrate.sh --name add_question_difficulty"
  red ""
  red "短描述用 snake_case，会变成 migrations/<时间戳>_<描述>/migration.sql 的目录名。"
  exit 1
fi

# ───── 3. 强制绝对 DATABASE_URL ─────

DB_FILE="$ROOT/web/data/web.db"
if [[ ! -d "$ROOT/web/data" ]]; then
  yellow "web/data/ 不存在，先建一下"
  mkdir -p "$ROOT/web/data"
fi

export DATABASE_URL="file:$DB_FILE"

blue "→ DATABASE_URL = $DATABASE_URL"
blue "→ migrate dev --name $2 --skip-seed"
echo

# ───── 4. 跑 prisma migrate dev ─────
#
# 注意：不能传 --create-only —— 那会只生成文件不应用，本机 DB 还是老 schema，
# 下次 web 容器启动 migrate deploy 才追上。dev 模式就是要"立刻应用 + 立刻反馈"。

npx prisma migrate dev --skip-seed "$@"

# ───── 5. 收尾提示 ─────

echo
green "════════════════════════════════════════"
green "  migration 已生成 + 本地 DB 已应用"
green "════════════════════════════════════════"
echo
echo "下一步："
echo "  1. 检查 web/prisma/migrations/<新文件夹>/migration.sql 内容是不是预期"
echo "  2. 重启 web 容器让它重新加载 prisma client："
echo "       docker compose restart web"
echo "  3. 提交：git add web/prisma/{schema.prisma,migrations/}"
echo "  4. 现网升级时 web/docker-entrypoint.sh 会自动跑 migrate deploy"
