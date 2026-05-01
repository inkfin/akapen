#!/usr/bin/env bash
# 一键发布脚本：本机 build + push 镜像到 ACR，再把"部署清单"上传到 GitHub Release。
#
# 为什么不让 GitHub Actions 来做：runner 限制紧 + 阿里云 ACR 推送有时网络抖。
# 本机 build 然后只把"小尾巴 tar 包 + 文档"传到 GitHub，让运维同学有一个稳定的
# 公网 URL 拉部署清单：
#
#   curl -L https://github.com/<owner>/<repo>/releases/latest/download/akapen-deploy.tar.gz | tar -xz
#
# 然后 cp .env.example .env、填 secrets、docker compose up -d 就完事。
#
# 用法：
#   1) 显式版本号（推荐）：
#        ./scripts/release.sh v0.1.0
#   2) 不传 → 自动用 v0.0.0-<git-short-sha>（小修打 patch release 用）：
#        ./scripts/release.sh
#   3) 已经存在的 tag 想覆盖 artifact（重新打包）：
#        REPLACE=1 ./scripts/release.sh v0.1.0
#
# 前置依赖：
#   - gh（GitHub CLI）已 `gh auth login`
#   - docker buildx + ACR 凭据（同 push-acr.sh 的环境变量）
#   - 当前 commit 已 push 到 origin（gh release create 要求 commit 在远端）

set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

# ───── 工具 ─────

red()    { printf "\033[31m%s\033[0m\n" "$*"; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
blue()   { printf "\033[34m%s\033[0m\n" "$*"; }

# ───── 版本号 ─────

VERSION=${1:-}
GIT_SHA=$(git rev-parse --short HEAD)

if [[ -z "$VERSION" ]]; then
  VERSION="v0.0.0-${GIT_SHA}"
  yellow "未指定版本号，用 $VERSION（建议正式发版传 v0.x.y 当参数）"
fi

# 简单校验：必须像 vX.Y.Z 或 vX.Y.Z-something
if [[ ! "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-.+)?$ ]]; then
  red "版本号格式不对：$VERSION（要 vMAJOR.MINOR.PATCH，如 v0.1.0 / v1.2.3-rc1）"
  exit 1
fi

# ───── 工作区检查 ─────

if ! git diff --quiet || ! git diff --cached --quiet; then
  red "工作区有未提交修改，先 commit 再 release。"
  exit 1
fi

# 必须已 push 到 origin —— gh release create 会用当前 commit 做 release target，
# 找不到 commit 会失败。
if ! git fetch origin >/dev/null 2>&1; then
  yellow "fetch origin 失败（无网？），跳过 push 检查"
else
  if [[ -n "$(git log @{u}..HEAD 2>/dev/null || true)" ]]; then
    red "本地有未 push 的 commit，先 git push 再 release"
    exit 1
  fi
fi

# ───── 处理 tag ─────

if git rev-parse "$VERSION" >/dev/null 2>&1; then
  EXISTING_SHA=$(git rev-parse "$VERSION")
  if [[ "$EXISTING_SHA" != "$(git rev-parse HEAD)" ]]; then
    red "tag $VERSION 已经存在，但指向 $EXISTING_SHA（不是当前 HEAD）。"
    red "要么换版本号，要么先 git tag -d $VERSION && git push origin :$VERSION"
    exit 1
  fi
  yellow "tag $VERSION 已存在且指向当前 HEAD —— 跳过 git tag"
else
  blue "→ git tag $VERSION"
  git tag "$VERSION"
  blue "→ git push origin $VERSION"
  git push origin "$VERSION"
fi

# ───── 1. build & push 镜像到 ACR ─────
#
# push-acr.sh 默认会打 :latest + :<git-sha>；TAG=$VERSION 让它额外打 :$VERSION。
# 这样 ACR 上同一个镜像有三个 tag：latest（漂移）、git sha（细粒度）、版本号（人类可读）。

blue "════════════════════════════════════════"
blue "  1/3 build + push 镜像到 ACR"
blue "════════════════════════════════════════"

TAG="$VERSION" "$ROOT/scripts/push-acr.sh"

# ───── 2. 打包部署清单 tar ─────

blue "════════════════════════════════════════"
blue "  2/3 打包部署清单"
blue "════════════════════════════════════════"

STAGE=$(mktemp -d "/tmp/akapen-release-${VERSION//\//_}.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT

# 必带文件
cp docker-compose.yml             "$STAGE/"
cp .env.example                   "$STAGE/"
mkdir -p "$STAGE/web"
cp web/.env.example               "$STAGE/web/"
mkdir -p "$STAGE/scripts"
cp scripts/backup.sh              "$STAGE/scripts/"
chmod +x "$STAGE/scripts/backup.sh"
mkdir -p "$STAGE/docs"
cp docs/DEPLOY_HANDOFF.md         "$STAGE/docs/"

# 把 prod.yml 里的 :latest 替换成 :<version>，让本 artifact 是不可变快照。
# 想要"自动跟最新版"的同学可以改回 :latest（INSTALL.md 里说一句）。
sed "s|:latest|:${VERSION}|g" docker-compose.prod.yml > "$STAGE/docker-compose.prod.yml"

# 现场生成一页纸 INSTALL.md
cat > "$STAGE/INSTALL.md" <<EOF
# akapen ${VERSION} 部署快速开始

> 这个 artifact 是某次发布的**不可变快照**：
> compose 文件里镜像 tag 钉死成 \`:${VERSION}\`，下个 release 出来后这份不会自动更新。
> 想"永远跟最新"，把 \`docker-compose.prod.yml\` 里的 \`:${VERSION}\` 改回 \`:latest\` 即可。

## 1. 取部署文件

\`\`\`bash
mkdir akapen && cd akapen

# 拉这次 release 的部署清单（包含 6 个文件 + 文档）
curl -fL https://github.com/inkfin/akapen/releases/download/${VERSION}/akapen-deploy.tar.gz \\
  | tar -xz
# 或者总是要最新版：
# curl -fL https://github.com/inkfin/akapen/releases/latest/download/akapen-deploy.tar.gz | tar -xz
\`\`\`

## 2. 配 env

\`\`\`bash
cp .env.example .env
cp web/.env.example web/.env

# 用 openssl rand -base64 32 生成 4 个独立随机串：
#   1) backend API_KEYS 的 secret 部分（粘到 .env 的 API_KEYS=akapen:<这串>）
#   2) WEBHOOK_SECRET（.env 和 web/.env 必须填同一个！）
#   3) web AUTH_SECRET
#   4) web IMAGE_URL_SECRET
# DASHSCOPE_API_KEY 找仓库主人要

# 重要：编辑 web/.env 里的 NEXTAUTH_URL，填老师从浏览器实际访问的 URL
#   - 公网 IP 直访：http://<ECS-公网-IP>:3000
#   - 域名 + HTTPS：https://akapen.example.com
\`\`\`

详细每个字段含义见 \`docs/DEPLOY_HANDOFF.md\` §三。

## 3. 准备数据目录 + 登录 ACR

\`\`\`bash
mkdir -p data web/data
sudo chown -R 1000:1000 data web/data    # 容器内进程是 uid 1000

docker login crpi-4noctswoyij0f9rg.cn-shenzhen.personal.cr.aliyuncs.com -u inkfinite
# 提示输密码 → 找仓库主人要 ACR 固定密码
\`\`\`

## 4. 起服务

\`\`\`bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# 验活
curl -fsS http://127.0.0.1:8000/v1/livez
curl -fsS http://127.0.0.1:3000/api/health

# 缩短命令：
echo "alias dcp='docker compose -f docker-compose.yml -f docker-compose.prod.yml'" >> ~/.bashrc
\`\`\`

## 5. 创建第一个老师账号

\`\`\`bash
dcp exec web node scripts/create-user.cjs \\
  --email teacher@example.com --password 'StrongPassword123' --name '王老师'
\`\`\`

打开 \`NEXTAUTH_URL\` 用这套邮箱密码登录。

---

## 升级 / 回滚

- **升级**：拉新 release 的 artifact，覆盖 \`docker-compose.prod.yml\`，然后 \`dcp pull && dcp up -d\`
- **回滚**：拉某个旧版本 release 的 artifact（URL 里换成那个 tag），同样 \`dcp pull && dcp up -d\`

## 备份

\`\`\`bash
# 一次性手动
./scripts/backup.sh

# cron 每天 4 点（建议把 OSS bucket 配上做异地容灾）
crontab -e
# 加：
# 0 4 * * * cd ~/akapen && BACKUP_OSS_BUCKET=oss://my-bucket/akapen ./scripts/backup.sh >> data/logs/backup.log 2>&1
\`\`\`

详细备份 / 恢复见仓库 \`AGENTS.md\` §十三。

## 出问题查 \`docs/DEPLOY_HANDOFF.md\` §九（常见问题表）

EOF

ARTIFACT=/tmp/akapen-deploy.tar.gz
tar -czf "$ARTIFACT" -C "$STAGE" .

green "  ✓ artifact 已生成：$ARTIFACT ($(du -h "$ARTIFACT" | cut -f1))"
echo
echo "  内容："
tar -tzf "$ARTIFACT" | sed 's/^/    /'

# ───── 3. 创建 / 更新 GitHub Release ─────

blue "════════════════════════════════════════"
blue "  3/3 上传 GitHub Release"
blue "════════════════════════════════════════"

if ! command -v gh >/dev/null 2>&1; then
  red "gh CLI 没装。手动跑一次："
  echo "  brew install gh && gh auth login"
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  red "gh 没登录。先跑 gh auth login"
  exit 1
fi

NOTES_FILE=$(mktemp)
trap 'rm -rf "$STAGE" "$NOTES_FILE"' EXIT

cat > "$NOTES_FILE" <<EOF
## 镜像

| service | tag |
| --- | --- |
| backend | \`crpi-4noctswoyij0f9rg.cn-shenzhen.personal.cr.aliyuncs.com/inkfin/akapen-backend:${VERSION}\` |
| web | \`crpi-4noctswoyij0f9rg.cn-shenzhen.personal.cr.aliyuncs.com/inkfin/akapen-web:${VERSION}\` |

同时还有 \`:latest\` 和 \`:${GIT_SHA}\` 两个别名 tag。

## 部署 / 升级

\`\`\`bash
# 拉这次 release（钉死版本）
curl -fL https://github.com/inkfin/akapen/releases/download/${VERSION}/akapen-deploy.tar.gz | tar -xz

# 或者总是要最新版
curl -fL https://github.com/inkfin/akapen/releases/latest/download/akapen-deploy.tar.gz | tar -xz
\`\`\`

详见 \`INSTALL.md\` 和 \`docs/DEPLOY_HANDOFF.md\`。

## Commit

\`${GIT_SHA}\`
EOF

if gh release view "$VERSION" >/dev/null 2>&1; then
  if [[ "${REPLACE:-0}" != "1" ]]; then
    red "release $VERSION 已存在。"
    red "想重传 artifact：REPLACE=1 ./scripts/release.sh $VERSION"
    exit 1
  fi
  yellow "→ release $VERSION 已存在，覆盖 artifact + notes"
  gh release upload "$VERSION" "$ARTIFACT" --clobber
  gh release edit "$VERSION" --notes-file "$NOTES_FILE"
else
  blue "→ gh release create $VERSION"
  gh release create "$VERSION" "$ARTIFACT" \
    --title "akapen ${VERSION}" \
    --notes-file "$NOTES_FILE"
fi

green "════════════════════════════════════════"
green "✓ release ${VERSION} 完成"
echo
echo "  浏览器查看："
echo "    $(gh release view "$VERSION" --json url -q .url)"
echo
echo "  ECS 上一行命令拉部署清单："
echo "    curl -fL https://github.com/inkfin/akapen/releases/latest/download/akapen-deploy.tar.gz | tar -xz"
echo
green "════════════════════════════════════════"
