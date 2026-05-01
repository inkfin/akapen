# 部署交接：ECS 上把 akapen 拉起来

> 这份文档是**部署交接单**，给下一个 LLM / 运维同学看。读这一份就够了，
> 不需要再去翻整个仓库。镜像已经构建并推到 ACR，你的工作是**在 ECS 上把它跑起来**。

## 〇、先搞清楚部署哪 / 给谁用

- **业务**：日语作文批改老师端。老师在 web UI 上传学生作文图，后端调阿里云百炼
  Qwen3-VL 做 OCR + 评分，结果回填到 web。
- **架构**：两个容器：
  - `akapen-backend`（FastAPI + SQLite + asyncio worker）：调 LLM、跑批改任务，监听 `:8000`
  - `akapen-web`（Next.js 15 + SQLite + NextAuth）：老师 UI、班级 / 题目 / 批改大盘，监听 `:3000`
- **依赖**：阿里云百炼 API Key（DashScope，必须）；可选 Gemini / Claude。
- **目标机器假设**：阿里云深圳 ECS，2C2G，公网 3 Mbps，x86_64（linux/amd64）。
  其它规格也能跑，但 mem_limit / 并发数可能要调（见 §七）。

## 一、镜像信息（已就绪，不用重 build）

| service | image | platform |
| --- | --- | --- |
| backend | `crpi-4noctswoyij0f9rg.cn-shenzhen.personal.cr.aliyuncs.com/inkfin/akapen-backend:latest` | linux/amd64 |
| web | `crpi-4noctswoyij0f9rg.cn-shenzhen.personal.cr.aliyuncs.com/inkfin/akapen-web:latest` | linux/amd64 |

- 当前最新 git sha tag: `43aece5`（也作为 image tag 推过，可以用 `:43aece5` 钉死版本回滚）
- 单架构 manifest（`--provenance=false --sbom=false`），不会出现 unknown 平台条目
- ACR 是阿里云**个人版** Container Registry（实例 ID: `crpi-4noctswoyij0f9rg`），
  深圳 region。从深圳 ECS 拉 → 走内网，不占公网带宽。

**ACR 凭据**（找仓库主人要，别提交到代码里）：
- 用户名：`inkfinite`
- 命名空间：`inkfin`
- 密码：阿里云控制台「容器镜像服务 → 实例 → 访问凭证 → 设置固定密码」生成

## 二、你需要的 4 个文件

不需要 git clone 整个仓库，只要这 4 个：

```
docker-compose.yml          # 共用配置（端口、env、卷、健康检查、资源 limit）
docker-compose.prod.yml     # 生产 override，把 image 指向 ACR + pull_policy=always
.env.example                # backend 的 env 模板
web/.env.example            # web 的 env 模板
```

可以从仓库 `/Users/inkfin/dev/Code/akapen` 直接 scp，或者从 git 这个 commit 拿：`43aece5`。

放到 ECS 的工作目录（建议 `/opt/akapen`）：

```text
/opt/akapen/
├── docker-compose.yml
├── docker-compose.prod.yml
├── .env                # 你从 .env.example 改名+填值
├── web/
│   └── .env            # 你从 web/.env.example 改名+填值
├── data/               # mkdir 出来，挂给 backend
└── web/data/           # mkdir 出来，挂给 web
```

## 三、ENV 配置（最容易踩坑的一步）

### 3.1 生成所有需要的随机串

跑这几条，把输出记下来等会儿填：

```bash
# 1) backend API_KEYS 的 secret（≥ 32 字节）
openssl rand -base64 32     # 例：A1B2...==

# 2) WEBHOOK_SECRET（≥ 32 字节）—— backend 和 web 必须填同一个
openssl rand -base64 32

# 3) web AUTH_SECRET（NextAuth）
openssl rand -base64 32

# 4) web IMAGE_URL_SECRET（图片签名 URL）
openssl rand -base64 32
```

### 3.2 填 `.env`（backend）

参照 `.env.example`，**至少填这几个**：

```bash
DASHSCOPE_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx   # 必填
DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1

# ⚠ 仅当 ECS 在 cn-beijing region 时才能开 true（DashScope 在北京）。
# 深圳 ECS → false（保持默认）。
USE_VPC_ENDPOINT=false

# ⚠ 格式必须是 name:secret，逗号分隔多个；name 自定，secret 用 §3.1 的第 1 个
API_KEYS=akapen:A1B2...==

# §3.1 的第 2 个；web 那边必须一字不差填同一个
WEBHOOK_SECRET=...==

# 2C2G + 3Mbps 默认值，先不动
MAX_CONCURRENCY=8
BANDWIDTH_KBPS=2400
```

### 3.3 填 `web/.env`

```bash
DATABASE_URL=file:/app/data/web.db    # 不用动，容器内路径

# §3.1 的第 3 个
AUTH_SECRET=...==

# 关键 1：跟 backend 容器互联用 service 名
AKAPEN_BASE_URL=http://backend:8000

# 关键 2：从 .env 的 API_KEYS=akapen:<secret> 里把 <secret> 部分（即 §3.1 的第 1 个）粘过来。
#         不要带 "akapen:" 前缀，只要冒号后面的字符串。
AKAPEN_API_KEY=A1B2...==

# 关键 3：必须跟 .env 的 WEBHOOK_SECRET 完全一致（§3.1 第 2 个）
WEBHOOK_SECRET=...==

# 关键 4：backend 容器从 docker DNS 拉学生作文图用，service 名能解析就行
WEB_PUBLIC_BASE_URL=http://web:3000

# §3.1 的第 4 个
IMAGE_URL_SECRET=...==

# 老师从浏览器访问的 URL —— 看 §五 决定填什么
NEXTAUTH_URL=http://<ECS-公网-IP>:3000

MAX_UPLOAD_BYTES=8388608
MAX_IMAGES_PER_SUBMISSION=8
```

> ⚠ 三个最易出错点：
> 1. `AKAPEN_API_KEY` 是 secret 部分，**不含 "akapen:" 前缀**。
> 2. `WEBHOOK_SECRET` 两边必须**完全一致**，少一个换行都会 401。
> 3. `WEB_PUBLIC_BASE_URL` 必须保持 `http://web:3000`（docker service 名），
>    **不要**换成公网域名 —— 那叫 hairpin 陷阱，backend 容器自己绕公网回来拉图会 502 / 超时。

## 四、起服务

```bash
cd /opt/akapen

# 1) 准备数据目录（容器内进程是 uid 1000）
mkdir -p data web/data
sudo chown -R 1000:1000 data web/data

# 2) 登录 ACR（首次或 token 过期）
docker login crpi-4noctswoyij0f9rg.cn-shenzhen.personal.cr.aliyuncs.com -u inkfinite
# 提示输密码 → 粘 ACR 固定密码

# 3) 拉镜像 + 起服
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# 4) 验活
curl http://127.0.0.1:8000/v1/livez       # → 200 OK
curl http://127.0.0.1:8000/v1/readyz      # → 200 OK（启动完成后）
curl -I http://127.0.0.1:3000/login       # → 200 / 重定向都算正常

docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs --tail=80 backend
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs --tail=80 web
```

每次都敲 `-f docker-compose.yml -f docker-compose.prod.yml` 太长，建议 alias：

```bash
echo "alias dcp='docker compose -f docker-compose.yml -f docker-compose.prod.yml'" >> ~/.bashrc
source ~/.bashrc
# 之后：dcp pull && dcp up -d / dcp logs -f backend / ...
```

## 五、域名 / 反代 / HTTPS

最简单：直接暴 `:3000` 端口给老师用，URL 是 `http://<ECS-公网-IP>:3000`。
开放安全组 3000 端口即可，不用反代。

如果要走域名 + HTTPS（建议生产环境这么搞），建议 nginx + certbot：

```nginx
server {
    listen 443 ssl http2;
    server_name akapen.example.com;
    # ssl_certificate / ssl_certificate_key 由 certbot 配

    client_max_body_size 80m;     # 学生作文图最多 8 张 × 8MB ≈ 64MB

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;     # ⚠ NextAuth 必需
        proxy_set_header X-Forwarded-Host $host;
        proxy_read_timeout 300s;                         # 批改任务可能跑得久
    }
}
```

然后 `web/.env` 改 `NEXTAUTH_URL=https://akapen.example.com`，重启 web 容器：

```bash
dcp up -d web
```

`AUTH_TRUST_HOST=true` 已经在 `docker-compose.yml` 里写死了，不用动。

backend `:8000` 不要直接暴公网，没必要——老师 UI 不直接访问 backend，只有
web 容器内通过 docker network 调。运维 / 调试用 SSH 隧道：

```bash
ssh -L 8000:127.0.0.1:8000 user@ecs    # 然后本地浏览器访问 http://127.0.0.1:8000/admin
```

## 六、创建第一个老师账号

老师端没有自助注册（学生根本不登录），只有 CLI 加账号：

```bash
dcp exec web node scripts/create-user.cjs \
  --email teacher@example.com \
  --password 'StrongPassword123' \
  --name '王老师'
```

成功后浏览器打开 `<NEXTAUTH_URL>` 用这套邮箱密码登录，就能开始建班级、上传作文。

## 七、回滚 / 升级 / 监控

### 升级到最新版

仓库主人推完新镜像后：

```bash
dcp pull        # 拉最新 :latest
dcp up -d       # 滚动重启，数据保留
```

健康检查 fail 会自动回退（compose 不会切流量到不健康的容器），但 web 没有 healthcheck，
万一坏了得手动回滚（见下条）。

### 回滚到某个 git sha

ACR 上每个 push 都打了 git short sha tag。临时切版本：

```bash
# 改 docker-compose.prod.yml 里 backend image 的 tag，从 :latest 改成 :44cbf5a
# 然后：
dcp pull && dcp up -d
```

或者用环境变量驱动（更优雅，但需要先在 prod.yml 里写成 `:${ACR_TAG:-latest}`）：

```bash
ACR_TAG=44cbf5a dcp up -d
```

### 监控

- **健康检查**：backend 自带 `/v1/livez` `/v1/readyz`，web 没有
- **指标**：backend 暴 `/v1/metrics`（Prometheus 文本），可用 node_exporter +
  prometheus + grafana 接（可选）
- **运维后台**：backend 的 `/admin`（只读 Gradio）—— 看任务列表 / 详情 / 重试
- **日志**：`dcp logs -f backend` / `dcp logs -f web`；持久化日志在
  `/opt/akapen/data/logs/app.log`（backend）

### 资源占用

`docker-compose.yml` 已经写死了 `mem_limit`：backend 1.5GB，web 512MB。
2C2G 机器刚好打满。如果机器更大（4G+），可以放开：

```yaml
# 在 docker-compose.prod.yml 加：
services:
  backend:
    mem_limit: 3g
    memswap_limit: 3g
```

并发也可以拉高：`MAX_CONCURRENCY=20` 写到 `.env` 里再 `dcp up -d backend`。

## 八、备份

每天 cron 一次：

```bash
# /etc/cron.daily/akapen-backup
#!/bin/bash
set -euo pipefail
DATE=$(date +%F)
BACKUP=/var/backups/akapen
mkdir -p "$BACKUP"

# backend 任务库（WAL 模式必须用 .backup 命令，rsync .db 文件会丢数据）
docker compose -f /opt/akapen/docker-compose.yml -f /opt/akapen/docker-compose.prod.yml \
    exec -T backend sqlite3 /app/data/grading.db ".backup /app/data/backup-$DATE.db"
mv /opt/akapen/data/backup-$DATE.db "$BACKUP/grading-$DATE.db"

# web 业务库（学生 / 题目 / 提交记录 / 批改快照）
docker compose -f /opt/akapen/docker-compose.yml -f /opt/akapen/docker-compose.prod.yml \
    exec -T web sqlite3 /app/data/web.db ".backup /app/data/backup-$DATE.db"
mv /opt/akapen/web/data/backup-$DATE.db "$BACKUP/web-$DATE.db"

# 上传图片（用 rsync 增量，不删旧版本）
rsync -a --link-dest="$BACKUP/uploads-latest" /opt/akapen/web/data/uploads/ \
    "$BACKUP/uploads-$DATE/"
ln -sfn "uploads-$DATE" "$BACKUP/uploads-latest"

# 30 天前的清掉
find "$BACKUP" -name "*-*.db" -mtime +30 -delete
find "$BACKUP" -maxdepth 1 -name "uploads-*" -type d -mtime +30 -exec rm -rf {} +
```

## 九、常见问题排查

| 症状 | 大概率原因 |
| --- | --- |
| web 登录后页面白屏 / NEXTAUTH 报错 | `NEXTAUTH_URL` 跟实际访问 URL 不一致；或反代没传 `X-Forwarded-Proto` |
| 点「一键批改」一直转圈，任务永远 queued | `WEBHOOK_SECRET` 两边不一致 → backend 推 webhook 401 → web 不更新；看 `dcp logs backend` 找 `webhook send failed` |
| 批改完页面分数显示 `28/1` 之类 | 老 task，没存 `maxScore`。新 task 不会再有；老的可以手动跑 `UPDATE GradingTask SET maxScore=100 WHERE ...` |
| `/v1/livez` 200 但 `/v1/readyz` 503 | DashScope key 不对 / VPC endpoint 配错 region；看 backend 日志 `dashscope` 关键词 |
| backend OOM kill / 频繁重启 | 并发过高或 task_timeout 太长，调小 `MAX_CONCURRENCY` 或加 mem_limit |
| 推图慢 / 超时 | 公网带宽 3M 打满了。开 `USE_VPC_ENDPOINT=true`（仅 cn-beijing ECS 可），或换 batch / 错峰 |
| 老师上传图后 backend 拉不到 | `WEB_PUBLIC_BASE_URL` 被你改成了公网域名（hairpin）。改回 `http://web:3000` |
| `docker compose pull` 401 | ACR token 过期（个人版默认有效期较短）；重跑 `docker login crpi-...` |

## 十、有什么不明白的

- 仓库代码：`/Users/inkfin/dev/Code/akapen`（仓库主人本地）
- 业务架构：根目录 `AGENTS.md`（讲 provider 抽象、prompt 占位符等）
- 容量预算：`docs/PLAN_CN_SINGLE_SCHOOL_2C2G.md`
- 产品形态：`docs/WEB_PRODUCT.md`
- 推镜像脚本：`scripts/push-acr.sh`（你大概率不需要碰，但能看出 build 参数）

镜像跑不起来 / env 不知道填什么 / ACR 拉不到，都先回 §三 §四 §九 自查，
还不行就找仓库主人要 ACR 密码 / `.env` 真实值。
