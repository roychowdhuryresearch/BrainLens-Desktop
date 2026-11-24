"""Agent observability storage and aggregation helpers."""

from __future__ import annotations

import json
import logging
import uuid
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from runtime.agent_history.db import SessionLocal
from runtime.agent_history.models import AgentConversation, AgentMessage, AgentTelemetrySpan, AgentTurn
from runtime.redaction import redact_observability_payload

logger = logging.getLogger(__name__)


def _safe_float(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _safe_int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _safe_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "y"}
    return False


def _parse_metadata(span: AgentTelemetrySpan) -> Dict[str, Any]:
    try:
        return json.loads(span.metadata_json) if span.metadata_json else {}
    except (TypeError, ValueError, json.JSONDecodeError):
        return {}


def _metadata_text(metadata: Dict[str, Any], key: str) -> str:
    value = metadata.get(key)
    return str(value) if value not in (None, "") else ""


_PHASE_DISPLAY_ORDER = {
    "bootstrap": 5,
    "routing": 10,
    "control": 15,
    "plan": 20,
    "summary": 30,
    "loop": 40,
    "verification": 50,
    "memory_write": 70,
}


def _phase_sort_key(phase: str) -> tuple[int, str]:
    normalized = str(phase or "").strip()
    return (_PHASE_DISPLAY_ORDER.get(normalized, 999), normalized)


class AgentObservabilityService:
    """Persists execution spans and builds dashboard-friendly aggregates."""

    @staticmethod
    def _normalize_user_id(user_id: str) -> str:
        normalized = str(user_id or "").strip()
        if not normalized:
            return ""
        if "." in normalized:
            return normalized.split(".", 1)[0]
        return normalized

    def record_span(
        self,
        *,
        turn_id: str,
        conversation_id: str,
        user_id: Optional[str],
        span_type: str,
        phase: str,
        name: str,
        status: str = "success",
        loop_index: int = 0,
        started_at: Optional[datetime] = None,
        ended_at: Optional[datetime] = None,
        duration_ms: Optional[float] = None,
        model_used: Optional[str] = None,
        prompt_tokens: Optional[int] = None,
        completion_tokens: Optional[int] = None,
        total_tokens: Optional[int] = None,
        tool_name: Optional[str] = None,
        skill_name: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        db = SessionLocal()
        try:
            start = started_at or datetime.utcnow()
            end = ended_at or datetime.utcnow()
            span = AgentTelemetrySpan(
                id=str(uuid.uuid4()),
                turn_id=turn_id,
                conversation_id=conversation_id,
                user_id=user_id or "",
                span_type=span_type,
                phase=phase,
                loop_index=loop_index,
                name=name,
                status=status,
                started_at=start,
                ended_at=end,
                duration_ms=_safe_int(duration_ms),
                model_used=model_used or "",
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                total_tokens=total_tokens,
                tool_name=tool_name or "",
                skill_name=skill_name or "",
                metadata_json=json.dumps(
                    redact_observability_payload(metadata or {}),
                    ensure_ascii=False,
                ),
            )
            db.add(span)
            db.commit()
            db.refresh(span)
            return span.to_dict()
        finally:
            db.close()

    @staticmethod
    def _resolve_usernames(db, user_ids: List[str]) -> Dict[str, str]:
        """Batch resolve user_id -> username from the users database."""
        if not user_ids:
            return {}
        try:
            from runtime.models.user import User as ImportedUser, SessionLocal as ImportedUserSessionLocal
        except Exception:
            return {uid: uid for uid in user_ids}

        User = globals().get("User", ImportedUser)
        UserSessionLocal = globals().get("UserSessionLocal", ImportedUserSessionLocal)

        normalized_pairs = {
            str(uid): AgentObservabilityService._normalize_user_id(str(uid))
            for uid in user_ids
            if str(uid or "").strip()
        }
        lookup_ids = {uid for uid in normalized_pairs}
        lookup_ids.update({normalized for normalized in normalized_pairs.values() if normalized})

        user_db = UserSessionLocal()
        try:
            users = user_db.query(User).filter(User.id.in_(lookup_ids)).all()
            by_id = {str(u.id): str(u.username) for u in users}
            resolved: Dict[str, str] = {}
            for raw_id, normalized_id in normalized_pairs.items():
                username = by_id.get(raw_id) or by_id.get(normalized_id)
                if username:
                    resolved[raw_id] = username
            return resolved
        except Exception:
            return {uid: uid for uid in user_ids}
        finally:
            user_db.close()

    @staticmethod
    def _get_final_answer_for_turn(
        db,
        turn: AgentTurn,
        max_length: Optional[int] = 200,
    ) -> Optional[str]:
        """Get the latest assistant message produced during the given turn.

        并发写入下 message.created_at 可能与 turn.created_at 相差一个亚秒级的
        clock jitter，或在极端情况下早于 turn.created_at。主查询用严格时间窗口，
        如果为空则退化到 [turn.created_at - 5s, next_turn.created_at] 的宽松窗口，
        再不行就返回 None，避免看板把实际已回复的对话显示为空。
        """
        try:
            next_turn_row = (
                db.query(AgentTurn.created_at)
                .filter(
                    AgentTurn.conversation_id == turn.conversation_id,
                    AgentTurn.created_at > turn.created_at,
                )
                .order_by(AgentTurn.created_at.asc())
                .first()
            )
            next_turn_at = next_turn_row[0] if next_turn_row and next_turn_row[0] else None

            def _pick(lower_bound):
                q = (
                    db.query(AgentMessage)
                    .filter(
                        AgentMessage.conversation_id == turn.conversation_id,
                        AgentMessage.role == "assistant",
                        AgentMessage.created_at >= lower_bound,
                    )
                )
                if next_turn_at is not None:
                    q = q.filter(AgentMessage.created_at < next_turn_at)
                return q.order_by(AgentMessage.created_at.desc()).first()

            msg = _pick(turn.created_at)
            if (
                msg is None
                and turn.created_at is not None
                and getattr(turn, "status", None) not in ("failed", "error")
            ):
                # 宽松回退：允许 message 稍早于 turn.created_at（并发抖动）。但对失败/无回答的
                # turn 跳过——它没有本轮的 assistant 消息，回退窗口会把上一轮的答案误当成本轮的
                # （最新一轮没有 next_turn_at 上界，回退能一直往前抓到上一轮的消息）。
                msg = _pick(turn.created_at - timedelta(seconds=5))

            if msg and msg.content:
                content = msg.content.strip()
                if max_length is not None and max_length > 0 and len(content) > max_length:
                    return content[:max_length] + "..."
                return content
            logger.debug("No assistant message found for turn %s", turn.id)
        except Exception as exc:
            logger.warning("Failed to get final answer for turn %s: %s", turn.id, exc)
        return None

    # Allowed sort columns with their corresponding ORM column
    _SORT_COLUMNS = {
        "created_at": AgentTurn.created_at,
        "duration_ms": AgentTurn.created_at,  # fallback – duration computed post-query
        "turn_number": AgentTurn.turn_number,
        "status": AgentTurn.status,
    }

    def list_turns(
        self,
        limit: int = 20,
        offset: int = 0,
        sort_by: str = "created_at",
        sort_order: str = "desc",
    ) -> Dict[str, Any]:
        db = SessionLocal()
        try:
            total = db.query(AgentTurn).count()

            sort_col = self._SORT_COLUMNS.get(sort_by, AgentTurn.created_at)
            if sort_order == "asc":
                order_expr = sort_col.asc()
            else:
                order_expr = sort_col.desc()

            turns = (
                db.query(AgentTurn, AgentConversation)
                .join(AgentConversation, AgentConversation.id == AgentTurn.conversation_id)
                .order_by(order_expr)
                .offset(offset)
                .limit(limit)
                .all()
            )

            # Batch resolve usernames
            user_ids = list({conv.user_id for _, conv in turns if conv.user_id})
            username_map = self._resolve_usernames(db, user_ids)

            data = [
                self._build_turn_summary(db, turn, conversation, username_map=username_map)
                for turn, conversation in turns
            ]
            return {"turns": data, "total": total}
        finally:
            db.close()

    def get_turn_detail(self, turn_id: str) -> Optional[Dict[str, Any]]:
        db = SessionLocal()
        try:
            row = (
                db.query(AgentTurn, AgentConversation)
                .join(AgentConversation, AgentConversation.id == AgentTurn.conversation_id)
                .filter(AgentTurn.id == turn_id)
                .first()
            )
            if not row:
                return None

            turn, conversation = row
            spans = (
                db.query(AgentTelemetrySpan)
                .filter(AgentTelemetrySpan.turn_id == turn_id)
                .order_by(AgentTelemetrySpan.started_at.asc(), AgentTelemetrySpan.id.asc())
                .all()
            )
            summary = self._summarize_turn(turn, conversation, spans)
            turn_data = turn.to_dict()
            # Detail view should show the full assistant answer for the selected turn.
            turn_data["final_answer"] = self._get_final_answer_for_turn(db, turn, max_length=None)
            turn_data["user_message"] = turn.user_message
            return {
                "turn": turn_data,
                "conversation": conversation.to_dict(),
                "summary": summary,
                "spans": [span.to_dict() for span in spans],
            }
        finally:
            db.close()

    def _build_turn_summary(
        self,
        db,
        turn: AgentTurn,
        conversation: AgentConversation,
        username_map: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        spans = (
            db.query(AgentTelemetrySpan)
            .filter(AgentTelemetrySpan.turn_id == turn.id)
            .all()
        )
        summary = self._summarize_turn(turn, conversation, spans)

        # Resolve username
        username = (username_map or {}).get(conversation.user_id, conversation.user_id or "")

        # List view uses a short preview to keep the table readable.
        final_answer = self._get_final_answer_for_turn(db, turn, max_length=200)
        model_used = next((span.model_used for span in spans if getattr(span, "model_used", None)), "") or ""
        tool_name = next((span.tool_name for span in spans if getattr(span, "tool_name", None)), "") or ""

        return {
            "turn_id": turn.id,
            "conversation_id": conversation.id,
            "title": conversation.title,
            "user_id": conversation.user_id,
            "username": username,
            "user_message": turn.user_message,
            "final_answer": final_answer,
            "turn_number": turn.turn_number,
            "status": turn.status,
            "created_at": turn.created_at.isoformat() if turn.created_at else None,
            "completed_at": turn.completed_at.isoformat() if turn.completed_at else None,
            "routing_skill": turn.active_skill,
            "routing_method": turn.routing_method,
            "model_used": model_used,
            "tool_name": tool_name,
            **summary["overview"],
        }

    def _summarize_turn(
        self,
        turn: AgentTurn,
        conversation: AgentConversation,
        spans: List[AgentTelemetrySpan],
    ) -> Dict[str, Any]:
        llm_spans = [span for span in spans if span.span_type == "llm"]
        tool_spans = [span for span in spans if span.span_type == "tool"]
        skill_spans = [span for span in spans if span.span_type == "skill"]
        phase_buckets: Dict[str, Dict[str, Any]] = defaultdict(lambda: {
            "phase": "",
            "duration_ms": 0,
            "llm_calls": 0,
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
            "tool_calls": 0,
            "tool_successes": 0,
        })
        loop_buckets: Dict[str, Dict[str, Any]] = defaultdict(lambda: {
            "key": "",
            "step_id": "",
            "loop_index": 0,
            "duration_ms": 0,
            "llm_calls": 0,
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
            "tool_calls": 0,
            "tool_successes": 0,
            "skills": [],
            "tool_details": [],
        })
        tool_buckets: Dict[str, Dict[str, Any]] = defaultdict(lambda: {
            "tool_name": "",
            "tool_family": "",
            "provider_name": "",
            "calls": 0,
            "successes": 0,
            "failures": 0,
            "invalid_calls": 0,
            "timeout_calls": 0,
            "empty_results": 0,
            "repeated_calls": 0,
            "repeated_in_step_calls": 0,
            "duration_ms": 0,
            "result_count_total": 0,
            "result_size_chars_total": 0,
        })
        tool_family_buckets: Dict[str, Dict[str, Any]] = defaultdict(lambda: {
            "tool_family": "",
            "calls": 0,
            "successes": 0,
            "failures": 0,
            "invalid_calls": 0,
            "timeout_calls": 0,
            "empty_results": 0,
            "repeated_calls": 0,
            "duration_ms": 0,
        })
        skill_buckets: Dict[str, Dict[str, Any]] = defaultdict(lambda: {
            "skill_name": "",
            "triggers": 0,
            "successes": 0,
            "failures": 0,
            "phases": [],
        })

        for span in spans:
            metadata = _parse_metadata(span)
            phase_name = span.phase or "unknown"
            phase_bucket = phase_buckets[phase_name]
            phase_bucket["phase"] = phase_name
            if (
                (phase_name != "loop" or span.span_type == "skill")
                and not _safe_bool(metadata.get("exclude_from_phase_duration"))
            ):
                phase_bucket["duration_ms"] += _safe_int(span.duration_ms)

            if span.span_type == "llm":
                phase_bucket["llm_calls"] += 1
                phase_bucket["prompt_tokens"] += _safe_int(span.prompt_tokens)
                phase_bucket["completion_tokens"] += _safe_int(span.completion_tokens)
                phase_bucket["total_tokens"] += _safe_int(span.total_tokens)

            if span.span_type == "tool":
                phase_bucket["tool_calls"] += 1
                if span.status == "success":
                    phase_bucket["tool_successes"] += 1

            if phase_name == "loop" and span.loop_index and span.span_type in {"llm", "tool"}:
                step_id = str(metadata.get("step_id") or "")
                loop_key = f"{step_id}:{span.loop_index}"
                loop_bucket = loop_buckets[loop_key]
                loop_bucket["key"] = loop_key
                loop_bucket["step_id"] = step_id
                loop_bucket["loop_index"] = span.loop_index
                loop_bucket["duration_ms"] += _safe_int(span.duration_ms)
                if span.span_type == "llm":
                    loop_bucket["llm_calls"] += 1
                    loop_bucket["prompt_tokens"] += _safe_int(span.prompt_tokens)
                    loop_bucket["completion_tokens"] += _safe_int(span.completion_tokens)
                    loop_bucket["total_tokens"] += _safe_int(span.total_tokens)
                if span.span_type == "tool":
                    loop_bucket["tool_calls"] += 1
                    if span.status == "success":
                        loop_bucket["tool_successes"] += 1
                    loop_bucket["tool_details"].append({
                        "tool_name": span.tool_name or span.name or "",
                        "status": span.status,
                        "tool_family": _metadata_text(metadata, "tool_family"),
                        "provider_name": _metadata_text(metadata, "provider_name"),
                        "args": metadata.get("args") if isinstance(metadata.get("args"), dict) else {},
                        "focus_args": metadata.get("focus_args") if isinstance(metadata.get("focus_args"), dict) else {},
                        "mcp_args_kind": _metadata_text(metadata, "mcp_args_kind"),
                        "source_tool": _metadata_text(metadata, "source_tool"),
                        "parent_tool_name": _metadata_text(metadata, "parent_tool_name"),
                        "error_type": _metadata_text(metadata, "error_type"),
                        "error_message": _metadata_text(metadata, "error_message") or _metadata_text(metadata, "error"),
                    })
                if span.skill_name and span.skill_name not in loop_bucket["skills"]:
                    loop_bucket["skills"].append(span.skill_name)

            if span.tool_name:
                tool_family = _metadata_text(metadata, "tool_family")
                provider_name = _metadata_text(metadata, "provider_name")
                error_type = _metadata_text(metadata, "error_type")
                tool_bucket = tool_buckets[span.tool_name]
                tool_bucket["tool_name"] = span.tool_name
                tool_bucket["tool_family"] = tool_family
                tool_bucket["provider_name"] = provider_name
                tool_bucket["calls"] += 1
                tool_bucket["duration_ms"] += _safe_int(span.duration_ms)
                if span.status == "success":
                    tool_bucket["successes"] += 1
                else:
                    tool_bucket["failures"] += 1
                if span.status == "invalid" or error_type == "invalid_tool":
                    tool_bucket["invalid_calls"] += 1
                if error_type == "timeout":
                    tool_bucket["timeout_calls"] += 1
                if _safe_bool(metadata.get("is_empty_result")):
                    tool_bucket["empty_results"] += 1
                if _safe_bool(metadata.get("is_repeated_call")):
                    tool_bucket["repeated_calls"] += 1
                if _safe_bool(metadata.get("is_repeated_in_step")):
                    tool_bucket["repeated_in_step_calls"] += 1
                tool_bucket["result_count_total"] += _safe_int(metadata.get("result_count"))
                tool_bucket["result_size_chars_total"] += _safe_int(metadata.get("result_size_chars"))

                family_key = tool_family or "unknown"
                family_bucket = tool_family_buckets[family_key]
                family_bucket["tool_family"] = family_key
                family_bucket["calls"] += 1
                family_bucket["duration_ms"] += _safe_int(span.duration_ms)
                if span.status == "success":
                    family_bucket["successes"] += 1
                else:
                    family_bucket["failures"] += 1
                if span.status == "invalid" or error_type == "invalid_tool":
                    family_bucket["invalid_calls"] += 1
                if error_type == "timeout":
                    family_bucket["timeout_calls"] += 1
                if _safe_bool(metadata.get("is_empty_result")):
                    family_bucket["empty_results"] += 1
                if _safe_bool(metadata.get("is_repeated_call")):
                    family_bucket["repeated_calls"] += 1

            if span.span_type == "skill" and span.skill_name:
                skill_bucket = skill_buckets[span.skill_name]
                skill_bucket["skill_name"] = span.skill_name
                skill_bucket["triggers"] += 1
                if span.status == "success":
                    skill_bucket["successes"] += 1
                else:
                    skill_bucket["failures"] += 1
                if phase_name not in skill_bucket["phases"]:
                    skill_bucket["phases"].append(phase_name)

        overview = {
            "duration_ms": self._turn_duration(turn, spans),
            "llm_calls": len(llm_spans),
            "prompt_tokens": sum(_safe_int(span.prompt_tokens) for span in llm_spans),
            "completion_tokens": sum(_safe_int(span.completion_tokens) for span in llm_spans),
            "total_tokens": sum(_safe_int(span.total_tokens) for span in llm_spans),
            "tool_calls": len(tool_spans),
            "tool_successes": sum(1 for span in tool_spans if span.status == "success"),
            "tool_failures": sum(1 for span in tool_spans if span.status == "failed"),
            "invalid_tool_calls": sum(1 for span in tool_spans if span.status == "invalid" or _metadata_text(_parse_metadata(span), "error_type") == "invalid_tool"),
            "timeout_tool_calls": sum(1 for span in tool_spans if _metadata_text(_parse_metadata(span), "error_type") == "timeout"),
            "empty_tool_results": sum(1 for span in tool_spans if _safe_bool(_parse_metadata(span).get("is_empty_result"))),
            "repeated_tool_calls": sum(1 for span in tool_spans if _safe_bool(_parse_metadata(span).get("is_repeated_call"))),
            "tool_success_rate": round(
                (sum(1 for span in tool_spans if span.status == "success") / len(tool_spans) * 100.0)
                if tool_spans else 0.0,
                2,
            ),
            "skills_triggered": len({span.skill_name for span in skill_spans if span.skill_name}),
        }
        loop_count = len(loop_buckets)
        multi_tool_loops = sum(1 for bucket in loop_buckets.values() if _safe_int(bucket["tool_calls"]) > 1)
        overview["multi_tool_loop_count"] = multi_tool_loops
        overview["multi_tool_loop_ratio"] = round((multi_tool_loops / loop_count * 100.0) if loop_count else 0.0, 2)
        overview["avg_tools_per_loop"] = round((len(tool_spans) / loop_count) if loop_count else 0.0, 2)

        phase_stats = []
        for bucket in sorted(phase_buckets.values(), key=lambda item: _phase_sort_key(item["phase"])):
            calls = bucket["tool_calls"]
            successes = bucket["tool_successes"]
            bucket["tool_success_rate"] = round((successes / calls * 100.0) if calls else 0.0, 2)
            phase_stats.append(bucket)

        loop_stats = []
        for bucket in sorted(loop_buckets.values(), key=lambda item: (item["step_id"], item["loop_index"])):
            calls = bucket["tool_calls"]
            successes = bucket["tool_successes"]
            bucket["tool_success_rate"] = round((successes / calls * 100.0) if calls else 0.0, 2)
            loop_stats.append(bucket)

        tool_stats = []
        for bucket in sorted(tool_buckets.values(), key=lambda item: item["tool_name"]):
            bucket["success_rate"] = round((bucket["successes"] / bucket["calls"] * 100.0) if bucket["calls"] else 0.0, 2)
            bucket["empty_result_rate"] = round((bucket["empty_results"] / bucket["calls"] * 100.0) if bucket["calls"] else 0.0, 2)
            bucket["repeated_call_rate"] = round((bucket["repeated_calls"] / bucket["calls"] * 100.0) if bucket["calls"] else 0.0, 2)
            bucket["timeout_rate"] = round((bucket["timeout_calls"] / bucket["calls"] * 100.0) if bucket["calls"] else 0.0, 2)
            bucket["avg_result_count"] = round((bucket["result_count_total"] / bucket["calls"]) if bucket["calls"] else 0.0, 2)
            bucket["avg_result_size_chars"] = round((bucket["result_size_chars_total"] / bucket["calls"]) if bucket["calls"] else 0.0, 2)
            tool_stats.append(bucket)

        tool_family_stats = []
        for bucket in sorted(tool_family_buckets.values(), key=lambda item: item["tool_family"]):
            bucket["success_rate"] = round((bucket["successes"] / bucket["calls"] * 100.0) if bucket["calls"] else 0.0, 2)
            bucket["empty_result_rate"] = round((bucket["empty_results"] / bucket["calls"] * 100.0) if bucket["calls"] else 0.0, 2)
            bucket["repeated_call_rate"] = round((bucket["repeated_calls"] / bucket["calls"] * 100.0) if bucket["calls"] else 0.0, 2)
            bucket["timeout_rate"] = round((bucket["timeout_calls"] / bucket["calls"] * 100.0) if bucket["calls"] else 0.0, 2)
            tool_family_stats.append(bucket)

        skill_stats = []
        for bucket in sorted(skill_buckets.values(), key=lambda item: item["skill_name"]):
            bucket["success_rate"] = round((bucket["successes"] / bucket["triggers"] * 100.0) if bucket["triggers"] else 0.0, 2)
            skill_stats.append(bucket)

        return {
            "overview": overview,
            "phase_stats": phase_stats,
            "loop_stats": loop_stats,
            "tool_stats": tool_stats,
            "tool_family_stats": tool_family_stats,
            "skill_stats": skill_stats,
        }

    def _turn_duration(self, turn: AgentTurn, spans: List[AgentTelemetrySpan]) -> int:
        if turn.created_at and turn.completed_at:
            return _safe_int((turn.completed_at - turn.created_at).total_seconds() * 1000)

        if not spans:
            return 0

        started = min((span.started_at for span in spans if span.started_at), default=None)
        ended = max((span.ended_at for span in spans if span.ended_at), default=None)
        if started and ended:
            return _safe_int((ended - started).total_seconds() * 1000)
        return 0


_agent_observability_service: Optional[AgentObservabilityService] = None


def get_agent_observability_service() -> AgentObservabilityService:
    global _agent_observability_service
    if _agent_observability_service is None:
        _agent_observability_service = AgentObservabilityService()
    return _agent_observability_service
