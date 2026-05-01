# 老师端 Web 产品说明（`web/`）

> 这份文档面向**部署 / 试用 web/ 模块的人**，不讲技术实现（那看 AGENTS.md §十一）。

## 一、它能做什么

一个小学 / 中学老师用的「学生作业管理 + 一键批改」系统。三个核心场景：

1. **建班录学生**：班级 → 批量粘贴学号 + 姓名（每行一个，空格 / 逗号都行）
2. **手机录答题**：把 `/batches/<id>/upload` 链接发到老师的微信，扫码 → 选学生
   → 逐题拍照，自动按 `batchId/studentId/questionId/<sha>.jpg` 整理
3. **桌面批改**：在「批改大盘」里看学生 × 题号矩阵，多选 → 一键批改，3 秒一次自动
   刷新进度；点单元格弹详情抽屉，看分数 / 错误原因 / 重批

整个流程**学生不参与**：老师代为录入照片、代为查看结果。设计上刻意如此，
避免学生帐号管理 / 隐私合规这些重活。

## 二、产品边界（明确不做的）

- ❌ **学生登录 / APP**：先不做，等老师那边跑顺再说
- ❌ **多校 / 校管理员**：单校单租户，所有老师彼此可见对方建的班级（信任型场景）
- ❌ **富文本题目**：题干就是纯文本（送 LLM 用），要图题截图发微信群
- ❌ **PWA / 离线 / 推送**：手机端就是普通响应式 H5
- ❌ **多语言**：先中文一种
- ❌ **Excel 导入 / 班级花名册同步**：现在批量粘贴 + 后续手填即可

## 三、与「akapen 中台」(`backend/`) 的关系

老师 web 自己**不调用 LLM**，所有评分都通过 HTTP 转给 backend：

```
老师手机/电脑 → web → backend → DashScope (Qwen3-VL)
                ▲       │
                │       ▼
              SQLite  webhook 回调
              (web.db)  (HMAC-SHA256 验签)
```

带宽角度：在同一台 ECS 上 docker-compose 起 backend + web，二者用 docker network
互联（`http://backend:8000` 和 `http://web:3000`），**不占公网 3 Mbps 带宽**。
LLM 调用是唯一的公网出向，由 backend 的 token bucket 严格控流。

## 四、首次部署 5 分钟流程

```bash
# 0) 一台 2C2G ECS（深圳），装好 docker compose
git clone <this repo> akapen && cd akapen

# 1) backend 配置
cp .env.example .env
# 编辑 .env：DASHSCOPE_API_KEY、API_KEYS=akapen:<32+ 位随机串>、WEBHOOK_SECRET=<32+>
# 注意：WEBHOOK_SECRET 一定要随机生成，记下来等会儿 web 那边要用

# 2) web 配置
cp web/.env.example web/.env
# 编辑 web/.env：
#   AUTH_SECRET=<openssl rand -base64 32>
#   IMAGE_URL_SECRET=<openssl rand -base64 32>
#   WEBHOOK_SECRET=<和 .env 里的那个一字不差>
#   AKAPEN_API_KEY=<.env 里 API_KEYS=akapen:<this> 里的 secret>

# 3) 起服务
docker compose up -d --build
docker compose logs -f web        # 观察 prisma migrate 跑完 + Next ready

# 4) 加初始账号
docker compose exec web node scripts/create-user.cjs \
  --email teacher@example.com --password 'mypassword' --name '王老师'

# 5) 浏览器打开 http://<host>:3000，邮箱 + 密码登录
```

## 五、典型一节课流程

| 时间点 | 动作 |
| --- | --- |
| 课前 | 老师建班 → 粘贴学生名单 → 建作业批次 → 录题（最多 99 题） |
| 课中 | 学生写完 → 拍照 / 老师收上来后用手机扫批改链接二维码上传 |
| 课后 | 老师在桌面批改大盘多选学生 × 题号 → 「一键批改」→ 3 秒后看到第一批结果 |
| 复核 | 待复核（边界分数 / 模型自评 confidence 低）会自动打 ⚠ 标，老师点详情抽屉 |
| 重批 | 不满意某次评分？详情里点「重批（新一轮）」，会触发新一轮 LLM 调用 |

## 六、容量参考（2C2G + 3 Mbps + qwen3-vl-flash）

按 `docs/PLAN_CN_SINGLE_SCHOOL_2C2G.md` 的预算：

- 单题（1-2 张图）：30-60s 完成
- 一份作业 5 题 × 40 名学生 = 200 个任务：~25-40 分钟跑完（带宽是瓶颈）
- 半天可处理 ~500 份学生答卷

在线人数限制：登录 / 上传 / 看大盘走 web 自家 Next，几乎不占 3 Mbps（前端
JS 走 standalone 内嵌资源 + gzip，每页 100KB 左右）；瓶颈始终是 LLM 上行。

## 七、常见问题

**Q: 学生没拍照怎么办？**
A: 老师可以补拍，或者直接在大盘里跳过。「未交」格不会被一键批改选中。

**Q: 拍模糊了 / 多拍了几张？**
A: 上传页面的缩略图条上每张图都有删除按钮，删完再补拍即可。

**Q: HEIC 上传失败？**
A: iPhone 默认 HEIC，PIL 不解。让老师把相机设置改 "兼容性最好" / "JPEG"。
后续可以在浏览器侧用 `heic2any` 自动转，但不在 MVP 范围。

**Q: 一份作业重批多少次？**
A: 没硬限制。每次重批 revision++，独立计 LLM 配额。idempotency_key 保证重复
点击不会撞键。

**Q: 学生数据怎么备份？**
A: `web/data/web.db` 单文件 SQLite，rsync 出去就是备份。`web/data/uploads/`
里是原图，按 `batchId/studentId/qId/<sha>.jpg` 组织，删 batch 也会一起删。

## 八、运维链路

| 故障表象 | 排查路径 |
| --- | --- |
| 登录页转圈 / 报错 | `docker compose logs web` 找 NextAuth / Prisma 报错 |
| 上传一直转圈 | F12 看 `/api/upload` 响应；可能是 HEIC 被 415 拒 |
| 批改一直「批改中」| `docker compose logs backend` 看 worker 是不是卡 |
| 批改全部失败 | `docker compose exec backend python -c "from core.config import Settings; print(Settings.load().dashscope_api_key[:8])"` 验 key |
| webhook 不回 | backend 日志找 `[Webhook ✗]`，多半是 `WEBHOOK_SECRET` 两边不一致 |

监控指标：`http://<host>:8000/v1/metrics`（Prometheus 文本格式）。
backend 后台：`http://<host>:8000/admin`（Gradio 只读）。
