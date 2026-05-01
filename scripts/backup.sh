#!/usr/bin/env bash
# akapen 数据备份脚本（部署在 ECS 上 cron 定时跑）。
#
# 备的是宿主机的 ./data 和 ./web/data，与 docker-compose.yml 同级。容器只是无状态
# 计算层，删了重启数据不丢；备份 = 备这两个目录。
#
# SQLite 用了 WAL 模式，直接 cp .db 会漏掉 .wal 里的最新写入。这里用 host 上的
# python3（ECS 默认装；可改用 sqlite3 cli）对 .db 做 .backup 在线快照——SQLite WAL
# 模式天然支持「N 读 + 1 写」并发，host 当读者去做 .backup，完全不会撞容器里跑的写。
#
# 用法：
#   1) 一次性手动备份到 /tmp：
#        ./scripts/backup.sh
#   2) 备完顺手上传 OSS（先 ossutil config）：
#        BACKUP_OSS_BUCKET=oss://my-bucket/akapen ./scripts/backup.sh
#   3) cron 每天凌晨 4 点跑：
#        0 4 * * * cd ~/docker/akapen && \
#          BACKUP_OSS_BUCKET=oss://my-bucket/akapen ./scripts/backup.sh \
#          >> data/logs/backup.log 2>&1
#
# 可选 env：
#   AKAPEN_ROOT       项目根目录（默认 = 脚本同级父目录）
#   BACKUP_DIR        本机存放备份 tar 的目录（默认 /tmp）
#   BACKUP_KEEP_DAYS  本机保留天数（默认 3 天，再老的自动清；OSS 自己设生命周期）
#   BACKUP_OSS_BUCKET 上传到 OSS 的 bucket 路径（如 oss://akapen/backup）；不设则只在本机
#   OSSUTIL           ossutil 可执行路径（默认从 PATH 找）
#   PYTHON            python 解释器（默认 python3）

set -euo pipefail

# ───── 配置 ─────

ROOT=${AKAPEN_ROOT:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}
BACKUP_DIR=${BACKUP_DIR:-/tmp}
BACKUP_KEEP_DAYS=${BACKUP_KEEP_DAYS:-3}
BACKUP_OSS_BUCKET=${BACKUP_OSS_BUCKET:-}
OSSUTIL=${OSSUTIL:-ossutil}
PYTHON=${PYTHON:-python3}

cd "$ROOT"

TS=$(date +%Y%m%d_%H%M%S)
TARBALL="${BACKUP_DIR}/akapen_${TS}.tgz"

red()    { printf "\033[31m%s\033[0m\n" "$*"; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
blue()   { printf "\033[34m%s\033[0m\n" "$*"; }

# ───── 1. SQLite 在线快照（host python） ─────
#
# python stdlib 的 sqlite3 模块自带 connection.backup() 接口。等价于
# `sqlite3 src.db ".backup target.db"` 但不依赖宿主装 sqlite3 cli。

snapshot_sqlite_py() {
  local src=$1
  local dst=$2

  if [[ ! -f "$src" ]]; then
    yellow "  · 跳过：$src 不存在（首次部署 / 服务还没起？）"
    return 0
  fi

  if ! command -v "$PYTHON" >/dev/null 2>&1; then
    red "  ✗ $PYTHON 没装，无法做一致快照；改用 cp 兜底（可能丢失 WAL 最新写入）"
    cp "$src" "$dst"
    return 0
  fi

  "$PYTHON" - "$src" "$dst" <<'PY'
import sqlite3
import sys

src_path, dst_path = sys.argv[1], sys.argv[2]
src = sqlite3.connect(f"file:{src_path}?mode=ro", uri=True, timeout=30.0)
dst = sqlite3.connect(dst_path)
try:
    with dst:
        src.backup(dst)
finally:
    src.close()
    dst.close()
PY
}

blue "→ 在线快照 SQLite"

snapshot_sqlite_py "data/grading.db"      "data/grading.db.bak"
snapshot_sqlite_py "web/data/web.db"      "web/data/web.db.bak"

green "  ✓ .bak 已生成"

# ───── 2. tar 打包 ─────

blue "→ tar -czf $TARBALL"

# 把 .bak 一起打包；恢复时 mv .bak 回原名即可。.db-shm/.db-wal 不入包（.bak 已经
# 是合并完的快照）；logs 和老 records_* 也跳过省空间。
tar -czf "$TARBALL" \
  --exclude='*.db-shm' \
  --exclude='*.db-wal' \
  --exclude='uploads/.tmp_*' \
  --exclude='logs/*.log*' \
  --exclude='records_*' \
  data \
  web/data

green "  ✓ $(du -h "$TARBALL" | cut -f1)  →  $TARBALL"

# ───── 3. 清理临时 .bak ─────

rm -f data/grading.db.bak web/data/web.db.bak

# ───── 4. 上传 OSS（可选） ─────

if [[ -n "$BACKUP_OSS_BUCKET" ]]; then
  blue "→ ossutil cp → $BACKUP_OSS_BUCKET/"
  if ! command -v "$OSSUTIL" >/dev/null 2>&1; then
    red "  ✗ ossutil 没装。本机已留备份在 $TARBALL；先 wget 阿里云 ossutil 装好再补传。"
  else
    "$OSSUTIL" cp -f "$TARBALL" "${BACKUP_OSS_BUCKET}/akapen_${TS}.tgz"
    green "  ✓ 已上传到 ${BACKUP_OSS_BUCKET}/akapen_${TS}.tgz"
  fi
fi

# ───── 5. 清理本机老备份 ─────

blue "→ 清理 ${BACKUP_KEEP_DAYS} 天前的本机备份"
find "$BACKUP_DIR" -maxdepth 1 -name 'akapen_*.tgz' -type f -mtime "+${BACKUP_KEEP_DAYS}" -print -delete | sed 's/^/  removed: /' || true

green "════════════════════════════════════════"
green "备份完成: $TARBALL"
green "恢复办法：tar -xzf <tar>; mv data/grading.db.bak data/grading.db;"
green "         mv web/data/web.db.bak web/data/web.db;  docker compose up -d"
green "════════════════════════════════════════"
