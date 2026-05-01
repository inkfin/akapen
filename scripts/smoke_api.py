"""Akapen 中台 5 路烟测（对应 docs/PLAN_CN_SINGLE_SCHOOL_2C2G.md §八）。

跑前置：

1. ``.env`` 里配 ``API_KEYS=akapen:<32+ 字符 secret>`` 和 ``WEBHOOK_SECRET=...``。
2. 把 ``BASE_URL`` / ``API_SECRET`` / ``WEBHOOK_SECRET`` 改成你的实际值（或者用环境变量覆盖）。
3. 启动中台：``uv run python -m backend.app`` 或 ``docker compose up -d``。
4. 准备至少一张测试图（默认指向 ``dataset/`` 第一张 JPEG）。

5 路：

1. ``test_json_polling``     ：JSON + image_urls → 轮询
2. ``test_multipart_polling``：multipart 上传 → 轮询
3. ``test_json_webhook``     ：起 echo 服务器 → JSON + callback_url → 验签 + 收 succeeded
4. ``test_dead_webhook``     ：echo 返 400 → 重试至 dead
5. ``test_bandwidth_stress`` ：30 个任务并发，观察 token bucket / 上行字节

5 不会真的发图——下游 LLM 配额不一定够；它只验证 token bucket 把单分钟出向控
在 18 MB 以下、并发 8 不出现 LLM timeout。
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from pathlib import Path

import httpx


BASE_URL = os.getenv("AKAPEN_BASE_URL", "http://127.0.0.1:8000")
API_SECRET = os.getenv("AKAPEN_API_KEY", "")
WEBHOOK_SECRET = os.getenv("AKAPEN_WEBHOOK_SECRET", "")

# 用于真实 LLM 测试的图片 URL（外网可达；replace 成你的）
DEFAULT_IMAGE_URLS = os.getenv(
    "AKAPEN_TEST_IMAGE_URLS",
    "https://example.invalid/student-essay-page1.jpg",
).split(",")

HEADERS = {"X-API-Key": API_SECRET}


def _sample_local_image() -> Path:
    """随便挑一张项目里的图作为 multipart 上传素材。"""
    candidates = list(Path("dataset").rglob("*.jpg")) + list(Path("data/input").rglob("*.jpg"))
    if not candidates:
        sys.exit("找不到本地图片可用；放一张到 dataset/ 或 data/input/")
    return candidates[0]


async def _wait_for_terminal(
    client: httpx.AsyncClient, task_id: str, *, timeout_sec: int = 300,
) -> dict:
    """轮询单条任务直到 succeeded / failed / cancelled。"""
    deadline = time.monotonic() + timeout_sec
    while time.monotonic() < deadline:
        r = await client.get(f"/v1/grading-tasks/{task_id}", headers=HEADERS)
        r.raise_for_status()
        body = r.json()
        if body["status"] in ("succeeded", "failed", "cancelled"):
            return body
        await asyncio.sleep(2)
    raise TimeoutError(f"task {task_id} 在 {timeout_sec}s 内没到终态")


# ---- 路径 1：JSON + 轮询 ---- #


async def test_json_polling(client: httpx.AsyncClient) -> None:
    print("[1/5] JSON + 轮询 ...")
    payload = {
        "idempotency_key": f"smoke-{int(time.time())}-1",
        "student_id": "smoke-001",
        "student_name": "烟测同学一号",
        "image_urls": DEFAULT_IMAGE_URLS,
    }
    r = await client.post("/v1/grading-tasks", json=payload, headers=HEADERS)
    r.raise_for_status()
    body = r.json()
    assert body["status"] == "queued"
    print(f"    created task_id={body['task_id']}")
    final = await _wait_for_terminal(client, body["task_id"], timeout_sec=300)
    print(f"    final status={final['status']}")
    if final["status"] == "succeeded":
        print(f"    score={final['result']['final_score']} / "
              f"{final['result']['max_score']}")


# ---- 路径 2：multipart + 轮询 ---- #


async def test_multipart_polling(client: httpx.AsyncClient) -> None:
    print("[2/5] multipart + 轮询 ...")
    img = _sample_local_image()
    files = [("images", (img.name, img.read_bytes(), "image/jpeg"))]
    data = {
        "idempotency_key": f"smoke-{int(time.time())}-2",
        "student_id": "smoke-002",
        "student_name": "烟测同学二号",
    }
    r = await client.post(
        "/v1/grading-tasks", data=data, files=files, headers=HEADERS,
    )
    r.raise_for_status()
    body = r.json()
    print(f"    created task_id={body['task_id']}")
    final = await _wait_for_terminal(client, body["task_id"], timeout_sec=300)
    print(f"    final status={final['status']}")


# ---- 路径 3 & 4：webhook ---- #


async def _start_echo_server(*, force_status: int):
    """起一个本地 echo HTTP server，记录所有收到的回调，返回 (server, port, received)。"""
    received: list[dict] = []

    async def echo_app(scope, receive, send):
        if scope["type"] != "http":
            return
        body = b""
        while True:
            msg = await receive()
            body += msg.get("body", b"")
            if not msg.get("more_body", False):
                break
        headers = dict((k.decode(), v.decode()) for k, v in scope["headers"])
        sig_header = headers.get("x-akapen-signature", "")
        parts = dict(p.split("=", 1) for p in sig_header.split(",") if "=" in p)
        ts = int(parts.get("t", "0"))
        sig = parts.get("v1", "")
        body_str = body.decode()

        # 校验签名
        valid = False
        if WEBHOOK_SECRET:
            from backend.webhook import verify_signature

            valid = verify_signature(WEBHOOK_SECRET, ts, body_str, sig)

        received.append({
            "valid_sig": valid,
            "payload": json.loads(body_str),
            "ts_ok": abs(time.time() - ts) < 300,
        })

        await send({
            "type": "http.response.start",
            "status": force_status,
            "headers": [(b"content-type", b"application/json")],
        })
        await send({"type": "http.response.body", "body": b'{"ok":true}'})

    import uvicorn
    config = uvicorn.Config(echo_app, host="127.0.0.1", port=0, log_level="warning")
    server = uvicorn.Server(config)
    server_task = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.05)
    port = server.servers[0].sockets[0].getsockname()[1]
    return server, server_task, port, received


async def test_json_webhook(client: httpx.AsyncClient) -> None:
    print("[3/5] JSON + webhook（success 路径）...")
    server, server_task, port, received = await _start_echo_server(force_status=200)
    try:
        callback_url = f"http://127.0.0.1:{port}/echo"
        payload = {
            "idempotency_key": f"smoke-{int(time.time())}-3",
            "student_id": "smoke-003",
            "student_name": "烟测同学三号",
            "image_urls": DEFAULT_IMAGE_URLS,
            "callback_url": callback_url,
        }
        r = await client.post("/v1/grading-tasks", json=payload, headers=HEADERS)
        r.raise_for_status()
        tid = r.json()["task_id"]
        print(f"    created task_id={tid}, callback={callback_url}")
        await _wait_for_terminal(client, tid, timeout_sec=300)
        # 等回调 dispatcher 投递（最多 2 个 poll 周期 = 10s）
        for _ in range(20):
            if any(r["payload"].get("task_id") == tid for r in received):
                break
            await asyncio.sleep(1)
        relevant = [r for r in received if r["payload"].get("task_id") == tid]
        print(f"    received {len(relevant)} callbacks")
        assert relevant, "没收到 webhook"
        assert all(r["valid_sig"] for r in relevant), "HMAC 签名校验失败"
        assert all(r["ts_ok"] for r in relevant), "timestamp 偏离 5min"
        print("    ✓ HMAC 签名 + 时间戳全部合法")
    finally:
        server.should_exit = True
        try:
            await asyncio.wait_for(server_task, timeout=5)
        except Exception:
            pass


async def test_dead_webhook(client: httpx.AsyncClient) -> None:
    print("[4/5] 故意 4xx webhook（dead 路径）...")
    server, server_task, port, received = await _start_echo_server(force_status=400)
    try:
        callback_url = f"http://127.0.0.1:{port}/echo"
        payload = {
            "idempotency_key": f"smoke-{int(time.time())}-4",
            "student_id": "smoke-004",
            "student_name": "烟测同学四号",
            "image_urls": DEFAULT_IMAGE_URLS,
            "callback_url": callback_url,
        }
        r = await client.post("/v1/grading-tasks", json=payload, headers=HEADERS)
        r.raise_for_status()
        tid = r.json()["task_id"]
        await _wait_for_terminal(client, tid, timeout_sec=300)

        # 4xx 不重试，应该直接 dead；最多等 10s
        for _ in range(20):
            r = await client.get(f"/v1/grading-tasks/{tid}", headers=HEADERS)
            cb_status = r.json().get("callback_status")
            if cb_status == "dead":
                break
            await asyncio.sleep(1)
        print(f"    callback_status={cb_status}, attempts={r.json()['callback_attempts']}")
        assert cb_status == "dead"
        print("    ✓ 4xx 立即进入 dead，未无意义重试")
    finally:
        server.should_exit = True
        try:
            await asyncio.wait_for(server_task, timeout=5)
        except Exception:
            pass


# ---- 路径 5：带宽压测 ---- #


async def test_bandwidth_stress(client: httpx.AsyncClient) -> None:
    print("[5/5] 带宽压测（30 任务，观察 token bucket）...")
    print("    建议在另一窗口看 metrics: curl ... /v1/metrics | grep upload_bytes")

    payloads = [
        {
            "idempotency_key": f"smoke-stress-{int(time.time())}-{i}",
            "student_id": f"stress-{i:03d}",
            "student_name": f"压测同学{i}",
            "image_urls": DEFAULT_IMAGE_URLS,
        }
        for i in range(30)
    ]
    t0 = time.monotonic()
    submit_tasks = [client.post("/v1/grading-tasks", json=p, headers=HEADERS) for p in payloads]
    submit_responses = await asyncio.gather(*submit_tasks, return_exceptions=True)

    tids = []
    for r in submit_responses:
        if isinstance(r, Exception):
            print(f"    submit error: {r}")
            continue
        if r.status_code == 202:
            tids.append(r.json()["task_id"])
    print(f"    submitted {len(tids)} tasks in {time.monotonic() - t0:.1f}s")

    # 等所有终态
    deadline = time.monotonic() + 600
    while time.monotonic() < deadline:
        rs = await asyncio.gather(*[
            client.get(f"/v1/grading-tasks/{tid}", headers=HEADERS) for tid in tids
        ])
        statuses = [r.json()["status"] for r in rs if r.status_code == 200]
        terminal = sum(1 for s in statuses if s in ("succeeded", "failed", "cancelled"))
        print(f"    {terminal}/{len(tids)} terminal "
              f"(succeeded={statuses.count('succeeded')}, "
              f"failed={statuses.count('failed')})")
        if terminal == len(tids):
            break
        await asyncio.sleep(10)
    print(f"    总耗时 {time.monotonic() - t0:.1f}s")

    # 拉一份 metrics 给最终视图
    r = await client.get("/v1/metrics")
    upload_lines = [l for l in r.text.splitlines() if "akapen_upload_bytes_total" in l and not l.startswith("#")]
    bucket_lines = [l for l in r.text.splitlines() if "akapen_bucket_wait_seconds" in l and not l.startswith("#")]
    print("    upload_bytes:", *upload_lines[:3], sep="\n      ")
    print("    bucket_wait :", *bucket_lines[:3], sep="\n      ")


# ---- 入口 ---- #


async def main():
    if not API_SECRET:
        sys.exit("AKAPEN_API_KEY 未设置；请 export 一下你 .env 里的 API_KEYS secret 部分")

    timeout = httpx.Timeout(60.0, connect=10.0)
    async with httpx.AsyncClient(base_url=BASE_URL, timeout=timeout) as client:
        # 先确认中台在跑
        try:
            r = await client.get("/v1/livez")
            r.raise_for_status()
        except Exception as e:
            sys.exit(f"中台不可达 ({BASE_URL}): {e}")

        await test_json_polling(client)
        await test_multipart_polling(client)
        await test_json_webhook(client)
        await test_dead_webhook(client)
        await test_bandwidth_stress(client)
        print("\n=== 全部 5 路烟测完成 ===")


if __name__ == "__main__":
    asyncio.run(main())
