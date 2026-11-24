import asyncio
import logging
from typing import Any, Dict, List, Optional

from runtime.agent_runtime.conversation_state import ConversationRuntimeState
from runtime.agent_runtime.user_input import get_pending_input
from runtime.context.models import ContextPack
from runtime.skills.models import SkillRuntimeContext

logger = logging.getLogger(__name__)


class RuntimeConversationShell:
    """Conversation/history/context owner used by the application shell."""

    def __init__(self, service: Any) -> None:
        self._service = service

    async def init_conversation_and_turn(
        self,
        *,
        conversation_id: str,
        message: str,
        active_skill_name: Optional[str],
        user_id: Optional[str],
    ) -> Optional[str]:
        conv_id = conversation_id or "default"
        current_turn_id = None

        self._service.ensure_history_service()

        try:
            if self._service.history_service and conv_id:
                try:
                    await asyncio.to_thread(
                        self._service.history_service.get_or_create_conversation,
                        conversation_id=conv_id,
                        user_id=user_id or "anonymous",
                        source="web",
                        title="",
                    )
                    await asyncio.to_thread(
                        self._service.history_service.add_message,
                        conversation_id=conv_id,
                        role="user",
                        content=message,
                        name="",
                        tool_call_id="",
                        sources=[],
                    )
                    turn = await asyncio.to_thread(
                        self._service.history_service.start_turn,
                        conversation_id=conv_id,
                        user_message=message,
                        active_skill=active_skill_name or "",
                        skill_reason="",
                        routing_method="",
                    )
                    current_turn_id = turn.get("turn_id")
                    logger.info("[Agent] Created conversation and user message: %s", conv_id)
                except Exception as exc:
                    logger.warning("[Agent] Failed to save user message to history: %s", exc)
        except Exception as exc:
            logger.warning("[Agent] History service error: %s", exc)

        return current_turn_id

    async def load_history_for_request(self, conversation_id: str) -> List[Dict]:
        if not conversation_id:
            return []
        try:
            history_limit = 5 if conversation_id.startswith("desktop-copilot-") else 21
            messages = self._service.get_recent_history_messages(
                conversation_id=conversation_id,
                limit=history_limit,
            )
            if messages:
                latest_msg_id = messages[-1].get("id")
                messages = [msg for msg in messages if msg.get("id") != latest_msg_id]
            return [
                {"role": msg.get("role"), "content": msg.get("content")}
                for msg in messages
                if msg.get("role") in {"user", "assistant"} and msg.get("content")
            ]
        except Exception as exc:
            logger.warning("[Agent] Failed to load history from DB: %s", exc)
            return []

    async def load_conversation_runtime_state(self, conversation_id: str) -> ConversationRuntimeState:
        payload = self._service.load_runtime_state_payload(conversation_id)
        return ConversationRuntimeState.from_dict(conversation_id, payload)

    async def save_conversation_runtime_state(
        self,
        *,
        conversation_id: str,
        runtime_state: ConversationRuntimeState,
    ) -> None:
        self._service.save_runtime_state_payload(
            conversation_id=conversation_id,
            runtime_state=runtime_state.to_dict(),
        )

    def get_pending_user_input_snapshot(self, conversation_id: str) -> Optional[Dict[str, Any]]:
        pending = get_pending_input(conversation_id)
        return pending.to_sse_data() if pending else None

    async def prepare_context_pack_for_request(
        self,
        *,
        conversation_id: str,
        history: List[Dict],
        message: str,
        skill_context: Optional[SkillRuntimeContext],
        current_turn_id: Optional[str],
        user_id: Optional[str],
    ) -> Optional[ContextPack]:
        context_pack = await self._service.prepare_context_backend(
            conversation_id=conversation_id,
            history=history,
            user_message=message,
            skill_context=skill_context,
        )
        if not context_pack:
            return None
        if (
            context_pack
            and context_pack.summary_metrics
            and int(context_pack.summary_metrics.get("llm_calls") or 0) > 0
        ):
            self._service.record_observability_span(
                turn_id=current_turn_id,
                conversation_id=conversation_id,
                user_id=user_id,
                span_type="llm",
                phase="summary",
                name="context_summary",
                status="success",
                duration_ms=context_pack.summary_metrics.get("llm_duration_ms"),
                model_used=str(context_pack.summary_metrics.get("model_used") or ""),
                prompt_tokens=int(context_pack.summary_metrics.get("prompt_tokens") or 0),
                completion_tokens=int(context_pack.summary_metrics.get("completion_tokens") or 0),
                total_tokens=int(context_pack.summary_metrics.get("total_tokens") or 0),
                metadata={
                    "used_summary": context_pack.used_summary,
                    "dropped_messages": context_pack.dropped_messages,
                },
            )
        return context_pack

    async def update_context_summary_after_turn(
        self,
        *,
        conversation_id: str,
        message: str,
        final_content: str,
    ) -> None:
        try:
            await self._service.update_context_summary_backend(
                conversation_id=conversation_id,
                history=[
                    {"role": "user", "content": message},
                    {"role": "assistant", "content": final_content},
                ],
            )
        except Exception as exc:
            logger.warning("[Agent] Failed to update context summary: %s", exc)
