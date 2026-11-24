"""
Agent History 数据模型

定义数据库表结构
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime
from sqlalchemy import Column, String, Text, Integer, DateTime, ForeignKey
from sqlalchemy.orm import relationship
from runtime.agent_history.db import Base
from runtime.agent_runtime.action_receipts import canonical_action_receipt
from runtime.redaction import redact_observability_payload


AGENT_MESSAGE_AUDIT_SCHEMA_VERSION = "agent-message-audit.v1"


def _safe_message_metadata(raw: str | None) -> dict:
    """Decode legacy/new message metadata without exposing unsafe values."""

    if not raw:
        return {}
    try:
        decoded = json.loads(raw)
    except (TypeError, ValueError, json.JSONDecodeError):
        return {}
    if not isinstance(decoded, dict):
        return {}
    redacted = redact_observability_payload(decoded)
    return redacted if isinstance(redacted, dict) else {}


def _safe_json_value(raw: str | None, *, default):
    if not raw:
        return default
    try:
        return json.loads(raw)
    except (TypeError, ValueError, json.JSONDecodeError):
        return default


class AgentConversation(Base):
    """对话记录"""
    __tablename__ = "agent_conversations"

    id = Column(String(64), primary_key=True)
    external_conversation_id = Column(String(64), index=True)  # 关联前端 conversation_id
    user_id = Column(String(64), index=True)  # 用户/身份ID
    source = Column(String(32), default="web")  # web / api / webhook
    title = Column(String(256))
    status = Column(String(32), default="active")  # active / completed
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # 关系
    messages = relationship("AgentMessage", back_populates="conversation", order_by="AgentMessage.created_at")
    turns = relationship("AgentTurn", back_populates="conversation", order_by="AgentTurn.turn_number")

    def to_dict(self):
        return {
            "id": self.id,
            "external_conversation_id": self.external_conversation_id,
            "user_id": self.user_id,
            "source": self.source,
            "title": self.title,
            "status": self.status,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


class AgentMessage(Base):
    """消息记录"""
    __tablename__ = "agent_messages"

    id = Column(String(64), primary_key=True)
    conversation_id = Column(String(64), ForeignKey("agent_conversations.id"), index=True)
    role = Column(String(16))  # user / assistant / system / tool
    content = Column(Text)
    name = Column(String(128))  # tool 名
    tool_call_id = Column(String(128))  # tool 调用ID
    sources = Column(Text)  # JSON 来源引用
    # Versioned, public-safe terminal audit payload.  This additive nullable
    # column keeps rows written before the evidence contract readable.
    metadata_json = Column(Text)
    created_at = Column(DateTime, default=datetime.utcnow)

    # 关系
    conversation = relationship("AgentConversation", back_populates="messages")

    def to_dict(self):
        metadata = _safe_message_metadata(self.metadata_json)
        audit_scope_valid = (
            metadata.get("schema_version") == AGENT_MESSAGE_AUDIT_SCHEMA_VERSION
            and str(metadata.get("message_id") or "") == str(self.id)
            and bool(str(metadata.get("turn_id") or "").strip())
            and str(metadata.get("conversation_id") or "") == str(self.conversation_id)
        )
        public_metadata = metadata if audit_scope_valid else {}
        raw_receipts = public_metadata.get("action_receipts")
        action_receipts = (
            [
                canonical
                for item in raw_receipts
                if (
                    canonical := canonical_action_receipt(
                        item,
                        terminal_only=True,
                        expected_conversation_id=str(self.conversation_id),
                        expected_request_id=(
                            str(public_metadata.get("request_id"))
                            if public_metadata.get("request_id")
                            else None
                        ),
                        expected_message_id=str(self.id),
                        expected_state_revision=(
                            str(public_metadata.get("state_revision"))
                            if public_metadata.get("state_revision")
                            else None
                        ),
                    )
                )
            ]
            if isinstance(raw_receipts, list)
            else []
        )
        raw_research_output = public_metadata.get("research_output")
        research_output = (
            dict(raw_research_output)
            if isinstance(raw_research_output, dict)
            and raw_research_output.get("schema_version") == "research-output.v1"
            and str(raw_research_output.get("message_id") or "") == str(self.id)
            and str(raw_research_output.get("conversation_id") or "") == str(self.conversation_id)
            and (
                not public_metadata.get("request_id")
                or str(raw_research_output.get("request_id") or "")
                == str(public_metadata.get("request_id"))
            )
            and (
                not public_metadata.get("state_revision")
                or str(raw_research_output.get("state_revision") or "")
                == str(public_metadata.get("state_revision"))
            )
            else None
        )
        if audit_scope_valid:
            # Never re-expose a tampered/cross-scope nested object through the
            # generic metadata field after the typed recovery view rejected it.
            public_metadata["action_receipts"] = action_receipts
            public_metadata["research_output"] = research_output
        return {
            "id": self.id,
            "message_id": self.id,
            "turn_id": self.id,  # 兼容性别名
            "conversation_id": self.conversation_id,
            "role": self.role,
            "content": self.content,
            "name": self.name,
            "tool_call_id": self.tool_call_id,
            "sources": _safe_json_value(self.sources, default=None),
            "metadata": public_metadata,
            "completion_turn_id": public_metadata.get("turn_id"),
            "action_receipts": action_receipts,
            "research_output": research_output,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }


class AgentAttachment(Base):
    """Uploaded attachment metadata. Original bytes live in object storage."""

    __tablename__ = "agent_attachments"

    id = Column(String(64), primary_key=True, default=lambda: uuid.uuid4().hex)
    attachment_id = Column(String(64), index=True)
    message_id = Column(String(64), index=True)
    conversation_id = Column(String(64), index=True)
    user_id = Column(String(64), index=True)
    bucket = Column(String(128))
    object_key = Column(String(512))
    filename = Column(String(256))
    content_type = Column(String(128))
    size = Column(Integer)
    sha256 = Column(String(64))
    image_ref = Column(String(64))
    metadata_json = Column(Text)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)

    def to_dict(self):
        return {
            "id": self.id,
            "attachment_id": self.attachment_id,
            "message_id": self.message_id,
            "conversation_id": self.conversation_id,
            "user_id": self.user_id,
            "bucket": self.bucket,
            "object_key": self.object_key,
            "filename": self.filename,
            "content_type": self.content_type,
            "size": self.size,
            "sha256": self.sha256,
            "image_ref": self.image_ref,
            "metadata": json.loads(self.metadata_json) if self.metadata_json else {},
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }


class AgentTurn(Base):
    """轮次记录 - Agent 核心运行数据"""
    __tablename__ = "agent_turns"

    id = Column(String(64), primary_key=True)
    conversation_id = Column(String(64), ForeignKey("agent_conversations.id"), index=True)
    turn_number = Column(Integer, default=1)

    # 请求信息
    user_message = Column(Text)
    active_skill = Column(String(128))
    skill_reason = Column(Text)
    routing_method = Column(String(32))

    # 执行信息
    total_iterations = Column(Integer, default=0)
    model_used = Column(String(64))
    tokens_used = Column(Integer)

    # 状态
    status = Column(String(32), default="running")  # running / completed / failed / cancelled
    error_message = Column(Text)

    created_at = Column(DateTime, default=datetime.utcnow)
    completed_at = Column(DateTime)

    # 关系
    conversation = relationship("AgentConversation", back_populates="turns")

    def to_dict(self):
        return {
            "id": self.id,
            "turn_id": self.id,  # 兼容性别名，供 agent_service 使用
            "conversation_id": self.conversation_id,
            "turn_number": self.turn_number,
            "user_message": self.user_message,
            "active_skill": self.active_skill,
            "skill_reason": self.skill_reason,
            "routing_method": self.routing_method,
            "total_iterations": self.total_iterations,
            "model_used": self.model_used,
            "tokens_used": self.tokens_used,
            "status": self.status,
            "error_message": self.error_message,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "completed_at": self.completed_at.isoformat() if self.completed_at else None,
        }


class AgentSummary(Base):
    """滚动摘要 - ContextManager 用"""
    __tablename__ = "agent_summaries"

    conversation_id = Column(String(64), ForeignKey("agent_conversations.id"), primary_key=True)
    summary_text = Column(Text)
    summary_turn = Column(Integer)  # 摘要覆盖到的轮次
    summary_metadata = Column(Text)  # JSON: facts, constraints, decisions
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def to_dict(self):
        return {
            "conversation_id": self.conversation_id,
            "summary_text": self.summary_text,
            "summary_turn": self.summary_turn,
            "metadata": json.loads(self.summary_metadata) if self.summary_metadata else {},
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


class AgentTelemetrySpan(Base):
    """Structured execution span used by the dashboard."""

    __tablename__ = "agent_telemetry_spans"

    id = Column(String(64), primary_key=True)
    turn_id = Column(String(64), ForeignKey("agent_turns.id"), index=True)
    conversation_id = Column(String(64), ForeignKey("agent_conversations.id"), index=True)
    user_id = Column(String(64), index=True)
    span_type = Column(String(32), index=True)
    phase = Column(String(32), index=True)
    loop_index = Column(Integer, default=0)
    name = Column(String(128))
    status = Column(String(32), default="success")
    started_at = Column(DateTime, default=datetime.utcnow)
    ended_at = Column(DateTime, default=datetime.utcnow)
    duration_ms = Column(Integer, default=0)
    model_used = Column(String(128))
    prompt_tokens = Column(Integer)
    completion_tokens = Column(Integer)
    total_tokens = Column(Integer)
    tool_name = Column(String(128), index=True)
    skill_name = Column(String(128), index=True)
    metadata_json = Column(Text)

    def to_dict(self):
        return {
            "id": self.id,
            "turn_id": self.turn_id,
            "conversation_id": self.conversation_id,
            "user_id": self.user_id,
            "span_type": self.span_type,
            "phase": self.phase,
            "loop_index": self.loop_index,
            "name": self.name,
            "status": self.status,
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "ended_at": self.ended_at.isoformat() if self.ended_at else None,
            "duration_ms": self.duration_ms,
            "model_used": self.model_used,
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "total_tokens": self.total_tokens,
            "tool_name": self.tool_name,
            "skill_name": self.skill_name,
            "metadata": json.loads(self.metadata_json) if self.metadata_json else {},
        }


__all__ = [
    "AgentConversation",
    "AgentMessage",
    "AgentAttachment",
    "AgentTurn",
    "AgentSummary",
    "AgentTelemetrySpan",
]
