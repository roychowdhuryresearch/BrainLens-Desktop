"""
User Input Handler - 处理 skill 执行过程中的用户交互

允许 AI 在执行过程中请求用户输入，实现真正的交互式工作流。

核心机制：
1. AI 调用 request_user_input 工具
2. 后端发送 SSE 事件通知前端
3. 协程挂起，等待用户响应
4. 用户响应后，恢复协程继续执行
"""

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Dict, Optional, Any, List
import uuid

logger = logging.getLogger(__name__)

# 用户输入超时时间（秒）
USER_INPUT_TIMEOUT_SECONDS = 300  # 5 分钟


@dataclass
class PendingUserInput:
    """待处理的用户输入请求
    
    每个会话同时只能有一个待处理的用户输入请求。
    """
    conversation_id: str          # 会话 ID（隔离 key）
    user_id: str                  # 用户 ID（双重校验）
    input_id: str                 # 请求唯一 ID
    prompt: str                   # 提示信息
    input_type: str               # 输入类型: text, confirm, choice
    options: List[str] = field(default_factory=list)  # 选项列表（choice 类型）
    timeout: int = USER_INPUT_TIMEOUT_SECONDS  # 超时时间（秒）
    skill: Optional[str] = None   # 当前 skill 名称
    step_id: Optional[str] = None # 当前步骤 ID
    memory_writeback: Optional[Dict[str, Any]] = None  # 可选：HITL 选择后的 memory 写回配置
    
    # 内部状态
    event: asyncio.Event = field(default_factory=asyncio.Event)
    result: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    created_at: datetime = field(default_factory=datetime.now)
    input_metadata: Optional[Dict[str, Any]] = None
    
    def to_sse_data(self) -> Dict[str, Any]:
        """转换为 SSE 事件数据"""
        return {
            "input_id": self.input_id,
            "conversation_id": self.conversation_id,
            "prompt": self.prompt,
            "input_type": self.input_type,
            "options": self.options,
            "timeout": self.timeout,
            "skill": self.skill,
            "step_id": self.step_id,
            "memory_writeback": dict(self.memory_writeback) if isinstance(self.memory_writeback, dict) else None,
            "input_metadata": dict(self.input_metadata) if isinstance(self.input_metadata, dict) else None,
        }
    
    def is_expired(self) -> bool:
        """检查是否已超时"""
        return (datetime.now() - self.created_at).total_seconds() > self.timeout


# 全局待处理用户输入字典
# key: conversation_id, value: PendingUserInput
_pending_user_inputs: Dict[str, PendingUserInput] = {}


def create_user_input_request(
    conversation_id: str,
    user_id: str,
    prompt: str,
    input_type: str,
    options: Optional[List[str]] = None,
    timeout: int = USER_INPUT_TIMEOUT_SECONDS,
    skill: Optional[str] = None,
    step_id: Optional[str] = None,
    memory_writeback: Optional[Dict[str, Any]] = None,
    input_metadata: Optional[Dict[str, Any]] = None,
) -> PendingUserInput:
    """创建用户输入请求
    
    Args:
        conversation_id: 会话 ID
        user_id: 用户 ID
        prompt: 提示信息
        input_type: 输入类型 (text, confirm, choice)
        options: 选项列表（choice 类型必填）
        timeout: 超时时间（秒）
        skill: 当前 skill 名称
        step_id: 当前步骤 ID
        
    Returns:
        PendingUserInput 实例
    """
    existing = _pending_user_inputs.get(conversation_id)
    if existing is not None:
        existing.error = "superseded"
        existing.event.set()
        logger.warning(
            "[UserInput] Superseded existing request: conversation_id=%s, input_id=%s",
            conversation_id,
            existing.input_id,
        )

    input_id = f"ui_{conversation_id}_{uuid.uuid4().hex[:8]}"
    
    pending = PendingUserInput(
        conversation_id=conversation_id,
        user_id=user_id,
        input_id=input_id,
        prompt=prompt,
        input_type=input_type,
        options=list(options or []),
        timeout=timeout,
        skill=skill,
        step_id=step_id,
        memory_writeback=(dict(memory_writeback) if isinstance(memory_writeback, dict) else None),
        input_metadata=(dict(input_metadata) if isinstance(input_metadata, dict) else None),
    )
    
    _pending_user_inputs[conversation_id] = pending
    logger.info(f"[UserInput] Created request: input_id={input_id}, conversation_id={conversation_id}, type={input_type}")
    
    return pending


def get_pending_input(conversation_id: str) -> Optional[PendingUserInput]:
    """获取待处理的用户输入请求
    
    Args:
        conversation_id: 会话 ID
        
    Returns:
        PendingUserInput 或 None
    """
    return _pending_user_inputs.get(conversation_id)


def submit_user_input(
    conversation_id: str,
    user_id: str,
    input_id: str,
    value: Any,
) -> Dict[str, Any]:
    """提交用户输入
    
    Args:
        conversation_id: 会话 ID
        user_id: 用户 ID
        input_id: 输入请求 ID
        value: 用户输入值
        
    Returns:
        {"success": bool, "error": str (如果失败), "memory_writeback": Optional[dict]}
    """
    pending = _pending_user_inputs.get(conversation_id)
    
    # 校验 1: 请求是否存在
    if not pending:
        logger.warning(f"[UserInput] No pending request for conversation: {conversation_id}")
        return {"success": False, "error": "没有待处理的输入请求"}
    
    # 校验 2: 用户 ID 是否匹配
    if pending.user_id != user_id:
        logger.warning(f"[UserInput] User mismatch: expected={pending.user_id}, actual={user_id}")
        return {"success": False, "error": "无权操作此请求"}
    
    # 校验 3: input_id 是否匹配
    if pending.input_id != input_id:
        logger.warning(f"[UserInput] Input ID mismatch: expected={pending.input_id}, actual={input_id}")
        return {"success": False, "error": "无效的输入请求"}
    
    # 校验 4: 是否已超时
    if pending.is_expired():
        logger.warning(f"[UserInput] Request expired: input_id={input_id}")
        cleanup_pending_input(conversation_id)
        return {"success": False, "error": "输入请求已超时"}
    
    # 设置结果并唤醒等待的协程
    memory_writeback = dict(pending.memory_writeback) if isinstance(pending.memory_writeback, dict) else None
    input_metadata = dict(pending.input_metadata) if isinstance(pending.input_metadata, dict) else None
    pending.result = {"value": value}
    pending.event.set()
    
    logger.info(f"[UserInput] Submitted: input_id={input_id}, value_type={type(value).__name__}")
    
    # 清理
    cleanup_pending_input(conversation_id)
    
    return {
        "success": True,
        "memory_writeback": memory_writeback,
        "input_metadata": input_metadata,
        "submitted_value": value,
    }


def cancel_pending_input(conversation_id: str, reason: str = "cancelled") -> None:
    """取消待处理的用户输入请求
    
    Args:
        conversation_id: 会话 ID
        reason: 取消原因
    """
    pending = _pending_user_inputs.get(conversation_id)
    if pending:
        pending.error = reason
        pending.event.set()
        cleanup_pending_input(conversation_id)
        logger.info(f"[UserInput] Cancelled: conversation_id={conversation_id}, reason={reason}")


def cleanup_pending_input(conversation_id: str) -> None:
    """清理待处理的用户输入请求
    
    Args:
        conversation_id: 会话 ID
    """
    if conversation_id in _pending_user_inputs:
        del _pending_user_inputs[conversation_id]
        logger.debug(f"[UserInput] Cleaned up: conversation_id={conversation_id}")


async def wait_for_user_input(
    conversation_id: str,
    user_id: str,
    prompt: str,
    input_type: str,
    options: Optional[List[str]] = None,
    timeout: int = USER_INPUT_TIMEOUT_SECONDS,
    skill: Optional[str] = None,
    step_id: Optional[str] = None,
    memory_writeback: Optional[Dict[str, Any]] = None,
    input_metadata: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """等待用户输入（异步）
    
    创建用户输入请求并等待用户响应。
    
    Args:
        conversation_id: 会话 ID
        user_id: 用户 ID
        prompt: 提示信息
        input_type: 输入类型
        options: 选项列表
        timeout: 超时时间
        skill: 当前 skill 名称
        step_id: 当前步骤 ID
        
    Returns:
        {"value": Any, "success": bool, "error": str (如果失败)}
    """
    # 创建请求
    pending = create_user_input_request(
        conversation_id=conversation_id,
        user_id=user_id,
        prompt=prompt,
        input_type=input_type,
        options=options,
        timeout=timeout,
        skill=skill,
        step_id=step_id,
        memory_writeback=memory_writeback,
        input_metadata=input_metadata,
    )
    
    try:
        # 等待用户响应或超时
        await asyncio.wait_for(pending.event.wait(), timeout=timeout)
        
        if pending.error:
            return {"value": None, "success": False, "error": pending.error}
        
        if pending.result:
            return {"value": pending.result.get("value"), "success": True}
        
        return {"value": None, "success": False, "error": "Unknown error"}
        
    except asyncio.TimeoutError:
        logger.warning(f"[UserInput] Timeout waiting for user input: conversation_id={conversation_id}")
        cleanup_pending_input(conversation_id)
        return {"value": None, "success": False, "error": "等待用户输入超时"}
    
    except Exception as e:
        logger.error(f"[UserInput] Error waiting for user input: {e}")
        cleanup_pending_input(conversation_id)
        return {"value": None, "success": False, "error": str(e)}


def get_user_input_tool_definition() -> Dict[str, Any]:
    """获取 request_user_input 工具定义
    
    Returns:
        OpenAI 格式的工具定义
    """
    return {
        "type": "function",
        "function": {
            "name": "request_user_input",
            "description": (
                "向用户请求输入或确认，暂停当前执行等待用户响应。"
                "当你需要用户提供额外信息、确认操作或做出选择时使用此工具。"
                "此工具会暂停执行，直到用户响应或超时。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "prompt": {
                        "type": "string",
                        "description": "向用户展示的提示信息，清晰描述你需要什么输入"
                    },
                    "input_type": {
                        "type": "string",
                        "enum": ["text", "confirm", "choice"],
                        "description": (
                            "输入类型："
                            "'text' - 文本输入，用户可以输入任意文本；"
                            "'confirm' - 确认/取消，用户选择是或否；"
                            "'choice' - 选项选择，用户从预设选项中选择一个"
                        )
                    },
                    "options": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "选项列表，仅在 input_type 为 'choice' 时使用，提供可选的选项"
                    },
                    "timeout": {
                        "type": "integer",
                        "description": "超时时间（秒），默认 300 秒（5分钟）"
                    },
                    "memory_writeback": {
                        "type": "object",
                        "description": (
                            "可选：描述用户选择后如何写回 memory。"
                            "建议包含 memory_kind、namespace、key、activation_context、fingerprint_fields 等字段。"
                            "如果前端支持，可让用户选择 use_once / session / durable。"
                        )
                    }
                },
                "required": ["prompt", "input_type"]
            }
        }
    }


# 后台清理任务
async def cleanup_expired_inputs():
    """定时清理过期的等待请求
    
    应该作为后台任务运行。
    """
    while True:
        await asyncio.sleep(60)  # 每分钟检查一次
        
        expired_conv_ids = []
        for conv_id, pending in _pending_user_inputs.items():
            if pending.is_expired():
                expired_conv_ids.append(conv_id)
        
        for conv_id in expired_conv_ids:
            pending = _pending_user_inputs.get(conv_id)
            if pending:
                pending.error = "timeout"
                pending.event.set()
            cleanup_pending_input(conv_id)
        
        if expired_conv_ids:
            logger.info(f"[UserInput] Cleaned up {len(expired_conv_ids)} expired requests")
