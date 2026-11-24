"""
Execution Replay Service - 执行链路回放

提供对话执行过程的回放能力：routing → plan → tool calls → verification。
用于运维排障和质量审查。

使用方式::

    svc = get_execution_replay_service()
    trace = await svc.get_turn_trace("conv-1", "turn-1")
"""

import json
import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


class ExecutionReplayService:
    """执行链路回放服务。

    从 AgentObservabilityService 的 telemetry spans 中提取
    完整的执行链路信息，按时间线还原。
    """

    def __init__(self, observability_service=None):
        self._obs_service = observability_service

    def _get_obs_service(self):
        if self._obs_service is None:
            from runtime.agent_history.observability_service import get_agent_observability_service
            self._obs_service = get_agent_observability_service()
        return self._obs_service

    def _coerce_mapping(self, item: Any, *, kind: str) -> Dict[str, Any]:
        if isinstance(item, dict):
            return item
        if hasattr(item, "to_dict"):
            try:
                raw = item.to_dict()
            except Exception as exc:
                logger.warning("[Replay] Failed to serialize %s: %s", kind, exc)
                return {}
            if isinstance(raw, dict):
                return raw
            logger.warning("[Replay] Ignoring non-dict %s payload: %r", kind, raw)
            return {}
        return {}

    async def get_turn_trace(
        self,
        conversation_id: str,
        turn_id: str,
    ) -> Dict[str, Any]:
        """获取单轮执行的完整链路。

        Returns:
            {
                "conversation_id": "...",
                "turn_id": "...",
                "phases": [
                    {"phase": "routing", "spans": [...]},
                    {"phase": "plan", "spans": [...]},
                    {"phase": "loop", "spans": [...]},
                    {"phase": "verification", "spans": [...]},
                ],
                "summary": {
                    "total_spans": 12,
                    "total_duration_ms": 3400,
                    "model_used": "qwen3.5-plus",
                    "skills_used": ["hfo-detector"],
                    "tools_called": ["document_search", "document_get_detail"],
                    "success": True,
                },
            }
        """
        obs = self._get_obs_service()
        try:
            spans = obs.get_turn_spans(conversation_id, turn_id)
        except Exception as exc:
            logger.warning("[Replay] Failed to load spans: %s", exc)
            spans = []

        if not spans:
            return {
                "conversation_id": conversation_id,
                "turn_id": turn_id,
                "phases": [],
                "summary": {"total_spans": 0, "error": "no spans found"},
            }

        # 按 phase 分组
        phase_groups: Dict[str, List[Dict]] = {}
        total_duration_ms = 0.0
        models = set()
        skills = set()
        tools = set()

        for span in spans:
            span_dict = self._coerce_mapping(span, kind="span")
            phase = span_dict.get("phase", "unknown")
            if phase not in phase_groups:
                phase_groups[phase] = []
            phase_groups[phase].append(span_dict)

            total_duration_ms += float(span_dict.get("duration_ms") or 0)
            if span_dict.get("model_used"):
                models.add(span_dict["model_used"])
            if span_dict.get("skill_name"):
                skills.add(span_dict["skill_name"])
            name = span_dict.get("name", "")
            if name and (
                span_dict.get("span_type") == "tool"
                or name.startswith("documents_")
                or name.startswith("bing_")
            ):
                tools.add(name)

        # 按标准顺序输出
        phase_order = ["routing", "plan", "summary", "loop", "control", "verification", "memory_write"]
        phases = []
        for phase in phase_order:
            if phase in phase_groups:
                phases.append({"phase": phase, "spans": phase_groups[phase]})
        # 追加未知 phase
        for phase, phase_spans in phase_groups.items():
            if phase not in phase_order:
                phases.append({"phase": phase, "spans": phase_spans})

        return {
            "conversation_id": conversation_id,
            "turn_id": turn_id,
            "phases": phases,
            "summary": {
                "total_spans": sum(len(s) for s in phase_groups.values()),
                "total_duration_ms": round(total_duration_ms, 1),
                "models_used": sorted(models),
                "skills_used": sorted(skills),
                "tools_called": sorted(tools),
            },
        }

    async def get_conversation_timeline(
        self,
        conversation_id: str,
    ) -> List[Dict[str, Any]]:
        """获取整个对话的执行时间线。"""
        obs = self._get_obs_service()
        try:
            turns = obs.get_conversation_turns(conversation_id)
        except Exception:
            turns = []

        timeline = []
        for turn in turns:
            turn_dict = self._coerce_mapping(turn, kind="turn")
            timeline.append({
                "turn_id": turn_dict.get("id") or turn_dict.get("turn_id"),
                "turn_number": turn_dict.get("turn_number"),
                "message": turn_dict.get("user_message", "")[:200],
                "status": turn_dict.get("status"),
                "created_at": str(turn_dict.get("created_at", "")),
            })
        return timeline


_replay_service: Optional[ExecutionReplayService] = None


def get_execution_replay_service() -> ExecutionReplayService:
    global _replay_service
    if _replay_service is None:
        _replay_service = ExecutionReplayService()
    return _replay_service
