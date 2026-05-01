"""Prometheus 指标定义。

worker / fetcher / webhook 在合适位置 ``inc()`` / ``observe()``，``/v1/metrics``
端点把当前值导出。

3 Mbps 单机场景下重点看的几个：
- ``akapen_upload_bytes_total{provider}``：累计往 LLM 推了多少字节，除以时间
  能算出实际上行速率，反过来验证带宽优化是否生效
- ``akapen_upload_seconds``：上传 + 推理总耗时分布
- ``akapen_inference_seconds``：仅推理（不含上传）耗时分布——上传分不开就
  跟 upload_seconds 合并
- ``akapen_tasks_total{status}``：每种状态的累计任务数
"""
from __future__ import annotations

from prometheus_client import Counter, Gauge, Histogram

# ---- 任务级 ---- #

tasks_created_total = Counter(
    "akapen_tasks_created_total",
    "提交到本中台的任务总数",
    ["api_key_id"],
)

tasks_finished_total = Counter(
    "akapen_tasks_finished_total",
    "终态任务计数",
    ["status", "mode"],  # status ∈ {succeeded, failed, cancelled}
)

task_duration_seconds = Histogram(
    "akapen_task_duration_seconds",
    "任务从 queued 到终态的总耗时",
    ["mode", "status"],
    buckets=(1, 5, 10, 20, 30, 60, 120, 180, 300, 600),
)

tasks_in_flight = Gauge(
    "akapen_tasks_in_flight",
    "当前正在处理（非终态、非 queued）的任务数",
)

# ---- LLM 调用级 ---- #

upload_bytes_total = Counter(
    "akapen_upload_bytes_total",
    "推到 LLM provider 的累计字节数",
    ["provider", "model"],
)

llm_call_seconds = Histogram(
    "akapen_llm_call_seconds",
    "单次 provider.chat 调用耗时（含上传 + 推理）",
    ["provider", "kind"],  # kind ∈ {ocr, grading, single_shot}
    buckets=(1, 2, 5, 10, 20, 30, 45, 60, 90, 120, 180),
)

provider_errors_total = Counter(
    "akapen_provider_errors_total",
    "provider 调用失败计数",
    ["provider", "kind"],  # kind ∈ {timeout, json_invalid, http_error, other}
)

# ---- Fetcher ---- #

fetch_bytes_total = Counter(
    "akapen_fetch_bytes_total",
    "fetcher 从远程 URL 拉到的累计字节",
)

fetch_errors_total = Counter(
    "akapen_fetch_errors_total",
    "fetcher 失败计数",
    ["code"],
)

# ---- Webhook ---- #

webhook_attempts_total = Counter(
    "akapen_webhook_attempts_total",
    "回调投递尝试总数",
    ["result"],  # result ∈ {delivered, retry, dead}
)

# ---- Token bucket ---- #

bucket_wait_seconds = Histogram(
    "akapen_bucket_wait_seconds",
    "等待 token bucket 的耗时（衡量带宽是否真的成为瓶颈）",
    buckets=(0.0, 0.1, 0.5, 1, 2, 5, 10, 20, 30, 60),
)
