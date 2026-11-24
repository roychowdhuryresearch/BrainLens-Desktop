"""
Message Repository - 消息仓储

负责消息的 CRUD 操作
"""

import json
from typing import Optional, List
from runtime.agent_history.db import SessionLocal
from runtime.agent_history.models import AgentMessage


class MessageRepository:
    """消息仓储"""

    def create(
        self,
        conversation_id: str,
        message_id: str,
        role: str,
        content: str,
        name: str = None,
        tool_call_id: str = None,
        sources: List[dict] = None,
    ) -> AgentMessage:
        """创建消息"""
        db = SessionLocal()
        try:
            msg = AgentMessage(
                id=message_id,
                conversation_id=conversation_id,
                role=role,
                content=content,
                name=name,
                tool_call_id=tool_call_id,
                sources=json.dumps(sources, ensure_ascii=False) if sources else None,
            )
            db.add(msg)
            db.commit()
            db.refresh(msg)
            return msg
        finally:
            db.close()

    def get(self, message_id: str) -> Optional[AgentMessage]:
        """获取消息"""
        db = SessionLocal()
        try:
            return db.query(AgentMessage).filter(
                AgentMessage.id == message_id
            ).first()
        finally:
            db.close()

    def get_by_conversation(
        self,
        conversation_id: str,
        limit: int = 100,
        offset: int = 0,
    ) -> List[AgentMessage]:
        """获取对话的所有消息"""
        db = SessionLocal()
        try:
            return (
                db.query(AgentMessage)
                .filter(AgentMessage.conversation_id == conversation_id)
                .order_by(AgentMessage.created_at.asc())
                .offset(offset)
                .limit(limit)
                .all()
            )
        finally:
            db.close()

    def get_recent(
        self,
        conversation_id: str,
        limit: int = 20,
    ) -> List[dict]:
        """获取最近的消息（Agent 用）"""
        db = SessionLocal()
        try:
            messages = (
                db.query(AgentMessage)
                .filter(AgentMessage.conversation_id == conversation_id)
                .order_by(AgentMessage.created_at.desc())
                .limit(limit)
                .all()
            )
            # 反转顺序，返回从旧到新
            messages = list(reversed(messages))
            return [self._to_dict(m) for m in messages]
        finally:
            db.close()

    def get_message_count(self, conversation_id: str) -> int:
        """获取消息数量"""
        db = SessionLocal()
        try:
            return (
                db.query(AgentMessage)
                .filter(AgentMessage.conversation_id == conversation_id)
                .count()
            )
        finally:
            db.close()

    def delete_by_conversation(self, conversation_id: str) -> int:
        """删除对话的所有消息"""
        db = SessionLocal()
        try:
            count = (
                db.query(AgentMessage)
                .filter(AgentMessage.conversation_id == conversation_id)
                .delete()
            )
            db.commit()
            return count
        finally:
            db.close()

    def _to_dict(self, msg: AgentMessage) -> dict:
        """转换为字典"""
        return msg.to_dict()


__all__ = ["MessageRepository"]
