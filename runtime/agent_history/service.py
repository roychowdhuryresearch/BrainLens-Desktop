"""
Agent History Service - 对话历史服务

整合所有仓储，提供统一的服务接口给 AgentService 使用
"""

import json
import uuid
import logging
from datetime import datetime
from typing import Optional, List, Dict, Any
from runtime.agent_history.db import SessionLocal
from runtime.agent_history.models import (
    AGENT_MESSAGE_AUDIT_SCHEMA_VERSION,
    AgentMessage,
    AgentTurn,
)
from runtime.agent_history.conversation_repo import ConversationRepository
from runtime.agent_history.message_repo import MessageRepository
from runtime.agent_history.turn_repo import TurnRepository
from runtime.agent_history.summary_repo import SummaryRepository
from runtime.agent_history.attachment_repo import AttachmentRepository
from runtime.agent_runtime.action_receipts import canonical_action_receipt
from runtime.redaction import redact_observability_payload

logger = logging.getLogger(__name__)


def _serialize_terminal_audit_metadata(
    *,
    message_id: str,
    turn_id: str,
    conversation_id: str,
    request_id: Optional[str],
    state_revision: Optional[str],
    action_receipts: Optional[List[Dict[str, Any]]],
    research_output: Optional[Dict[str, Any]],
) -> str:
    """Return a public-safe, versioned terminal evidence payload.

    The runtime may only attach broker/backend-produced terminal receipts to a
    completed assistant message.  Invalid shapes fail the same transaction
    instead of being silently discarded from history.
    """

    receipts = [] if action_receipts is None else action_receipts
    if not isinstance(receipts, list):
        raise ValueError("terminal_action_receipts_invalid")
    normalized_receipts: List[Dict[str, Any]] = []
    for receipt in receipts:
        canonical = canonical_action_receipt(
            receipt,
            terminal_only=True,
            expected_conversation_id=conversation_id,
            expected_request_id=request_id,
            expected_message_id=message_id,
            expected_state_revision=state_revision,
        )
        if canonical is None:
            raise ValueError("terminal_action_receipt_invalid")
        normalized_receipts.append(canonical)
    if research_output is not None and not isinstance(research_output, dict):
        raise ValueError("research_output_invalid")
    if research_output is not None:
        if (
            research_output.get("schema_version") != "research-output.v1"
            or not str(research_output.get("output_id") or "").strip()
        ):
            raise ValueError("research_output_invalid")
        if str(research_output.get("message_id") or "") != message_id:
            raise ValueError("research_output_message_scope_mismatch")
        if str(research_output.get("conversation_id") or "") != conversation_id:
            raise ValueError("research_output_conversation_scope_mismatch")
        if request_id and str(research_output.get("request_id") or "") != request_id:
            raise ValueError("research_output_request_scope_mismatch")
        if state_revision and str(research_output.get("state_revision") or "") != state_revision:
            raise ValueError("research_output_state_scope_mismatch")

    unredacted_payload = {
        "schema_version": AGENT_MESSAGE_AUDIT_SCHEMA_VERSION,
        "message_id": message_id,
        "turn_id": turn_id,
        "conversation_id": conversation_id,
        "request_id": request_id,
        "state_revision": state_revision,
        "action_receipts": normalized_receipts,
        "research_output": dict(research_output) if research_output is not None else None,
    }
    payload = redact_observability_payload(unredacted_payload)
    if payload != unredacted_payload:
        # Terminal scientific evidence is immutable.  Persisting a silently
        # redacted variant would break its execution/provenance binding while
        # acknowledging a different object than the one the user received.
        raise ValueError("terminal_audit_metadata_unsafe")
    return json.dumps(payload, ensure_ascii=False, allow_nan=False)


class AgentHistoryService:
    """
    Agent 对话历史服务
    
    统一管理：
    - 对话 (conversation)
    - 消息 (message) - 完整的对话内容
    - 轮次 (turn) - Agent 核心运行数据
    - 摘要 (summary) - ContextManager 用的滚动摘要
    """

    def __init__(self):
        self.conversation_repo = ConversationRepository()
        self.message_repo = MessageRepository()
        self.turn_repo = TurnRepository()
        self.summary_repo = SummaryRepository()
        self.attachment_repo = AttachmentRepository()

    # ==================== 对话管理 ====================

    def create_conversation(
        self,
        user_id: str,
        source: str = "web",
        external_conversation_id: str = None,
        title: str = None,
    ) -> Dict[str, Any]:
        """创建新对话"""
        conversation_id = str(uuid.uuid4())
        conv = self.conversation_repo.create(
            conversation_id=conversation_id,
            user_id=user_id,
            source=source,
            external_conversation_id=external_conversation_id,
            title=title or "新对话",
        )
        return conv.to_dict()

    def get_conversation(self, conversation_id: str) -> Optional[Dict[str, Any]]:
        """获取对话"""
        conv = self.conversation_repo.get(conversation_id)
        return conv.to_dict() if conv else None

    def get_conversation_by_external_id(self, external_id: str) -> Optional[Dict[str, Any]]:
        """通过外部 ID 获取对话"""
        conv = self.conversation_repo.get_by_external_id(external_id)
        return conv.to_dict() if conv else None

    def update_conversation_title(self, conversation_id: str, title: str) -> Optional[Dict[str, Any]]:
        """更新对话标题"""
        conv = self.conversation_repo.update_title(conversation_id, title)
        return conv.to_dict() if conv else None

    def list_user_conversations(
        self,
        user_id: str,
        limit: int = 20,
        offset: int = 0,
    ) -> List[Dict[str, Any]]:
        """获取用户的所有对话列表"""
        convs = self.conversation_repo.list_by_user(user_id, limit, offset)
        return [c.to_dict() for c in convs]

    async def delete_conversation(self, conversation_id: str) -> bool:
        """删除对话（级联删除消息、轮次、摘要）"""
        # 删除关联数据
        self.message_repo.delete_by_conversation(conversation_id)
        self.turn_repo.delete_by_conversation(conversation_id)
        self.summary_repo.delete(conversation_id)
        self.attachment_repo.delete_by_conversation(conversation_id)
        # 删除对话
        return self.conversation_repo.delete(conversation_id)

    def get_or_create_conversation(
        self,
        conversation_id: str,
        user_id: str,
        source: str = "web",
        external_conversation_id: str = None,
        title: str = None,
    ) -> Dict[str, Any]:
        """获取或创建对话"""
        conv = self.conversation_repo.get_or_create(
            conversation_id=conversation_id,
            user_id=user_id,
            source=source,
            external_conversation_id=external_conversation_id,
            title=title,
        )
        return conv.to_dict()

    # ==================== 消息管理 ====================

    def add_message(
        self,
        conversation_id: str,
        role: str,
        content: str,
        name: str = None,
        tool_call_id: str = None,
        sources: List[Dict] = None,
        message_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """添加消息"""
        message_id = str(message_id or uuid.uuid4())
        msg = self.message_repo.create(
            conversation_id=conversation_id,
            message_id=message_id,
            role=role,
            content=content,
            name=name,
            tool_call_id=tool_call_id,
            sources=sources,
        )
        return msg.to_dict()

    def get_conversation_messages(
        self,
        conversation_id: str,
        limit: int = 100,
        offset: int = 0,
    ) -> List[Dict[str, Any]]:
        """获取对话的所有消息"""
        msgs = self.message_repo.get_by_conversation(conversation_id, limit, offset)
        return [m.to_dict() for m in msgs]

    def get_recent_messages(
        self,
        conversation_id: str,
        limit: int = 20,
    ) -> List[Dict[str, Any]]:
        """获取最近的消息（用于 Agent 上下文）"""
        return self.message_repo.get_recent(conversation_id, limit)

    def get_message_count(self, conversation_id: str) -> int:
        """获取消息数量"""
        return self.message_repo.get_message_count(conversation_id)

    # ==================== 附件元数据管理 ====================

    def save_attachment(self, metadata: Dict[str, Any]) -> Dict[str, Any]:
        attachment = self.attachment_repo.upsert(metadata)
        return attachment.to_dict()

    def get_attachment(self, conversation_id: str, attachment_id: str) -> Optional[Dict[str, Any]]:
        attachment = self.attachment_repo.get_latest_by_ref(
            conversation_id=conversation_id,
            attachment_id=attachment_id,
        )
        return attachment.to_dict() if attachment else None

    def list_attachments(self, conversation_id: str, limit: int = 100) -> List[Dict[str, Any]]:
        return [item.to_dict() for item in self.attachment_repo.list_by_conversation(conversation_id, limit)]

    # ==================== 轮次管理 ====================

    def start_turn(
        self,
        conversation_id: str,
        user_message: str,
        active_skill: str = None,
        skill_reason: str = None,
        routing_method: str = None,
    ) -> Dict[str, Any]:
        """开始新轮次"""
        turn_id = str(uuid.uuid4())
        # 获取当前轮次号
        turn_count = self.turn_repo.get_turn_count(conversation_id)
        turn_number = turn_count + 1

        turn = self.turn_repo.create(
            turn_id=turn_id,
            conversation_id=conversation_id,
            turn_number=turn_number,
            user_message=user_message,
            active_skill=active_skill,
            skill_reason=skill_reason,
            routing_method=routing_method,
        )
        return turn.to_dict()

    def complete_turn(
        self,
        turn_id: str,
        status: str = "completed",
        error_message: str = None,
        total_iterations: int = None,
        model_used: str = None,
        tokens_used: int = None,
    ) -> Optional[Dict[str, Any]]:
        """完成轮次"""
        turn = self.turn_repo.complete(
            turn_id=turn_id,
            status=status,
            error_message=error_message,
            total_iterations=total_iterations,
            model_used=model_used,
            tokens_used=tokens_used,
        )
        return turn.to_dict() if turn else None

    def persist_turn_completion_atomic(
        self,
        *,
        conversation_id: str,
        turn_id: str,
        status: str,
        final_content: Optional[str] = None,
        error_message: Optional[str] = None,
        total_iterations: int = 0,
        model_used: str = "",
        tokens_used: int = 0,
        sources: Optional[List[Dict[str, Any]]] = None,
        message_id: Optional[str] = None,
        request_id: Optional[str] = None,
        state_revision: Optional[str] = None,
        action_receipts: Optional[List[Dict[str, Any]]] = None,
        research_output: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Commit the assistant message and terminal turn state together.

        A completed turn and its visible assistant message are one durability
        boundary.  Repository helpers each own their own SQLAlchemy session,
        so composing ``add_message`` and ``complete_turn`` can leave an orphan
        message if the second commit fails.  This method deliberately performs
        both writes in one transaction and returns acknowledgements from the
        committed rows.
        """

        db = SessionLocal()
        committed = False
        try:
            turn = (
                db.query(AgentTurn)
                .filter(
                    AgentTurn.id == str(turn_id),
                    AgentTurn.conversation_id == str(conversation_id),
                )
                .first()
            )
            if turn is None:
                raise ValueError("turn_not_found_or_scope_mismatch")
            current_status = str(turn.status or "")
            terminal_statuses = {"completed", "failed", "cancelled"}
            if current_status in terminal_statuses:
                if current_status != str(status):
                    raise ValueError("turn_terminal_transition_forbidden")
                existing_message = None
                if current_status == "completed" and message_id:
                    existing_message = db.get(AgentMessage, str(message_id))
                    if (
                        existing_message is None
                        or str(existing_message.conversation_id or "") != str(conversation_id)
                    ):
                        raise ValueError("completed_turn_message_not_found")
                return {
                    "turn": turn.to_dict(),
                    "message": existing_message.to_dict() if existing_message is not None else None,
                }

            message = None
            if status == "completed":
                content = str(final_content or "")
                if not content.strip():
                    raise ValueError("assistant_message_content_missing")
                resolved_message_id = str(message_id or uuid.uuid4())
                metadata_json = _serialize_terminal_audit_metadata(
                    message_id=resolved_message_id,
                    turn_id=str(turn_id),
                    conversation_id=str(conversation_id),
                    request_id=str(request_id) if request_id else None,
                    state_revision=str(state_revision) if state_revision else None,
                    action_receipts=action_receipts,
                    research_output=research_output,
                )
                message = AgentMessage(
                    id=resolved_message_id,
                    conversation_id=str(conversation_id),
                    role="assistant",
                    content=content,
                    name="",
                    tool_call_id="",
                    sources=json.dumps(sources or [], ensure_ascii=False) if sources else None,
                    metadata_json=metadata_json,
                )
                db.add(message)

            turn.status = str(status)
            turn.error_message = str(error_message or "")
            turn.completed_at = datetime.utcnow()
            turn.total_iterations = int(total_iterations or 0)
            turn.model_used = str(model_used or "")
            turn.tokens_used = int(tokens_used or 0)

            # Resolve defaults/constraints and build the complete acknowledgement
            # while rollback is still possible.  commit() is deliberately the
            # final fallible database operation before returning this plain data.
            db.flush()
            persisted = {
                "turn": turn.to_dict(),
                "message": message.to_dict() if message is not None else None,
            }
            db.commit()
            committed = True
            return persisted
        except Exception:
            if not committed:
                db.rollback()
            raise
        finally:
            try:
                db.close()
            except Exception:
                if not committed:
                    raise
                logger.exception("History session close failed after durable turn completion")

    def get_turn(self, turn_id: str) -> Optional[Dict[str, Any]]:
        """获取轮次"""
        turn = self.turn_repo.get(turn_id)
        return turn.to_dict() if turn else None

    def get_conversation_turns(
        self,
        conversation_id: str,
    ) -> List[Dict[str, Any]]:
        """获取对话的所有轮次"""
        turns = self.turn_repo.get_by_conversation(conversation_id)
        return [t.to_dict() for t in turns]

    def get_latest_turn(self, conversation_id: str) -> Optional[Dict[str, Any]]:
        """获取最新轮次"""
        turn = self.turn_repo.get_latest(conversation_id)
        return turn.to_dict() if turn else None

    def update_turn_routing(
        self,
        turn_id: str,
        active_skill: str = None,
        skill_reason: str = None,
        routing_method: str = None,
    ) -> Optional[Dict[str, Any]]:
        """更新轮次的 routing 信息
        
        Args:
            turn_id: 轮次ID
            active_skill: 实际激活的skill
            skill_reason: skill选择原因
            routing_method: 路由方法
        
        Returns:
            更新后的轮次字典
        """
        turn = self.turn_repo.update_routing(
            turn_id=turn_id,
            active_skill=active_skill,
            skill_reason=skill_reason,
            routing_method=routing_method,
        )
        return turn.to_dict() if turn else None

    # ==================== 摘要管理 ====================

    def save_summary(
        self,
        conversation_id: str,
        summary_text: str,
        summary_turn: int,
        important_facts: List[str] = None,
        constraints: List[str] = None,
        decisions_made: List[str] = None,
        open_questions: List[str] = None,
    ) -> Dict[str, Any]:
        """保存滚动摘要"""
        summary = self.summary_repo.save(
            conversation_id=conversation_id,
            summary_text=summary_text,
            summary_turn=summary_turn,
            important_facts=important_facts,
            constraints=constraints,
            decisions_made=decisions_made,
            open_questions=open_questions,
        )
        return summary.to_dict()

    def get_summary(self, conversation_id: str) -> Optional[Dict[str, Any]]:
        """获取摘要"""
        summary = self.summary_repo.get(conversation_id)
        return summary.to_dict() if summary else None

    def get_summary_metadata(self, conversation_id: str) -> Dict[str, Any]:
        """获取摘要的结构化 metadata"""
        return self.summary_repo.get_metadata(conversation_id)

    def get_runtime_conversation_state(self, conversation_id: str) -> Dict[str, Any]:
        """获取 conversation-scoped runtime state."""
        return self.summary_repo.get_runtime_state(conversation_id) or {}

    def save_runtime_conversation_state(
        self,
        conversation_id: str,
        runtime_state: Dict[str, Any],
    ) -> Dict[str, Any]:
        """保存 conversation-scoped runtime state."""
        summary = self.summary_repo.save_runtime_state(
            conversation_id=conversation_id,
            runtime_state=runtime_state,
        )
        return summary.to_dict()

    # ==================== 完整上下文获取 ====================

    def get_full_context(
        self,
        conversation_id: str,
        include_messages: bool = True,
        include_summary: bool = True,
    ) -> Dict[str, Any]:
        """获取完整的对话上下文（供 Agent 使用）"""
        # 获取对话
        conv = self.get_conversation(conversation_id)
        if not conv:
            return {}

        result = {
            "conversation": conv,
            "messages": [],
            "summary": None,
            "turns": [],
        }

        # 获取消息
        if include_messages:
            result["messages"] = self.get_recent_messages(conversation_id, limit=50)

        # 获取摘要
        if include_summary:
            result["summary"] = self.get_summary(conversation_id)

        # 获取轮次
        result["turns"] = self.get_conversation_turns(conversation_id)

        return result


# 全局单例
_agent_history_service: Optional[AgentHistoryService] = None


def get_agent_history_service() -> AgentHistoryService:
    """获取全局 AgentHistoryService 实例"""
    global _agent_history_service
    if _agent_history_service is None:
        _agent_history_service = AgentHistoryService()
    return _agent_history_service


__all__ = ["AgentHistoryService", "get_agent_history_service"]
