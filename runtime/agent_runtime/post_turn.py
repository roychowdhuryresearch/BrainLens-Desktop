"""Post-turn background task registry.

Turn 的主链路在 `yield done` 之前，只做会改 `final_content` 的事（verification /
repair / language_align）和下一轮会立刻依赖的事（save_runtime_state）。剩下的
副作用——context summary、durable memory 写入——丢到这里跑，对用户延迟没影响。

设计点：
- **Strong-ref 持有**：如果只 `asyncio.create_task` 不持有引用，Python 的 GC 会在
  任务完成前把它回收掉（3.11+ 实测会 emit "Task was destroyed but it is pending"
  警告，并可能丢副作用）。这里用一个 module-level set 持有。
- **不抛出**：每个后台任务都用 `_safe()` wrapper catch 所有异常，只记日志 —
  后台失败绝不应该让另一个 turn 看起来正常但状态不一致。
- **Shutdown join**：`runtime/main.py` 的 shutdown hook 会 `await_all()` 等待未
  完成的任务，最多等 `shutdown_timeout` 秒；超时直接 cancel。

Cancellation 语义：
- 用户点"停止"只会 cancel 正在生成内容的主请求；已经 emit done 之后的后台任务和
  主请求的 asyncio task 没绑定关系（`create_task` 独立于 request scope），因此
  该写的 memory 仍然会写完。这是有意的。
- 进程级 shutdown 时，我们**先 await（带超时）再 cancel**，因为 durable memory
  写了一半等于没写，宁愿等一会儿。
"""

from __future__ import annotations

import asyncio
import logging
from typing import Awaitable, Dict, Optional, Set

logger = logging.getLogger(__name__)

_tasks: Set[asyncio.Task] = set()
_tasks_by_conv: Dict[str, Set[asyncio.Task]] = {}
# 已经 emit done、处于"背景收尾"阶段的任务。独立于 _tasks_by_conv，这样
# cancel_for_conversation 碰不到它们，但 wait_for_conversation 仍能等到它们。
_released_by_conv: Dict[str, Set[asyncio.Task]] = {}


def schedule(
    coro: Awaitable,
    *,
    name: Optional[str] = None,
    conv_id: Optional[str] = None,
) -> asyncio.Task:
    """Fire-and-forget 一个 coroutine，持有 strong ref 防止 GC。

    传入的 coroutine 内部自己负责 logging / observability。本函数只做兜底 catch：
    即便漏了 try/except，异常也只会进 logger 而不会让 task 泄漏到顶层 handler。

    `conv_id` 可选。传了之后会进入 per-conversation 桶，下一轮 bootstrap 可以用
    `wait_for_conversation()` 等这轮的 save / memory write 落盘，用户在 conversation
    被取消时也能精确 cancel 该会话的 pending tasks（见 `cancel_for_conversation`）。
    """
    task = asyncio.create_task(_safe(coro, name=name), name=name or "post_turn")
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    if conv_id:
        bucket = _tasks_by_conv.setdefault(conv_id, set())
        bucket.add(task)

        def _cleanup(t: asyncio.Task, cid: str = conv_id) -> None:
            b = _tasks_by_conv.get(cid)
            if b is None:
                return
            b.discard(t)
            if not b:
                _tasks_by_conv.pop(cid, None)

        task.add_done_callback(_cleanup)
    return task


async def _safe(coro: Awaitable, *, name: Optional[str]) -> None:
    try:
        await coro
    except asyncio.CancelledError:
        logger.info("[PostTurn] %s cancelled", name or "task")
        raise
    except Exception as exc:
        logger.warning("[PostTurn] %s failed: %s", name or "task", exc, exc_info=True)


async def await_all(*, timeout: float = 10.0) -> int:
    """Shutdown 时调用。返回被 cancel 的任务数。"""
    if not _tasks:
        return 0
    pending = list(_tasks)
    logger.info("[PostTurn] waiting for %d background task(s) up to %.1fs", len(pending), timeout)
    done, still_pending = await asyncio.wait(pending, timeout=timeout)
    cancelled = 0
    for task in still_pending:
        task.cancel()
        cancelled += 1
    if cancelled:
        logger.warning("[PostTurn] cancelled %d task(s) after %.1fs shutdown timeout", cancelled, timeout)
        # 给 cancel 传播一点时间，避免直接返回后事件循环关闭告警
        await asyncio.gather(*still_pending, return_exceptions=True)
    return cancelled


def pending_count() -> int:
    """Testing / observability 用。"""
    return len(_tasks)


async def wait_for_conversation(conv_id: str, *, timeout: float = 3.0) -> int:
    """等这个 conversation 下所有在跑的 post-turn 任务完成。

    用在下一轮 turn 的 bootstrap 开头：上一轮 `save_runtime_state` 落到后台之后，
    next-turn 读 state 前必须先等它写完，否则会读到上上轮的状态。

    注意：既等 cancellable 桶里的（当前 turn 的），也等已 release 的（上一轮的，
    done 已 emit 但副作用还在跑）。否则 release 之后这些任务对 wait 不可见，下一轮
    bootstrap 会在 save_state 还没落盘时就开始读 state。
    """
    pending = list(_tasks_by_conv.get(conv_id, set())) + list(_released_by_conv.get(conv_id, set()))
    pending = [t for t in pending if not t.done()]
    if not pending:
        return 0
    done, _ = await asyncio.wait(pending, timeout=timeout)
    return len(done)


def cancel_for_conversation(conv_id: str) -> int:
    """取消该 conversation 下**尚未 release** 的 post-turn 任务。

    用途：用户在 HTTP 层按"停止"（/chat/cancel/<conv>）时，要中断当前正在跑的
    turn——包括那个 turn 已经 schedule 出去但 done 还没 emit 的 post-turn 任务。
    但**已经 emit 过 done 的旧 turn 的 post-turn 任务**（调用了 release_conversation
    后移到 `_released_by_conv`）不受影响，它们对用户而言是已完成 turn 的背景收尾，
    继续跑完才不会让下一轮读到"已完成但没落盘"的状态。
    """
    bucket = _tasks_by_conv.get(conv_id)
    if not bucket:
        return 0
    cancelled = 0
    for task in list(bucket):
        if not task.done():
            task.cancel()
            cancelled += 1
    return cancelled


def release_conversation(conv_id: str) -> int:
    """标记该 conversation 当前 turn 的 post-turn 任务为"已 emit done，背景收尾中"。

    调用时机：orchestrator 在 `emit_final_content_and_done` yield 完 `done` 事件
    之后（成功或失败分支的 finally 里）。把任务从 cancellable 桶 `_tasks_by_conv`
    搬到 `_released_by_conv`，这样后续的 cancel_for_conversation 不会再 cancel 它们，
    同时 wait_for_conversation 仍能等到这批任务完成，下一轮 bootstrap 读到的 state
    是一致的。返回被 release 的任务数。
    """
    bucket = _tasks_by_conv.pop(conv_id, None)
    if not bucket:
        return 0
    released = _released_by_conv.setdefault(conv_id, set())
    pending_count = 0
    for task in list(bucket):
        if task.done():
            continue
        released.add(task)
        pending_count += 1

        def _released_cleanup(t: asyncio.Task, cid: str = conv_id) -> None:
            r = _released_by_conv.get(cid)
            if r is None:
                return
            r.discard(t)
            if not r:
                _released_by_conv.pop(cid, None)

        task.add_done_callback(_released_cleanup)
    return pending_count
