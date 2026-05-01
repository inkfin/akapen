#!/usr/bin/env bash
# 一键 build + push akapen-backend / akapen-web 到阿里云个人镜像仓库（ACR Personal）。
#
# 设计要点：
#   - 用 docker buildx 单步 build + push，避免本地装一遍再上传一遍（省时间 + 省磁盘）。
#   - 默认目标平台 linux/amd64（深圳 ECS 大概率是 x86_64）。M 系 Mac 跑也没问题，
#     buildx 自带 QEMU 跨平台 emulation。
#   - 默认打两个 tag：latest（用于 `docker pull ...:latest` 起服务）+ git short sha
#     （用于回滚 / 钉版本）。也可以通过 TAG 环境变量再加一个自定义 tag。
#
# 用法：
#   # 1) 准备 ACR 凭据（首次跑或 token 过期时；详见阿里云控制台「个人实例 → 访问凭证」）
#   export ACR_NAMESPACE=your-namespace          # 阿里云命名空间（≠ 用户名，是建仓库时填的）
#   export ACR_USERNAME=your-aliyun-account-name # 阿里云账号名 / RAM 用户名
#   export ACR_PASSWORD=...                      # ACR 控制台「设置固定密码」生成的
#
#   # 2) 一键推
#   ./scripts/push-acr.sh
#
#   # 3) 按需推一个
#   SERVICES=backend ./scripts/push-acr.sh
#
# 可选 env：
#   ACR_REGISTRY  阿里云仓库 URL（默认见下方）
#   PLATFORM      目标平台（默认 linux/amd64；想多平台可以传 linux/amd64,linux/arm64）
#   TAG           额外要打的 tag（除了 latest 和 git sha 之外）
#   SERVICES      要推的服务，空格分隔（默认 "backend web"）
#
# 拉取时（在 ECS 上）：
#   docker login crpi-4noctswoyij0f9rg.cn-shenzhen.personal.cr.aliyuncs.com
#   docker pull   crpi-4noctswoyij0f9rg.cn-shenzhen.personal.cr.aliyuncs.com/<ns>/akapen-backend:latest
#
# ECS 拉镜像走阿里云内网加速：在 .docker/daemon.json 配置 mirror 即可零公网带宽。

set -euo pipefail

# ───── 配置 ─────

ACR_REGISTRY=${ACR_REGISTRY:-crpi-4noctswoyij0f9rg.cn-shenzhen.personal.cr.aliyuncs.com}
ACR_NAMESPACE=${ACR_NAMESPACE:?需要先设置 ACR_NAMESPACE（阿里云命名空间，建仓库时填的那个）}
PLATFORM=${PLATFORM:-linux/amd64}
SERVICES=${SERVICES:-backend web}
EXTRA_TAG=${TAG:-}

# ───── 工具 ─────

red()    { printf "\033[31m%s\033[0m\n" "$*"; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
blue()   { printf "\033[34m%s\033[0m\n" "$*"; }

# ───── 准备 tag 列表 ─────

GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "manual")
GIT_DIRTY=""
if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
  GIT_DIRTY="-dirty"
  yellow "⚠ 工作区有未提交修改；tag 会带 -dirty 后缀。建议先 commit。"
fi
SHA_TAG="${GIT_SHA}${GIT_DIRTY}"

TAGS=("latest" "$SHA_TAG")
if [[ -n "$EXTRA_TAG" ]]; then
  TAGS+=("$EXTRA_TAG")
fi

# ───── 项目根 ─────

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

# ───── 登录 ACR（如果给了凭据） ─────

if [[ -n "${ACR_USERNAME:-}" && -n "${ACR_PASSWORD:-}" ]]; then
  blue "→ docker login $ACR_REGISTRY"
  echo "$ACR_PASSWORD" | docker login "$ACR_REGISTRY" -u "$ACR_USERNAME" --password-stdin >/dev/null
  green "✓ login 成功"
else
  yellow "ACR_USERNAME / ACR_PASSWORD 没传，跳过 login（假设已经手动 docker login 过）"
fi

# ───── buildx builder ─────

BUILDER=akapen-builder
if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
  blue "→ creating buildx builder $BUILDER"
  docker buildx create --name "$BUILDER" --driver docker-container --use >/dev/null
fi
docker buildx use "$BUILDER" >/dev/null

# ───── 单 service build + push ─────

build_and_push() {
  local svc=$1
  local ctx dockerfile repo

  case "$svc" in
    backend)
      ctx="."; dockerfile="Dockerfile"; repo="akapen-backend"
      ;;
    web)
      ctx="web"; dockerfile="web/Dockerfile"; repo="akapen-web"
      ;;
    *)
      red "未知 service: $svc（支持：backend / web）"; exit 1
      ;;
  esac

  local image_base="$ACR_REGISTRY/$ACR_NAMESPACE/$repo"
  local tag_args=()
  for t in "${TAGS[@]}"; do
    tag_args+=("-t" "$image_base:$t")
  done

  echo
  blue  "════════════════════════════════════════"
  blue  "▶ $svc"
  echo  "  context:  $ctx"
  echo  "  file:     $dockerfile"
  echo  "  platform: $PLATFORM"
  echo  "  tags:     ${TAGS[*]}"
  blue  "════════════════════════════════════════"

  # --provenance=false / --sbom=false：不生成 SLSA attestation 子 manifest，
  # 让最终 image index 只有目标平台一个 entry，避免某些场景误认成 multi-arch
  # （docker manifest inspect 时不再多一条 unknown/unknown）。
  # 想做供应链审计的话再开回 true。
  docker buildx build \
    --platform "$PLATFORM" \
    --provenance=false \
    --sbom=false \
    --file "$dockerfile" \
    "${tag_args[@]}" \
    --push \
    "$ctx"

  green "✓ pushed $repo: ${TAGS[*]}"
}

for svc in $SERVICES; do
  build_and_push "$svc"
done

# ───── 收尾 ─────

echo
green "════════════════════════════════════════"
green "全部推送完成。在 ECS 上拉取："
echo
for svc in $SERVICES; do
  case "$svc" in
    backend) repo="akapen-backend" ;;
    web)     repo="akapen-web" ;;
  esac
  echo "  docker pull $ACR_REGISTRY/$ACR_NAMESPACE/$repo:latest"
done
echo
echo "或在 ECS 的 docker-compose.yml 里把每个 service 改成："
echo "  image: $ACR_REGISTRY/$ACR_NAMESPACE/akapen-backend:latest"
echo "  image: $ACR_REGISTRY/$ACR_NAMESPACE/akapen-web:latest"
echo "并删掉 build: 段，docker compose pull && docker compose up -d 即可。"
green "════════════════════════════════════════"
