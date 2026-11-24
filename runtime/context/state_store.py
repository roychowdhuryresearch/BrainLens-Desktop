"""
Context State Store - 会话状态存储

管理会话上下文状态的持久化存储。
第一版使用内存实现，后续可替换为 Redis/DB。
"""

from typing import Dict, Optional
from runtime.context.models import ConversationContextState
import logging

logger = logging.getLogger(__name__)


class InMemoryContextStateStore:
    """内存状态存储（第一版实现）
    
    后续可替换为 Redis / DB 实现。
    注意：重启后状态会丢失。
    """
    
    def __init__(self):
        self._store: Dict[str, ConversationContextState] = {}
    
    async def load(self, conversation_id: str) -> ConversationContextState:
        """加载会话状态，不存在则返回新实例
        
        Args:
            conversation_id: 会话 ID
            
        Returns:
            会话状态对象
        """
        state = self._store.get(conversation_id)
        if state:
            logger.debug(f"[ContextStore] Loaded state for conversation: {conversation_id}")
            return state
        
        # 不存在则创建新状态
        new_state = ConversationContextState(conversation_id=conversation_id)
        logger.debug(f"[ContextStore] Created new state for conversation: {conversation_id}")
        return new_state
    
    async def save(self, state: ConversationContextState) -> None:
        """保存会话状态
        
        Args:
            state: 要保存的会话状态
        """
        self._store[state.conversation_id] = state
        logger.debug(f"[ContextStore] Saved state for conversation: {state.conversation_id}, "
                    f"total_turns={state.total_turns}, summary_len={len(state.rolling_summary)}")
    
    async def delete(self, conversation_id: str) -> None:
        """删除会话状态
        
        Args:
            conversation_id: 要删除的会话 ID
        """
        if conversation_id in self._store:
            del self._store[conversation_id]
            logger.debug(f"[ContextStore] Deleted state for conversation: {conversation_id}")
    
    async def clear_all(self) -> None:
        """清空所有会话状态"""
        self._store.clear()
        logger.info("[ContextStore] Cleared all conversation states")
    
    def get_store_size(self) -> int:
        """获取存储的会话数量"""
        return len(self._store)
    
    def get_all_conversation_ids(self) -> list:
        """获取所有会话 ID"""
        return list(self._store.keys())