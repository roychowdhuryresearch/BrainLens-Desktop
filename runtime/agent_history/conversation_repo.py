"""
Conversation Repository - 对话仓储

负责对话的 CRUD 操作
"""

from typing import Optional, List
from datetime import datetime
from sqlalchemy.orm import Session
from runtime.agent_history.db import SessionLocal
from runtime.agent_history.models import AgentConversation


class ConversationRepository:
    """对话仓储"""

    def create(
        self,
        conversation_id: str,
        user_id: str,
        source: str = "web",
        external_conversation_id: str = None,
        title: str = None,
    ) -> AgentConversation:
        """创建对话"""
        db = SessionLocal()
        try:
            conv = AgentConversation(
                id=conversation_id,
                user_id=user_id,
                source=source,
                external_conversation_id=external_conversation_id,
                title=title or "新对话",
                status="active",
            )
            db.add(conv)
            db.commit()
            db.refresh(conv)
            return conv
        finally:
            db.close()

    def get(self, conversation_id: str) -> Optional[AgentConversation]:
        """获取对话"""
        db = SessionLocal()
        try:
            return db.query(AgentConversation).filter(
                AgentConversation.id == conversation_id
            ).first()
        finally:
            db.close()

    def get_by_external_id(self, external_id: str) -> Optional[AgentConversation]:
        """通过外部 ID 获取对话"""
        db = SessionLocal()
        try:
            return db.query(AgentConversation).filter(
                AgentConversation.external_conversation_id == external_id
            ).first()
        finally:
            db.close()

    def update_title(self, conversation_id: str, title: str) -> Optional[AgentConversation]:
        """更新对话标题"""
        db = SessionLocal()
        try:
            conv = db.query(AgentConversation).filter(
                AgentConversation.id == conversation_id
            ).first()
            if conv:
                conv.title = title
                conv.updated_at = datetime.utcnow()
                db.commit()
                db.refresh(conv)
            return conv
        finally:
            db.close()

    def update_status(self, conversation_id: str, status: str) -> Optional[AgentConversation]:
        """更新对话状态"""
        db = SessionLocal()
        try:
            conv = db.query(AgentConversation).filter(
                AgentConversation.id == conversation_id
            ).first()
            if conv:
                conv.status = status
                conv.updated_at = datetime.utcnow()
                db.commit()
                db.refresh(conv)
            return conv
        finally:
            db.close()

    def list_by_user(
        self,
        user_id: str,
        limit: int = 20,
        offset: int = 0,
    ) -> List[AgentConversation]:
        """获取用户的所有对话"""
        db = SessionLocal()
        try:
            return (
                db.query(AgentConversation)
                .filter(AgentConversation.user_id == user_id)
                .order_by(AgentConversation.updated_at.desc())
                .offset(offset)
                .limit(limit)
                .all()
            )
        finally:
            db.close()

    def delete(self, conversation_id: str) -> bool:
        """删除对话"""
        db = SessionLocal()
        try:
            conv = db.query(AgentConversation).filter(
                AgentConversation.id == conversation_id
            ).first()
            if conv:
                db.delete(conv)
                db.commit()
                return True
            return False
        finally:
            db.close()

    def get_or_create(
        self,
        conversation_id: str,
        user_id: str,
        source: str = "web",
        external_conversation_id: str = None,
        title: str = None,
    ) -> AgentConversation:
        """获取或创建对话"""
        conv = self.get(conversation_id)
        if conv:
            return conv
        return self.create(
            conversation_id=conversation_id,
            user_id=user_id,
            source=source,
            external_conversation_id=external_conversation_id,
            title=title,
        )