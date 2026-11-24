"""Repository for uploaded attachment metadata."""
from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from runtime.agent_history.db import Base, SessionLocal, _engine
from runtime.agent_history.models import AgentAttachment


class AttachmentRepository:
    def __init__(self) -> None:
        Base.metadata.create_all(bind=_engine)

    def upsert(self, metadata: Dict[str, Any]) -> AgentAttachment:
        db = SessionLocal()
        try:
            attachment_id = str(metadata.get("attachment_id") or "")
            message_id = str(metadata.get("message_id") or "")
            conversation_id = str(metadata.get("conversation_id") or "")
            row = (
                db.query(AgentAttachment)
                .filter(
                    AgentAttachment.conversation_id == conversation_id,
                    AgentAttachment.message_id == message_id,
                    AgentAttachment.attachment_id == attachment_id,
                )
                .first()
            )
            if row is None:
                row = AgentAttachment(
                    attachment_id=attachment_id,
                    message_id=message_id,
                    conversation_id=conversation_id,
                )
                db.add(row)

            row.user_id = metadata.get("user_id")
            row.bucket = metadata.get("bucket")
            row.object_key = metadata.get("object_key")
            row.filename = metadata.get("filename")
            row.content_type = metadata.get("content_type")
            row.size = int(metadata.get("size") or 0)
            row.sha256 = metadata.get("sha256")
            row.image_ref = metadata.get("image_ref")
            row.metadata_json = json.dumps(metadata, ensure_ascii=False)
            db.commit()
            db.refresh(row)
            return row
        finally:
            db.close()

    def get_latest_by_ref(
        self,
        *,
        conversation_id: str,
        attachment_id: str,
    ) -> Optional[AgentAttachment]:
        db = SessionLocal()
        try:
            return (
                db.query(AgentAttachment)
                .filter(
                    AgentAttachment.conversation_id == conversation_id,
                    AgentAttachment.attachment_id == attachment_id,
                )
                .order_by(AgentAttachment.created_at.desc())
                .first()
            )
        finally:
            db.close()

    def list_by_conversation(self, conversation_id: str, limit: int = 100) -> List[AgentAttachment]:
        db = SessionLocal()
        try:
            return (
                db.query(AgentAttachment)
                .filter(AgentAttachment.conversation_id == conversation_id)
                .order_by(AgentAttachment.created_at.asc())
                .limit(limit)
                .all()
            )
        finally:
            db.close()

    def delete_by_conversation(self, conversation_id: str) -> int:
        db = SessionLocal()
        try:
            count = (
                db.query(AgentAttachment)
                .filter(AgentAttachment.conversation_id == conversation_id)
                .delete()
            )
            db.commit()
            return count
        finally:
            db.close()


__all__ = ["AttachmentRepository"]

