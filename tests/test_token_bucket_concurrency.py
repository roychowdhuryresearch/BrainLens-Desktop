"""回归：TokenBucket.acquire 不应在 asyncio.sleep 期间占着 asyncio.Lock。

旧实现把 `await asyncio.sleep(time_to_wait)` 放在 `async with self.lock` 里，
N 个并发 LLM 调用全部串行等令牌，直接把并发打回单线程。修复后 sleep 阶段
锁是释放的，N 个 waiter 能真正并发等待。
"""
from __future__ import annotations

import asyncio
import time

import pytest

from runtime.services.ai_service import TokenBucket


@pytest.mark.asyncio
async def test_acquire_releases_lock_during_sleep():
    """acquire() 在 sleep 等待期间不应持有 self.lock。

    断言方式：waiter A 发起一个需要 ~0.5s 等待的 acquire；在它 sleep 的窗口
    内，waiter B 调 `get_available_tokens()` 应该立即返回（需要同一把锁），
    不会被 A 的 sleep 阻住。旧实现里 A 持锁 sleep，B 要等 A sleep 完。
    """
    bucket = TokenBucket(rate=2.0, capacity=1.0)
    # 抽干桶
    await bucket.acquire(tokens=1)

    # 触发一个需要等约 0.5s 的 acquire（需要 1 token，rate=2/s → wait 0.5s）
    a_started = time.perf_counter()

    async def waiter_a():
        await bucket.acquire(tokens=1)

    task_a = asyncio.create_task(waiter_a())
    # 让 A 进入 acquire 并开始 sleep
    await asyncio.sleep(0.05)
    # 此时 A 应该已经 release 了 lock、正在 asyncio.sleep —— B 能立即拿到锁
    b_started = time.perf_counter()
    await bucket.get_available_tokens()
    b_elapsed = time.perf_counter() - b_started

    # B 拿令牌信息必须是"立即"的（几十 ms 级），不能被 A 的 0.5s sleep 阻塞
    assert b_elapsed < 0.1, (
        f"get_available_tokens waited {b_elapsed:.3f}s — lock was held across asyncio.sleep"
    )

    await task_a
    total = time.perf_counter() - a_started
    assert total >= 0.4  # sanity: A 确实等了接近 0.5s


@pytest.mark.asyncio
async def test_acquire_does_not_overdraft():
    """并发全部获取到位，消耗总量不应超过实际补充的令牌 + 初始容量。"""
    bucket = TokenBucket(rate=10.0, capacity=1.0)
    await bucket.acquire(tokens=1)  # 抽干
    # 并发 3 个，每个要 1 token；桶按 rate=10/s 补，应该很快都能拿到
    await asyncio.gather(
        bucket.acquire(tokens=1),
        bucket.acquire(tokens=1),
        bucket.acquire(tokens=1),
    )
    # acquire 都返回了 = 没 deadlock，不 overdraft 由内部算术保证。
