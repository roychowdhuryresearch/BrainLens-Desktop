"""
对话并发管理器

使用 asyncio.Semaphore + Queue 实现并发控制，确保同时最多处理 N 个对话请求。
支持配置最大并发数、队列上限、超时等参数。
"""

import asyncio
import logging
from typing import Optional, Callable, Coroutine, Any
from dataclasses import dataclass
import time
from fastapi import HTTPException

logger = logging.getLogger(__name__)


@dataclass
class ConversationTask:
    """对话任务类，用于队列管理"""
    task_id: str  # 任务ID (conversation_id)
    coroutine: Callable[..., Coroutine]
    args: tuple
    kwargs: dict
    priority: int = 0  # 优先级，数字越大优先级越高
    created_at: float = time.time()
    timeout: Optional[float] = None


class ConversationManager:
    """
    对话并发管理器 - 单例模式
    
    功能特点：
    - 使用 Semaphore 控制最大并发数
    - 使用 Queue 管理等待队列
    - 支持优先级队列（可配置）
    - 支持超时机制
    - 支持取消任务
    - 任务完成后自动从队列取下一个执行
    """
    
    _instance = None
    
    def __new__(cls, *args, **kwargs):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance
    
    def __init__(self, max_concurrent: int = 20, queue_maxsize: int = 1000, 
                 enable_priority: bool = False, default_timeout: Optional[float] = None):
        """
        初始化对话管理器
        
        Args:
            max_concurrent: 最大并发对话数
            queue_maxsize: 队列最大容量
            enable_priority: 是否启用优先级队列
            default_timeout: 默认任务超时时间（秒）
        """
        # 如果已经初始化，直接返回
        if hasattr(self, '_initialized') and self._initialized:
            return
            
        # 设置配置参数
        self.max_concurrent = max_concurrent
        self.queue_maxsize = queue_maxsize
        self.enable_priority = enable_priority
        self.default_timeout = default_timeout
        
        # 创建信号量和队列
        self.semaphore = asyncio.Semaphore(max_concurrent)
        self.queue = asyncio.PriorityQueue(maxsize=queue_maxsize) if enable_priority else asyncio.Queue(maxsize=queue_maxsize)
        
        # 任务状态管理
        self.running_tasks: dict[str, asyncio.Task] = {}  # task_id -> Task
        self.task_results: dict[str, Any] = {}  # task_id -> result
        self.task_errors: dict[str, Exception] = {}  # task_id -> error
        
        # 监控指标
        self.metrics = {
            "total_tasks": 0,
            "completed_tasks": 0,
            "failed_tasks": 0,
            "timeout_tasks": 0,
            "queue_full_rejections": 0
        }
        
        # 工作器状态
        self.is_running = True  # 初始化后自动启动
        self._initialized = True
        
        logger.info(f"[ConversationManager] Initialized with max_concurrent={max_concurrent}, queue_maxsize={queue_maxsize}, "
                   f"enable_priority={enable_priority}, default_timeout={default_timeout}")
        logger.info("[ConversationManager] Started automatically after initialization")
    
    def start(self):
        """启动管理器"""
        if not self.is_running:
            self.is_running = True
            logger.info("[ConversationManager] Started")
    
    def stop(self):
        """停止管理器并清理队列中残留的任务引用"""
        if self.is_running:
            self.is_running = False
            # 清理等待中的任务引用，防止内存泄漏
            drained = 0
            if hasattr(self, 'task_queue') and self.task_queue:
                while not self.task_queue.empty():
                    try:
                        self.task_queue.get_nowait()
                        drained += 1
                    except asyncio.QueueEmpty:
                        break
            if hasattr(self, 'running_tasks'):
                self.running_tasks.clear()
            if drained:
                logger.info("[ConversationManager] Drained %d pending tasks from queue", drained)
            logger.info("[ConversationManager] Stopped")
    
    async def submit_task(self, task_id: str, coroutine: Callable[..., Coroutine], 
                        *args, priority: int = 0, timeout: Optional[float] = None, **kwargs) -> Any:
        """
        提交对话任务到队列
        
        Args:
            task_id: 任务ID (conversation_id)
            coroutine: 要执行的协程函数
            args: 协程参数
            priority: 任务优先级（仅当启用优先级队列时有效）
            timeout: 任务超时时间（包括队列等待时间）
            kwargs: 协程关键字参数
            
        Returns:
            任务执行结果
            
        Raises:
            asyncio.QueueFull: 队列已满
            asyncio.TimeoutError: 任务超时（包括等待时间）
            Exception: 任务执行过程中的错误
        """
        if not self.is_running:
            raise RuntimeError("ConversationManager is not running")
        
        # 如果任务已在运行，直接返回结果
        if task_id in self.running_tasks:
            logger.warning(f"[ConversationManager] Task {task_id} is already running")
            return await self.running_tasks[task_id]
        
        # 增加总任务计数
        self.metrics["total_tasks"] += 1
        
        # 创建任务对象
        total_timeout = timeout or self.default_timeout
        task = ConversationTask(
            task_id=task_id,
            coroutine=coroutine,
            args=args,
            kwargs=kwargs,
            priority=-priority if self.enable_priority else 0,  # 优先级队列使用小顶堆，所以取负数
            timeout=total_timeout  # 整个任务的超时时间（包括等待时间）
        )
        
        # 记录任务创建时间
        task_created_at = time.time()
        
        try:
            # 将任务加入队列（带超时）
            put_coro = None
            if self.enable_priority:
                put_coro = self.queue.put((task.priority, task))
            else:
                put_coro = self.queue.put(task)
            
            # 队列放入操作也可能超时
            if total_timeout:
                await asyncio.wait_for(put_coro, timeout=total_timeout)
            else:
                await put_coro
            
            logger.info(f"[ConversationManager] Task {task_id} submitted to queue, priority={priority}, timeout={total_timeout}s, "
                      f"queue_size={self.queue.qsize()}, running_tasks={len(self.running_tasks)}")
            
            # 等待信号量可用并执行任务（带总超时保护）
            async def execute_with_semaphore():
                # 计算剩余时间
                elapsed = time.time() - task_created_at
                remaining = max(0, total_timeout - elapsed) if total_timeout else None
                
                # 获取信号量（如果超时时间已到，会抛出TimeoutError）
                if remaining:
                    await asyncio.wait_for(self.semaphore.acquire(), timeout=remaining)
                else:
                    await self.semaphore.acquire()
                
                try:
                    # 从队列中移除当前任务（因为我们已经获得了信号量，可以执行了）
                    await self._remove_from_queue(task_id)
                    
                    # 执行任务
                    return await self._execute_task_directly(task)
                finally:
                    self.semaphore.release()
            
            # 执行任务并等待结果（带总超时保护）
            if total_timeout:
                result = await asyncio.wait_for(execute_with_semaphore(), timeout=total_timeout)
            else:
                result = await execute_with_semaphore()
                
            # 增加完成任务计数
            self.metrics["completed_tasks"] += 1
            logger.info(f"[ConversationManager] Task {task_id} completed successfully, total_tasks={self.metrics['total_tasks']}, "
                      f"completed_tasks={self.metrics['completed_tasks']}")
            
            return result
            
        except asyncio.QueueFull:
            self.metrics["queue_full_rejections"] += 1
            logger.error(f"[ConversationManager] Queue is full (maxsize={self.queue_maxsize}), cannot submit task {task_id}, "
                       f"rejections={self.metrics['queue_full_rejections']}")
            # 返回更友好的错误信息
            raise HTTPException(
                status_code=429, 
                detail=f"当前请求过多，请稍后再试。系统最大并发数: {self.max_concurrent}, 当前队列大小: {self.queue.qsize()}"
            )
        except asyncio.TimeoutError:
            self.metrics["timeout_tasks"] += 1
            logger.error(f"[ConversationManager] Task {task_id} timed out after {total_timeout}s (including queue wait), "
                       f"timeout_count={self.metrics['timeout_tasks']}")
            # 从队列中移除任务（如果还在队列中）
            await self._remove_from_queue(task_id)
            raise
        except Exception as e:
            self.metrics["failed_tasks"] += 1
            logger.error(f"[ConversationManager] Error processing task {task_id}: {e}, failed_count={self.metrics['failed_tasks']}")
            # 确保任务从队列中移除
            await self._remove_from_queue(task_id)
            raise
    
    async def _execute_task_directly(self, task: ConversationTask) -> Any:
        """
        直接执行任务（不通过信号量，由调用者确保信号量已获取）
        支持执行普通协程和异步生成器
        """
        logger.info(f"[ConversationManager] Executing task {task.task_id} (semaphore: {self.semaphore._value})")
        
        try:
            # 调用协程函数获取结果
            coroutine_result = task.coroutine(*task.args, **task.kwargs)
            
            # 检查是否是异步生成器
            if hasattr(coroutine_result, '__aiter__'):
                logger.info(f"[ConversationManager] Task {task.task_id} is an async generator, returning it directly")
                # 对于异步生成器，直接返回它，由调用者处理迭代
                return coroutine_result
            else:
                # 对于普通协程，使用create_task执行
                task_obj = asyncio.create_task(coroutine_result)
                self.running_tasks[task.task_id] = task_obj
                
                try:
                    result = await task_obj  # 等待任务完成
                    logger.info(f"[ConversationManager] Task {task.task_id} executed successfully")
                    return result
                finally:
                    # 清理任务状态
                    if task.task_id in self.running_tasks:
                        del self.running_tasks[task.task_id]
        except Exception as e:
            logger.error(f"[ConversationManager] Task {task.task_id} failed with error: {e}")
            # 确保任务状态被清理
            if task.task_id in self.running_tasks:
                del self.running_tasks[task.task_id]
            raise
    
    async def _remove_from_queue(self, task_id: str) -> bool:
        """
        从队列中移除指定任务
        
        Args:
            task_id: 任务ID
            
        Returns:
            是否成功移除
        """
        # 由于队列不支持直接删除特定元素，我们需要重新创建队列
        new_queue = None
        removed = False
        
        if self.enable_priority:
            new_queue = asyncio.PriorityQueue(maxsize=self.queue_maxsize)
        else:
            new_queue = asyncio.Queue(maxsize=self.queue_maxsize)
        
        # 逐个取出任务并重新放入新队列，跳过要删除的任务
        while not self.queue.empty():
            try:
                if self.enable_priority:
                    priority, task = self.queue.get_nowait()
                    if task.task_id != task_id:
                        await new_queue.put((priority, task))
                    else:
                        removed = True
                else:
                    task = self.queue.get_nowait()
                    if task.task_id != task_id:
                        await new_queue.put(task)
                    else:
                        removed = True
            except asyncio.QueueEmpty:
                break
        
        # 替换旧队列
        if removed:
            self.queue = new_queue
            logger.info(f"[ConversationManager] Removed task {task_id} from queue")
        
        return removed
    
    async def _execute_task(self, task: ConversationTask) -> Any:
        """
        执行对话任务（内部方法）
        
        Args:
            task: 对话任务对象
            
        Returns:
            任务执行结果
        """
        async with self.semaphore:
            logger.info(f"[ConversationManager] Executing task {task.task_id} (semaphore: {self.semaphore._value})")
            
            # 创建任务
            async def _task_wrapper():
                if task.timeout:
                    return await asyncio.wait_for(
                        task.coroutine(*task.args, **task.kwargs),
                        timeout=task.timeout
                    )
                else:
                    return await task.coroutine(*task.args, **task.kwargs)
            
            # 执行任务
            task_obj = asyncio.create_task(_task_wrapper())
            self.running_tasks[task.task_id] = task_obj
            
            try:
                result = await task_obj
                logger.info(f"[ConversationManager] Task {task.task_id} completed successfully")
                return result
            except Exception as e:
                logger.error(f"[ConversationManager] Task {task.task_id} failed with error: {e}")
                raise
            finally:
                # 清理任务状态
                if task.task_id in self.running_tasks:
                    del self.running_tasks[task.task_id]
    
    async def cancel_task(self, task_id: str) -> bool:
        """
        取消指定任务
        
        Args:
            task_id: 任务ID
            
        Returns:
            是否成功取消
        """
        # 检查是否是运行中的任务
        if task_id in self.running_tasks:
            task = self.running_tasks[task_id]
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                logger.info(f"[ConversationManager] Task {task_id} cancelled")
            finally:
                if task_id in self.running_tasks:
                    del self.running_tasks[task_id]
            return True
        
        # 尝试从等待队列中移除任务
        if hasattr(self, 'task_queue') and self.task_queue:
            removed = False
            temp_items = []
            try:
                while not self.task_queue.empty():
                    item = self.task_queue.get_nowait()
                    if hasattr(item, 'task_id') and item.task_id == task_id:
                        removed = True
                        logger.info(f"[ConversationManager] Removed queued task {task_id}")
                    else:
                        temp_items.append(item)
            except asyncio.QueueEmpty:
                pass
            # 放回其他任务
            for item in temp_items:
                try:
                    self.task_queue.put_nowait(item)
                except asyncio.QueueFull:
                    break
            if removed:
                return True

        logger.warning(f"[ConversationManager] Task {task_id} not found")
        return False
    
    def get_queue_size(self) -> int:
        """获取当前队列大小"""
        return self.queue.qsize()
    
    def get_running_count(self) -> int:
        """获取当前运行中的任务数"""
        return len(self.running_tasks)
    
    def get_stats(self) -> dict:
        """获取管理器统计信息"""
        return {
            "max_concurrent": self.max_concurrent,
            "queue_size": self.queue.qsize(),
            "running_tasks": len(self.running_tasks),
            "available_slots": self.semaphore._value,
            "queue_maxsize": self.queue_maxsize,
            "enable_priority": self.enable_priority,
            "metrics": {
                "total_tasks": self.metrics["total_tasks"],
                "completed_tasks": self.metrics["completed_tasks"],
                "failed_tasks": self.metrics["failed_tasks"],
                "timeout_tasks": self.metrics["timeout_tasks"],
                "queue_full_rejections": self.metrics["queue_full_rejections"]
            }
        }


# 全局对话管理器实例
def get_conversation_manager() -> ConversationManager:
    """获取全局对话管理器实例"""
    return ConversationManager()


# 初始化管理器
def init_conversation_manager(max_concurrent: int = 20, queue_maxsize: int = 1000, 
                             enable_priority: bool = False, default_timeout: Optional[float] = None) -> None:
    """初始化全局对话管理器"""
    manager = ConversationManager()
    # 如果未初始化或参数不同，重新初始化
    if not hasattr(manager, '_initialized') or not manager._initialized or \
       manager.max_concurrent != max_concurrent or \
       manager.queue_maxsize != queue_maxsize or \
       manager.enable_priority != enable_priority or \
       manager.default_timeout != default_timeout:
        
        # 重新初始化
        manager.__init__(max_concurrent=max_concurrent, 
                        queue_maxsize=queue_maxsize, 
                        enable_priority=enable_priority, 
                        default_timeout=default_timeout)
    
    # 确保管理器已启动
    manager.start()