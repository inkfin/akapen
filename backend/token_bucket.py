"""异步全局上行字节令牌桶。

用途：3 Mbps 公网出口下，避免 8 路 worker 同时把 LLM 上传打到 100% 触发 stall /
LLM 端 timeout。worker 在调 LLM 前先 ``await bucket.acquire(payload_bytes)``，
桶不够就 await 等到桶被时间补满。

实现：经典 leaky bucket / token bucket：
- ``rate_per_sec``：每秒向桶里加多少 token（这里 token = byte）
- ``capacity``：桶最大容量（允许的 burst 体积）
- ``acquire(n)``：消耗 n 个 token；不够就睡到够。

并发安全：用一个 ``asyncio.Lock`` 保护 ``tokens / last_refill``。``acquire`` 不在
锁里 sleep（先释放再 sleep，再循环重试），避免长时间持锁阻塞别的 worker。

边界情况：``n > capacity`` 时不会 deadlock——我们把它 clamp 到 capacity 并按实
际容量 acquire（注意：实际网络上传可能仍超过这个值，但这是软限速，不强求 byte 级
精度，目的只是平滑突发，不让 8 个连接同时打满）。
"""
from __future__ import annotations

import asyncio
import logging
import time

logger = logging.getLogger("backend.bucket")


class TokenBucket:
    """异步令牌桶，单位是 byte。

    标准用法：

        bucket = TokenBucket.from_kbps(2400, burst_seconds=2)
        await bucket.acquire(1_500_000)   # 等到 1.5MB token 可用
        # 然后真正发请求
    """

    def __init__(self, *, rate_per_sec: float, capacity: float):
        if rate_per_sec <= 0:
            raise ValueError("rate_per_sec must be > 0")
        if capacity <= 0:
            raise ValueError("capacity must be > 0")
        self.rate = rate_per_sec
        self.capacity = capacity
        self.tokens: float = capacity
        self.last_refill: float = time.monotonic()
        self._lock = asyncio.Lock()

    @classmethod
    def from_kbps(cls, kbps: int, *, burst_seconds: float = 2.0) -> "TokenBucket":
        """以 kbps 描述速率 + N 秒的 burst 容量。"""
        bytes_per_sec = kbps * 1024 / 8
        return cls(rate_per_sec=bytes_per_sec, capacity=bytes_per_sec * burst_seconds)

    async def acquire(self, n: int) -> None:
        """消耗 ``n`` 个 token；不够就 sleep 到够。

        ``n`` 大于 capacity 时 clamp 到 capacity（避免单个请求因为体积过大而永远
        等不到）。这种情况下"按 capacity 收费"，剩余的就直接放过——上层应保证
        single image 永远不会真的超 capacity。
        """
        if n <= 0:
            return
        n = min(n, self.capacity)

        while True:
            async with self._lock:
                self._refill_locked()
                if self.tokens >= n:
                    self.tokens -= n
                    return
                # 还差多少 / 多久才能补够
                missing = n - self.tokens
                wait_sec = missing / self.rate
            # 释放锁再 sleep，让别的 worker 也能 try acquire
            # （它们如果消耗少可能能跳过等待）
            await asyncio.sleep(wait_sec)

    def _refill_locked(self) -> None:
        now = time.monotonic()
        delta = now - self.last_refill
        if delta <= 0:
            return
        self.tokens = min(self.capacity, self.tokens + delta * self.rate)
        self.last_refill = now

    @property
    def available(self) -> float:
        """当前可用 token 数（仅供监控；非原子，可能略大于真实值）。"""
        return self.tokens
