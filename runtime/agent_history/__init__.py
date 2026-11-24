"""
Agent History - Agent 独立历史对话持久化存储层

职责：
- 存储 Agent 运行过程中的对话历史
- 存储轮次记录（skill路由、tool调用）
- 存储滚动摘要（ContextManager 用）

与 app/api/conversations.py 完全独立：
- 数据库文件：agent_history/history.db
- 用途：Agent 运行数据，非前端展示
"""

from runtime.agent_history.db import get_db_session, init_db
from runtime.agent_history.conversation_repo import ConversationRepository
from runtime.agent_history.message_repo import MessageRepository
from runtime.agent_history.turn_repo import TurnRepository
from runtime.agent_history.summary_repo import SummaryRepository
from runtime.agent_history.observability_service import (
    AgentObservabilityService,
    get_agent_observability_service,
)

# 全局仓储实例
_conversation_repo: ConversationRepository = None
_message_repo: MessageRepository = None
_turn_repo: TurnRepository = None
_summary_repo: SummaryRepository = None


def get_conversation_repo() -> ConversationRepository:
    """获取对话仓储实例"""
    global _conversation_repo
    if _conversation_repo is None:
        _conversation_repo = ConversationRepository()
    return _conversation_repo


def get_message_repo() -> MessageRepository:
    """获取消息仓储实例"""
    global _message_repo
    if _message_repo is None:
        _message_repo = MessageRepository()
    return _message_repo


def get_turn_repo() -> TurnRepository:
    """获取轮次仓储实例"""
    global _turn_repo
    if _turn_repo is None:
        _turn_repo = TurnRepository()
    return _turn_repo


def get_summary_repo() -> SummaryRepository:
    """获取摘要仓储实例"""
    global _summary_repo
    if _summary_repo is None:
        _summary_repo = SummaryRepository()
    return _summary_repo


__all__ = [
    "init_db",
    "get_db_session",
    "ConversationRepository",
    "MessageRepository",
    "TurnRepository",
    "SummaryRepository",
    "AgentObservabilityService",
    "get_conversation_repo",
    "get_message_repo",
    "get_turn_repo",
    "get_summary_repo",
    "get_agent_observability_service",
]
