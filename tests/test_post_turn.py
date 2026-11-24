"""Unit tests for agent.app.agent_runtime.post_turn — fire-and-forget task registry."""
from __future__ import annotations

import asyncio

import pytest

from runtime.agent_runtime import post_turn


@pytest.fixture(autouse=True)
def _clear_registry():
    # 每条测试跑完尝试 drain，避免任务跨测试污染
    yield
    if post_turn.pending_count():
        asyncio.new_event_loop().run_until_complete(post_turn.await_all(timeout=0.5))


def test_schedule_runs_coroutine():
    async def body():
        outcomes = []
        post_turn.schedule(_set(outcomes, "ran"), name="test-ok")
        # 给事件循环一轮执行的机会
        for _ in range(10):
            if outcomes:
                break
            await asyncio.sleep(0.005)
        assert outcomes == ["ran"]
        assert post_turn.pending_count() == 0

    asyncio.run(body())


def test_schedule_swallows_exceptions():
    async def body():
        async def blow_up():
            raise RuntimeError("boom")

        post_turn.schedule(blow_up(), name="test-err")
        await asyncio.sleep(0.02)
        # 任务从 registry 里被清掉说明 done_callback 跑了；没有任何异常冒到这里
        assert post_turn.pending_count() == 0

    asyncio.run(body())


def test_await_all_waits_for_pending_tasks():
    async def body():
        completed: list[str] = []

        async def slow(tag: str, delay: float):
            await asyncio.sleep(delay)
            completed.append(tag)

        post_turn.schedule(slow("fast", 0.01), name="fast")
        post_turn.schedule(slow("mid", 0.03), name="mid")

        cancelled = await post_turn.await_all(timeout=1.0)
        assert cancelled == 0
        assert sorted(completed) == ["fast", "mid"]
        assert post_turn.pending_count() == 0

    asyncio.run(body())


def test_await_all_cancels_over_timeout():
    async def body():
        async def forever():
            try:
                await asyncio.sleep(5.0)
            except asyncio.CancelledError:
                raise

        post_turn.schedule(forever(), name="forever")

        cancelled = await post_turn.await_all(timeout=0.05)
        assert cancelled == 1

    asyncio.run(body())


async def _set(outcomes, tag):
    outcomes.append(tag)


def test_wait_for_conversation_drains_pending():
    async def body():
        order: list[str] = []

        async def slow():
            await asyncio.sleep(0.05)
            order.append("done")

        post_turn.schedule(slow(), name="save-A", conv_id="conv-A")
        # 另一个 conv 的任务不应阻塞我们等 conv-A
        post_turn.schedule(asyncio.sleep(0.5), name="unrelated", conv_id="conv-B")

        drained = await post_turn.wait_for_conversation("conv-A", timeout=1.0)
        assert drained == 1
        assert order == ["done"]
        # conv-B 的任务还在跑
        assert "conv-B" in post_turn._tasks_by_conv
        post_turn.cancel_for_conversation("conv-B")
        await asyncio.sleep(0.02)

    asyncio.run(body())


def test_wait_for_conversation_no_tasks_returns_zero():
    async def body():
        drained = await post_turn.wait_for_conversation("never-seen", timeout=0.5)
        assert drained == 0

    asyncio.run(body())


def test_cancel_for_conversation_cancels_pending():
    async def body():
        async def slow():
            await asyncio.sleep(5.0)

        post_turn.schedule(slow(), name="mem-A", conv_id="conv-X")
        post_turn.schedule(slow(), name="sum-A", conv_id="conv-X")
        post_turn.schedule(slow(), name="mem-Y", conv_id="conv-Y")

        cancelled = post_turn.cancel_for_conversation("conv-X")
        assert cancelled == 2

        # conv-Y 的没受影响
        assert len(post_turn._tasks_by_conv.get("conv-Y") or set()) == 1
        # 清理 conv-Y
        post_turn.cancel_for_conversation("conv-Y")
        await asyncio.sleep(0.02)

    asyncio.run(body())


def test_released_tasks_survive_subsequent_cancel():
    """turn 1 emit done → release → turn 2 cancel 该 conv 时不应误伤 turn 1 的背景任务。

    复现场景：turn 1 写 save_state / summary / memory 是 fire-and-forget。
    用户紧接着发 turn 2，然后在 turn 2 途中按"停止"。/chat/cancel 会调
    cancel_for_conversation(conv)。修复前，这会把 turn 1 的仍在跑的任务一并 cancel，
    导致用户看到 turn 1 的答案但它的 state 根本没落盘，下一轮读到旧状态。
    """
    async def body():
        outcomes: list[str] = []

        async def turn1_memory_write():
            try:
                await asyncio.sleep(0.05)
                outcomes.append("turn1-memory-written")
            except asyncio.CancelledError:
                outcomes.append("turn1-memory-CANCELLED")
                raise

        async def turn2_stuck():
            try:
                await asyncio.sleep(5.0)
            except asyncio.CancelledError:
                outcomes.append("turn2-CANCELLED")
                raise

        # turn 1: schedule + done emit 后 release
        post_turn.schedule(turn1_memory_write(), name="mem-T1", conv_id="conv-Z")
        released = post_turn.release_conversation("conv-Z")
        assert released == 1

        # turn 2: schedule 新任务，让事件循环进入任务体再取消
        post_turn.schedule(turn2_stuck(), name="turn2-stream", conv_id="conv-Z")
        await asyncio.sleep(0)  # 让 turn2_stuck 进入 try

        # 用户在 turn 2 按停止
        cancelled = post_turn.cancel_for_conversation("conv-Z")
        assert cancelled == 1  # 只取消 turn 2

        # 等 turn 1 的后台任务跑完 + turn 2 cancel handler 跑
        await asyncio.sleep(0.1)
        assert "turn1-memory-written" in outcomes
        assert "turn1-memory-CANCELLED" not in outcomes
        assert "turn2-CANCELLED" in outcomes

    asyncio.run(body())


def test_wait_for_conversation_covers_released_tasks():
    """下一轮 bootstrap 必须能 wait 到已 release 的上一轮任务，否则读到半写状态。"""
    async def body():
        order: list[str] = []

        async def slow_save():
            await asyncio.sleep(0.05)
            order.append("save-done")

        post_turn.schedule(slow_save(), name="save-T1", conv_id="conv-W")
        # orchestrator emit done 后调 release
        post_turn.release_conversation("conv-W")

        drained = await post_turn.wait_for_conversation("conv-W", timeout=1.0)
        assert drained == 1
        assert order == ["save-done"]

    asyncio.run(body())
