import json
import logging
import re
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Protocol

from runtime.agent_runtime.conversation_state import ConversationRuntimeState
from runtime.agent_runtime.json_utils import parse_json_object
from runtime.agent_runtime.output_utils import build_thinking_chat_kwargs
from runtime.agent_runtime.mcp_prompt_guides import build_mcp_capability_section
from runtime.agent_runtime.hitl_memory import extract_session_defaults, is_session_defaults_payload
from runtime.agent_runtime.orchestrator import PlanAdjustment, RuntimeBootstrapResult
from runtime.prompts import render_prompt
from runtime.skills.models import ExecutionPlan, ExecutionState, ExecutionStep, RoutingResult, SkillPackage, StepResult

logger = logging.getLogger(__name__)


class AgentControllerServices(Protocol):
    ai_service: Any
    planning_policy: Any

    def extract_usage_metrics(self, payload: Optional[Dict[str, Any]]) -> tuple[int, int, int]:
        ...

    def record_observability_span(self, **kwargs) -> None:
        ...

    def get_control_ai_service(self) -> Any:
        ...


@dataclass
class AgentControlRequest:
    state: ExecutionState
    completed_step: ExecutionStep
    step_result: StepResult
    handoff: Dict[str, Any]
    message: str
    all_tools: List[Dict]
    routing_result: RoutingResult


class AgentController:
    """Headless controller for dynamic skill selection and plan mutation."""

    _MULTI_STAGE_PATTERNS = (
        re.compile(r"按顺序"),
        re.compile(r"不要一步到位"),
        re.compile(r"分[两二三四五六七八九十]\s*步"),
        re.compile(r"先.+?(再|然后).+?(最后|最终)"),
        # 链式请求（无"先/最后"限定词），至少两个连接词
        # 例："自我介绍，然后看下xxx，再推荐yyy"
        re.compile(r"(?:然后|再|接着|之后|其次).+?(?:然后|再|接着|之后|最后|最终|最后一步)"),
        # 逗号/顿号 + 连接词：例"自我介绍，然后看下数据库"
        # 只匹配真正的分段连接词，避免把"比较...并给出结论"这种单任务请求误判成多阶段
        re.compile(r"[,，、]\s*(?:然后|再|接着|之后|其次|最后|最终)"),
    )
    _INTERMEDIATE_ONLY_MARKERS = (
        "中间结果",
        "结构化交接结果",
        "交接结果",
        "不输出最终回答",
        "后续还未完成",
        "下一步",
        "先拆解",
        "再整理",
    )
    _FINAL_SKILL_MARKERS = (
        "final",
        "synth",
        "汇总",
        "总结",
        "成文",
        "最终答案",
        "最终答复",
        "最终说明",
        "面向用户输出最终",
    )
    _FINAL_SKILL_NEGATION_MARKERS = (
        "不要输出最终",
        "不输出最终",
        "尚未完成",
        "中间结果",
        "只输出中间",
    )
    _RESEARCH_REQUEST_MARKERS = (
        "搜索",
        "检索",
        "抓取",
        "网页",
        "网站",
        "页面",
        "官网",
        "官方",
        "教程",
        "文档",
        "资料",
        "来源",
        "比较",
        "对比",
        "最新",
        "research",
        "search",
        "crawl",
        "compare",
    )
    _INTERMEDIATE_OUTPUT_MARKERS = (
        '"task_breakdown"',
        '"task_decomposition"',
        '"sub_task',
        '"next_step"',
        '"status"',
        "任务拆解",
        "后续步骤",
        "当前状态",
        "研究结果",
        "搜索结果",
        "抓取结果",
        "tool_calls",
    )
    _OPTIONAL_FOLLOWUP_MARKERS = (
        "if it helps",
        "if helpful",
        "if needed",
        "if necessary",
        "if useful",
        "if that helps",
        "如果有帮助",
        "如果需要",
        "如有需要",
        "必要时",
    )
    _FINAL_ANSWER_TEXT_MARKERS = (
        "final verdict",
        "final answer",
        "final recommendation",
        "final conclusion",
        "my verdict",
        "conclusion",
        "recommendation",
        "最终结论",
        "最终答案",
        "最终建议",
    )
    _HITL_STAGED_COMPLETION_MARKERS = (
        "staged for your approval",
        "staged for human apply",
        "staged_for_human_apply",
        "waiting for you to apply",
        "queued and waiting for you to apply",
        "requires apply",
        "requires human apply",
        "等待你 apply",
        "等待您 apply",
        "等待人工确认",
    )
    _ATTACHMENT_CONTEXT_MARKERS = (
        "[available attachments]",
        "[attachment tool routing]",
    )
    _ATTACHMENT_BUILTIN_TOOL_NAMES = {
        "vl_query",
        "document_read_by_attachment",
    }

    def __init__(self, services: AgentControllerServices):
        self.services = services

    def _get_control_ai_service(self) -> Any:
        getter = getattr(self.services, "get_control_ai_service", None)
        if callable(getter):
            try:
                selected = getter()
                if selected is not None:
                    return selected
            except Exception as exc:
                logger.warning("[AgentControl] Failed to get dedicated control AI service: %s", exc)
        return self.services.ai_service

    @staticmethod
    def _build_control_chat_kwargs(ai_service: Any) -> Dict[str, Any]:
        return build_thinking_chat_kwargs(ai_service)

    @classmethod
    def _message_contains_attachment_context(cls, message: str) -> bool:
        normalized = str(message or "")
        return any(marker in normalized for marker in cls._ATTACHMENT_CONTEXT_MARKERS)

    @classmethod
    def _attachment_tool_names_to_inject(cls, *, message: str) -> Optional[List[str]]:
        """Return attachment builtin tool names to inject, or None if no attachment context detected."""
        if not cls._message_contains_attachment_context(message):
            return None
        return list(cls._ATTACHMENT_BUILTIN_TOOL_NAMES)

    def build_prompt(
        self,
        request: AgentControlRequest,
        *,
        decision_signals: Optional[Dict[str, Any]] = None,
    ) -> str:
        remaining_steps = request.state.remaining_runtime_steps(request.state.current_step_index + 1)
        available_skills = [
            {
                "name": pkg.name,
                "description": pkg.description,
                "when_to_use": pkg.when_to_use,
                "allowed_tools": list(pkg.allowed_tools or []),
            }
            for pkg in request.state.available_skill_packages.values()
        ]
        completed_handoffs = [
            {
                "step_id": step_id,
                "from_skill": payload.get("from_skill"),
                "summary": payload.get("summary"),
                "target_intents": payload.get("target_intents", []),
                "sources_count": payload.get("sources_count", 0),
            }
            for step_id, payload in request.state.shared_memory.items()
            if not is_session_defaults_payload(payload)
        ]
        session_defaults = extract_session_defaults(request.state.shared_memory)
        remaining_steps_payload = [
            {
                "step_id": step.step_id,
                "skill_name": step.skill_name,
                "step_type": step.step_type,
                "goal": step.goal,
                "target_intents": step.target_intents,
                "done_when": step.done_when,
                "is_final_step": step.is_final_step,
            }
            for step in remaining_steps
        ]
        conversation_runtime = {
            "open_goals": list(request.state.open_goals or []),
            "pending_user_input": dict(request.state.pending_user_input or {}) if request.state.pending_user_input else None,
            "last_active_skill_name": request.state.last_active_skill_name,
            "skills_executed": list(request.state.skills_executed or []),
            "session_defaults": session_defaults,
        }
        available_tool_names = [
            tool.get("function", {}).get("name", "")
            for tool in request.all_tools
            if tool.get("function", {}).get("name")
        ]
        if decision_signals is None:
            decision_signals = self._build_controller_decision_signals(
                request=request,
                remaining_steps=remaining_steps,
            )
        durable_memory_text = ""
        durable_memory_context = getattr(request.state, "durable_memory_context", None)
        if durable_memory_context and hasattr(durable_memory_context, "to_controller_text"):
            durable_memory_text = durable_memory_context.to_controller_text()
        durable_memory_section = f"{durable_memory_text}\n" if durable_memory_text else ""
        mcp_capability_section = build_mcp_capability_section(request.all_tools)

        return render_prompt(
            "runtime/agent_controller_user.md",
            message=request.message,
            routing_reason=request.routing_result.reason,
            planned_order_json=json.dumps(request.routing_result.planned_order or [], ensure_ascii=False),
            decision_signals_json=json.dumps(decision_signals, ensure_ascii=False),
            completed_step_json=json.dumps(
                {
                    "step_id": request.completed_step.step_id,
                    "skill_name": request.completed_step.skill_name,
                    "step_type": request.completed_step.step_type,
                    "goal": request.completed_step.goal,
                    "target_intents": request.completed_step.target_intents,
                },
                ensure_ascii=False,
            ),
            step_result_json=json.dumps(
                {
                    "success": request.step_result.success,
                    "summary": request.step_result.summary,
                    "output_preview": (request.step_result.raw_text or "")[:600],
                },
                ensure_ascii=False,
            ),
            handoff_json=json.dumps(request.handoff, ensure_ascii=False),
            completed_handoffs_json=json.dumps(completed_handoffs[-5:], ensure_ascii=False),
            conversation_runtime_json=json.dumps(conversation_runtime, ensure_ascii=False),
            durable_memory_section=durable_memory_section,
            remaining_steps_json=json.dumps(remaining_steps_payload, ensure_ascii=False),
            available_skills_json=json.dumps(available_skills, ensure_ascii=False),
            available_tool_names_json=json.dumps(available_tool_names, ensure_ascii=False),
            mcp_capability_section=f"{mcp_capability_section}\n" if mcp_capability_section else "",
        )

    @classmethod
    def _message_requests_multi_stage(cls, message: str) -> bool:
        normalized = re.sub(r"\s+", " ", str(message or "")).strip()
        if not normalized:
            return False
        if any(pattern.search(normalized) for pattern in cls._MULTI_STAGE_PATTERNS):
            return True
        if "先" in normalized and ("再" in normalized or "然后" in normalized) and ("最后" in normalized or "最终" in normalized):
            return True
        # 至少两个不同的连接词 → 视为链式多阶段
        connective_hits = sum(
            1 for marker in ("然后", "再", "接着", "之后", "并且", "同时") if marker in normalized
        )
        return connective_hits >= 2

    _SUBTASK_SPLIT_PATTERN = re.compile(
        r"然后|再(?![试一])|接着|之后|其次|最后|最终|并且|同时|以及|还有|另外|，|,|；|;"
    )

    @classmethod
    def _estimate_subtask_count(cls, message: str) -> int:
        """粗估用户请求里的子任务数量，用于判断多阶段是否已经走完。"""
        normalized = re.sub(r"\s+", " ", str(message or "")).strip()
        if not normalized:
            return 1
        segments = [s for s in cls._SUBTASK_SPLIT_PATTERN.split(normalized) if s.strip()]
        # 过滤掉极短的碎片（比如只有语气词/副词）
        meaningful = [s for s in segments if len(s.strip()) >= 3]
        return max(len(meaningful), 1)

    @classmethod
    def _message_likely_needs_external_tools(cls, message: str) -> bool:
        normalized = re.sub(r"\s+", " ", str(message or "")).strip().lower()
        if not normalized:
            return False
        return any(marker in normalized for marker in cls._RESEARCH_REQUEST_MARKERS)

    @classmethod
    def _skill_package_is_final_like(cls, package: Optional[SkillPackage], skill_name: str) -> bool:
        normalized_skill = str(skill_name or "").strip().lower()
        if normalized_skill == "final_synthesizer":
            return True
        text = " ".join(
            part
            for part in (
                normalized_skill,
                getattr(package, "description", "") if package else "",
                getattr(package, "when_to_use", "") if package else "",
                getattr(package, "instructions", "") if package else "",
            )
            if part
        ).lower()
        if any(marker in text for marker in cls._FINAL_SKILL_NEGATION_MARKERS):
            return False
        return any(marker in text for marker in cls._FINAL_SKILL_MARKERS)

    @classmethod
    def _step_is_final_like(cls, state: ExecutionState, step: ExecutionStep) -> bool:
        if step.step_type == "synthesis":
            return True
        package = state.available_skill_packages.get(step.skill_name)
        return cls._skill_package_is_final_like(package, step.skill_name)

    @classmethod
    def _step_is_intermediate_only(
        cls,
        *,
        step: ExecutionStep,
        step_result: StepResult,
        handoff: Dict[str, Any],
    ) -> bool:
        if step.step_type == "synthesis":
            return False
        text_fragments = [
            step.instructions,
            step.done_when,
            step_result.summary,
            step_result.raw_text,
            str(handoff.get("summary") or ""),
            json.dumps(step_result.output or {}, ensure_ascii=False),
        ]
        combined = "\n".join(fragment for fragment in text_fragments if fragment)
        return any(marker in combined for marker in cls._INTERMEDIATE_ONLY_MARKERS)

    def _next_non_final_planned_skill_name(self, request: AgentControlRequest) -> Optional[str]:
        planned_order = list(request.routing_result.planned_order or [])
        if not planned_order:
            return None
        current_skill = request.completed_step.skill_name
        try:
            current_index = planned_order.index(current_skill)
        except ValueError:
            current_index = -1
        executed_skills = {str(name).strip() for name in request.state.skills_executed if str(name).strip()}
        for skill_name in planned_order[current_index + 1:]:
            normalized = str(skill_name or "").strip()
            if not normalized or normalized in executed_skills or normalized == current_skill:
                continue
            package = request.state.available_skill_packages.get(normalized)
            if not package:
                continue
            if self._skill_package_is_final_like(package, normalized):
                continue
            return normalized
        return None

    @classmethod
    def _extract_step_output_text(
        cls,
        *,
        step_result: StepResult,
        handoff: Dict[str, Any],
    ) -> str:
        fragments = [
            step_result.raw_text,
            str(step_result.output.get("text") or ""),
            str(step_result.output.get("final_answer") or ""),
            str(handoff.get("summary") or ""),
        ]
        return "\n".join(fragment.strip() for fragment in fragments if str(fragment or "").strip()).strip()

    @classmethod
    def _output_looks_intermediate_structured(cls, text: str) -> bool:
        normalized = str(text or "").strip()
        if not normalized:
            return False
        if normalized.startswith("{") or normalized.startswith("[") or normalized.startswith("```json"):
            return True
        lowered = normalized.lower()
        return any(marker.lower() in lowered for marker in cls._INTERMEDIATE_OUTPUT_MARKERS)

    @classmethod
    def _message_has_optional_followup(cls, message: str) -> bool:
        normalized = re.sub(r"\s+", " ", str(message or "")).strip().lower()
        return any(marker in normalized for marker in cls._OPTIONAL_FOLLOWUP_MARKERS)

    @classmethod
    def _output_looks_user_facing_answer(cls, text: str) -> bool:
        normalized = str(text or "").strip()
        if len(normalized) < 80:
            return False
        if cls._output_looks_intermediate_structured(normalized):
            return False
        lowered = normalized.lower()
        return not any(marker.lower() in lowered for marker in cls._INTERMEDIATE_ONLY_MARKERS)

    @classmethod
    def _output_has_final_answer_marker(cls, text: str) -> bool:
        lowered = str(text or "").lower()
        return any(marker.lower() in lowered for marker in cls._FINAL_ANSWER_TEXT_MARKERS)

    @classmethod
    def _output_is_hitl_staged_completion(cls, text: str) -> bool:
        lowered = re.sub(r"\s+", " ", str(text or "").strip().lower())
        return any(marker.lower() in lowered for marker in cls._HITL_STAGED_COMPLETION_MARKERS)

    def _next_final_planned_skill_name(self, request: AgentControlRequest) -> Optional[str]:
        planned_order = list(request.routing_result.planned_order or [])
        if not planned_order:
            return None
        current_skill = request.completed_step.skill_name
        try:
            current_index = planned_order.index(current_skill)
        except ValueError:
            current_index = -1
        executed_skills = {str(name).strip() for name in request.state.skills_executed if str(name).strip()}
        for skill_name in planned_order[current_index + 1:]:
            normalized = str(skill_name or "").strip()
            if not normalized or normalized in executed_skills:
                continue
            package = request.state.available_skill_packages.get(normalized)
            if not package:
                continue
            if self._skill_package_is_final_like(package, normalized):
                return normalized
        return None

    def _build_final_synthesis_adjustment(
        self,
        *,
        request: AgentControlRequest,
        reason: str,
    ) -> Optional["PlanAdjustment"]:
        remaining_steps = request.state.remaining_runtime_steps(request.state.current_step_index + 1)
        remaining_final_steps = [
            step
            for step in remaining_steps
            if self._step_is_final_like(request.state, step)
        ]
        if remaining_final_steps:
            return PlanAdjustment(
                inserted_steps=[],
                replace_remaining=False,
                next_step_index=request.state.current_step_index + 1,
                reason=reason,
                action="replan",
                source="agent_control",
            )

        final_skill_name = self._next_final_planned_skill_name(request)
        if final_skill_name:
            step = self.build_dynamic_step_from_adjustment(
                state=request.state,
                completed_step=request.completed_step,
                message=request.message,
                all_tools=request.all_tools,
                item={
                    "step_type": "skill",
                    "skill_name": final_skill_name,
                    "goal": "基于已有研究结果生成最终用户答复",
                    "target_intents": [request.message],
                    "instructions": (
                        f"基于前序步骤输出，使用 {final_skill_name} 生成可直接发送给用户的最终答复。"
                        "不要再输出任务拆解、过程记录或中间结构。"
                    ),
                    "done_when": "产出覆盖全部问题的最终完整答复。",
                },
                item_index=0,
            )
            if step:
                return PlanAdjustment(
                    inserted_steps=[step],
                    replace_remaining=False,
                    next_step_index=None,
                    reason=reason,
                    action="replan",
                    source="agent_control",
                )

        synthesis_step = self.build_dynamic_step_from_adjustment(
            state=request.state,
            completed_step=request.completed_step,
            message=request.message,
            all_tools=request.all_tools,
            item={
                "step_type": "synthesis",
                "goal": "汇总已完成的研究结果并输出最终用户答复",
                "target_intents": [request.message],
                "instructions": "基于前序步骤输出进行统一回答，去掉过程性结构，直接给出最终用户答复。",
                "done_when": "产出覆盖全部问题的最终完整答复。",
            },
            item_index=0,
        )
        if not synthesis_step:
            return None
        return PlanAdjustment(
            inserted_steps=[synthesis_step],
            replace_remaining=False,
            next_step_index=None,
            reason=reason,
            action="replan",
            source="agent_control",
        )

    def _normalize_adjustment_against_signals(
        self,
        *,
        request: AgentControlRequest,
        adjustment: Optional["PlanAdjustment"],
        decision_signals: Dict[str, Any],
    ) -> Optional["PlanAdjustment"]:
        if adjustment is None or adjustment.action != "finish":
            return adjustment
        if decision_signals.get("has_unfinished_subtasks"):
            return self._build_final_synthesis_adjustment(
                request=request,
                reason="completed step still leaves unfinished subtasks; force final synthesis before ending",
            )
        if decision_signals.get("should_force_final_synthesis"):
            return self._build_final_synthesis_adjustment(
                request=request,
                reason="completed step still looks like intermediate research output; force final synthesis before ending",
            )
        return adjustment

    def _build_bootstrap_request_signals(
        self,
        *,
        message: str,
        active_skill_hint: str,
        conversation_context: Dict[str, Any],
        all_skill_packages: List[SkillPackage],
        tool_names: List[str],
    ) -> Dict[str, Any]:
        return {
            "message_requests_multi_stage": self._message_requests_multi_stage(message),
            "message_likely_needs_external_tools": self._message_likely_needs_external_tools(message),
            "has_active_skill_hint": bool(active_skill_hint),
            "has_pending_user_input": bool(conversation_context.get("pending_user_input")),
            "has_open_goals": bool(conversation_context.get("open_goals")),
            "recent_handoffs_count": len(conversation_context.get("recent_handoffs") or []),
            "available_skill_names": [pkg.name for pkg in all_skill_packages],
            "available_tool_names": list(tool_names),
            "preferred_response_mode": (
                "handoff_first_step"
                if self._message_requests_multi_stage(message) or self._message_likely_needs_external_tools(message)
                else "direct_or_single_step"
            ),
        }

    def _build_controller_decision_signals(
        self,
        *,
        request: AgentControlRequest,
        remaining_steps: List[ExecutionStep],
    ) -> Dict[str, Any]:
        output_text = self._extract_step_output_text(
            step_result=request.step_result,
            handoff=request.handoff,
        )
        current_step_is_intermediate_only = self._step_is_intermediate_only(
            step=request.completed_step,
            step_result=request.step_result,
            handoff=request.handoff,
        )
        current_step_is_final_like = self._step_is_final_like(request.state, request.completed_step)
        remaining_non_final_steps = [
            step
            for step in remaining_steps
            if not self._step_is_final_like(request.state, step)
        ]
        has_tool_heavy_completed_step = bool(
            (request.step_result.tool_calls_count or 0) > 0
            or request.step_result.sources
            or self._message_likely_needs_external_tools(request.message)
        )
        output_looks_intermediate_structured = self._output_looks_intermediate_structured(output_text)
        output_looks_user_facing_answer = self._output_looks_user_facing_answer(output_text)
        output_has_final_answer_marker = self._output_has_final_answer_marker(output_text)
        output_is_hitl_staged_completion = self._output_is_hitl_staged_completion(output_text)
        optional_followup = self._message_has_optional_followup(request.message)
        next_non_final_skill_from_planned_order = self._next_non_final_planned_skill_name(request)
        message_requests_multi_stage = self._message_requests_multi_stage(request.message)
        executed_non_final_skill_count = sum(
            1
            for name in (request.state.skills_executed or [])
            if not self._skill_package_is_final_like(
                request.state.available_skill_packages.get(name), name
            )
        )
        estimated_subtask_count = (
            self._estimate_subtask_count(request.message)
            if message_requests_multi_stage
            else 1
        )
        multi_stage_not_fully_addressed = bool(
            message_requests_multi_stage
            and executed_non_final_skill_count < estimated_subtask_count
        )
        single_step_optional_followup_answered = bool(
            request.step_result.success
            and optional_followup
            and output_looks_user_facing_answer
            and not message_requests_multi_stage
            and not remaining_steps
            and not next_non_final_skill_from_planned_order
        )
        single_step_final_answered = bool(
            request.step_result.success
            and (output_has_final_answer_marker or output_is_hitl_staged_completion)
            and output_looks_user_facing_answer
            and not remaining_steps
            and not next_non_final_skill_from_planned_order
        )
        has_unfinished_subtasks = bool(
            not single_step_optional_followup_answered
            and not single_step_final_answered
            and current_step_is_intermediate_only
            and (
                next_non_final_skill_from_planned_order
                or not remaining_non_final_steps
            )
        ) or multi_stage_not_fully_addressed
        should_force_final_synthesis = bool(
            request.step_result.success
            and not current_step_is_final_like
            and not single_step_optional_followup_answered
            and not single_step_final_answered
            and has_tool_heavy_completed_step
            and output_looks_intermediate_structured
            and (
                not remaining_steps
                or not remaining_non_final_steps
            )
        )
        recommended_action = "continue"
        if should_force_final_synthesis:
            recommended_action = "replan"
        elif has_unfinished_subtasks and next_non_final_skill_from_planned_order:
            recommended_action = "select_skill"
        elif has_unfinished_subtasks:
            recommended_action = "replan"
        elif request.step_result.success and not remaining_steps:
            recommended_action = "finish"
        return {
            "message_requests_multi_stage": message_requests_multi_stage,
            "message_likely_needs_external_tools": self._message_likely_needs_external_tools(request.message),
            "current_step_is_intermediate_only": current_step_is_intermediate_only,
            "current_step_is_final_like": current_step_is_final_like,
            "step_success": bool(request.step_result.success),
            "tool_calls_in_completed_step": int(request.step_result.tool_calls_count or 0),
            "sources_count_in_completed_step": len(request.step_result.sources or []),
            "has_tool_heavy_completed_step": has_tool_heavy_completed_step,
            "output_looks_intermediate_structured": output_looks_intermediate_structured,
            "output_looks_user_facing_answer": output_looks_user_facing_answer,
            "output_has_final_answer_marker": output_has_final_answer_marker,
            "output_is_hitl_staged_completion": output_is_hitl_staged_completion,
            "optional_followup": optional_followup,
            "single_step_optional_followup_answered": single_step_optional_followup_answered,
            "single_step_final_answered": single_step_final_answered,
            "remaining_step_count": len(remaining_steps),
            "remaining_non_final_step_count": len(remaining_non_final_steps),
            "only_final_steps_remaining": bool(remaining_steps) and not remaining_non_final_steps,
            "no_remaining_steps": not remaining_steps,
            "next_non_final_skill_from_planned_order": next_non_final_skill_from_planned_order,
            "executed_skills": list(request.state.skills_executed or []),
            "executed_non_final_skill_count": executed_non_final_skill_count,
            "multi_stage_not_fully_addressed": multi_stage_not_fully_addressed,
            "has_unfinished_subtasks": has_unfinished_subtasks,
            "should_force_final_synthesis": should_force_final_synthesis,
            "recommended_action": recommended_action,
        }

    def build_initial_prompt(
        self,
        *,
        message: str,
        all_skill_packages: List[SkillPackage],
        all_tools: List[Dict],
        active_skill_name: Optional[str],
        conversation_state: Optional[ConversationRuntimeState],
        durable_memory_context: Optional[Any] = None,
    ) -> str:
        skills_catalog = [
            {
                "name": pkg.name,
                "description": pkg.description,
                "when_to_use": pkg.when_to_use,
                "allowed_tools": list(pkg.allowed_tools or []),
            }
            for pkg in all_skill_packages
        ]
        tool_names = [
            tool.get("function", {}).get("name", "")
            for tool in all_tools
            if tool.get("function", {}).get("name")
        ]
        active_skill_hint = active_skill_name or (
            conversation_state.last_active_skill_name if conversation_state else ""
        )
        conversation_context = {
            "turn_count": int(conversation_state.turn_count or 0) if conversation_state else 0,
            "last_user_goal": conversation_state.last_user_goal if conversation_state else "",
            # Surface the previous turn's answer so follow-up references
            # ("the second one", "用上一个") resolve against a real antecedent
            # instead of forcing the router to re-ask for clarification.
            "last_final_answer": ((conversation_state.last_final_answer or "")[:600]) if conversation_state else "",
            "open_goals": list((conversation_state.open_goals or []) if conversation_state else []),
            "last_active_skill_name": conversation_state.last_active_skill_name if conversation_state else None,
            "pending_user_input": (
                dict(conversation_state.pending_user_input)
                if conversation_state and conversation_state.pending_user_input
                else None
            ),
            "pending_actions": list(conversation_state.current_pending_actions() if conversation_state else []),
            "recent_handoffs": [
                {
                    "from_skill": payload.get("from_skill"),
                    "summary": payload.get("summary"),
                    "target_intents": payload.get("target_intents", []),
                }
                for payload in list((conversation_state.shared_memory or {}).values())[-3:]
                if isinstance(payload, dict)
                and not is_session_defaults_payload(payload)
            ] if conversation_state else [],
            "session_defaults": (
                extract_session_defaults(conversation_state.shared_memory)
                if conversation_state
                else []
            ),
        }
        durable_memory_text = ""
        if durable_memory_context and hasattr(durable_memory_context, "to_bootstrap_text"):
            durable_memory_text = durable_memory_context.to_bootstrap_text()
        durable_memory_section = f"{durable_memory_text}\n" if durable_memory_text else ""
        mcp_capability_section = build_mcp_capability_section(all_tools)
        request_signals = self._build_bootstrap_request_signals(
            message=message,
            active_skill_hint=active_skill_hint,
            conversation_context=conversation_context,
            all_skill_packages=all_skill_packages,
            tool_names=tool_names,
        )
        return render_prompt(
            "runtime/bootstrap_controller_user.md",
            message=message,
            active_skill_hint=active_skill_hint,
            request_signals_json=json.dumps(request_signals, ensure_ascii=False),
            conversation_context_json=json.dumps(conversation_context, ensure_ascii=False),
            durable_memory_section=durable_memory_section,
            skills_catalog_json=json.dumps(skills_catalog, ensure_ascii=False),
            tool_names_json=json.dumps(tool_names, ensure_ascii=False),
            mcp_capability_section=f"{mcp_capability_section}\n" if mcp_capability_section else "",
        )

    def _build_bootstrap_routing_result(
        self,
        *,
        all_skill_packages: List[SkillPackage],
        execution_plan: ExecutionPlan,
        reason: str,
        active_skill_name: Optional[str],
    ) -> RoutingResult:
        skill_map = {pkg.name: pkg for pkg in all_skill_packages}
        selected_skill = None
        skill_name = None
        planned_order: List[str] = []
        for step in execution_plan.steps:
            if step.step_type == "skill" and step.skill_name in skill_map:
                planned_order.append(step.skill_name)
                if selected_skill is None:
                    selected_skill = skill_map[step.skill_name]
                    skill_name = step.skill_name
        if active_skill_name and active_skill_name in skill_map and active_skill_name not in planned_order:
            planned_order.insert(0, active_skill_name)
            if selected_skill is None:
                selected_skill = skill_map[active_skill_name]
                skill_name = active_skill_name
        return RoutingResult(
            selected_skill=selected_skill,
            skill_name=skill_name,
            confidence=1.0 if selected_skill else 0.0,
            reason=reason or "runtime bootstrap selected initial execution plan",
            routing_method="runtime_bootstrap",
            candidate_skills=list(all_skill_packages),
            planned_order=planned_order,
        )

    def _fallback_bootstrap_plan(
        self,
        *,
        message: str,
        all_skill_packages: List[SkillPackage],
        all_tools: List[Dict],
        active_skill_name: Optional[str],
    ) -> RuntimeBootstrapResult:
        skill_map = {pkg.name: pkg for pkg in all_skill_packages}
        selected_skill = skill_map.get(active_skill_name or "") if active_skill_name else None
        item: Dict[str, Any]
        reason: str
        if selected_skill:
            item = {
                "step_type": "skill",
                "skill_name": selected_skill.name,
                "goal": f"处理用户请求：{message}",
                "target_intents": [message],
            }
            reason = f"fallback to active skill hint: {selected_skill.name}"
        else:
            item = {
                "step_type": "general",
                "goal": f"处理用户请求：{message}",
                "target_intents": [message],
            }
            reason = "fallback to single general step"

        anchor = ExecutionStep(
            step_id="request_root",
            skill_name="runtime_entry",
            goal=message,
            instructions="runtime bootstrap",
            step_type="general",
        )
        state = ExecutionState(
            conversation_id="bootstrap",
            current_turn_id=None,
            plan=ExecutionPlan(
                user_goal=message,
                routing_reason=reason,
                routing_method="runtime_bootstrap_fallback",
                steps=[],
                multi_skill_mode=False,
            ),
            available_skill_packages=skill_map,
        )
        step = self.build_dynamic_step_from_adjustment(
            state=state,
            completed_step=anchor,
            message=message,
            all_tools=all_tools,
            item=item,
            item_index=0,
        )
        if not step:
            step = ExecutionStep(
                step_id="s1",
                skill_name="general_assistant",
                goal=f"处理用户请求：{message}",
                instructions="该步骤未绑定专用 Skill，仅处理当前用户请求。",
                step_type="general",
                target_intents=[message],
                is_final_step=True,
            )
        step.step_id = "s1"
        step.depends_on = []
        step.is_final_step = True
        plan = ExecutionPlan(
            user_goal=message,
            routing_reason=reason,
            routing_method="runtime_bootstrap_fallback",
            steps=[step],
            multi_skill_mode=False,
        )
        routing_result = self._build_bootstrap_routing_result(
            all_skill_packages=all_skill_packages,
            execution_plan=plan,
            reason=reason,
            active_skill_name=active_skill_name,
        )
        return RuntimeBootstrapResult(routing_result=routing_result, execution_plan=plan)

    def _manual_active_skill_bootstrap_plan(
        self,
        *,
        message: str,
        all_skill_packages: List[SkillPackage],
        all_tools: List[Dict],
        active_skill_name: str,
        skill_recommendation_candidates: Optional[List[Dict[str, Any]]] = None,
        conversation_id: Optional[str] = None,
        current_turn_id: Optional[str] = None,
        durable_memory_context: Optional[Any] = None,
        conversation_state: Optional[ConversationRuntimeState] = None,
    ) -> RuntimeBootstrapResult:
        normalized_active_skill = str(active_skill_name or "").strip()
        skill_map = {pkg.name: pkg for pkg in all_skill_packages}
        selected_skill = skill_map.get(normalized_active_skill)
        if selected_skill is None:
            raise ValueError(f"manual active skill is not available: {normalized_active_skill}")

        reason = f"manual active skill lock: {normalized_active_skill}"
        state = ExecutionState(
            conversation_id=conversation_id or "bootstrap",
            current_turn_id=current_turn_id,
            plan=ExecutionPlan(
                user_goal=message,
                routing_reason=reason,
                routing_method="manual_active_skill",
                steps=[],
                multi_skill_mode=False,
            ),
            available_skill_packages=skill_map,
            durable_memory_context=durable_memory_context,
            shared_memory=dict((conversation_state.shared_memory or {}) if conversation_state else {}),
            open_goals=list((conversation_state.open_goals or []) if conversation_state else []),
            pending_user_input=(
                dict(conversation_state.pending_user_input)
                if conversation_state and conversation_state.pending_user_input
                else None
            ),
            last_active_skill_name=(
                conversation_state.last_active_skill_name
                if conversation_state
                else None
            ),
        )
        anchor = ExecutionStep(
            step_id="request_root",
            skill_name="runtime_entry",
            goal=message,
            instructions="runtime bootstrap",
            step_type="general",
        )
        recommendation_instruction = self._format_manual_skill_recommendation_instruction(
            active_skill_name=normalized_active_skill,
            skill_recommendation_candidates=skill_recommendation_candidates or [],
        )
        step = self.build_dynamic_step_from_adjustment(
            state=state,
            completed_step=anchor,
            message=message,
            all_tools=all_tools,
            item={
                "step_type": "skill",
                "skill_name": normalized_active_skill,
                "goal": f"使用用户手动指定的 Skill 处理请求：{message}",
                "target_intents": [message],
                "instructions": (
                    f"用户通过 /{normalized_active_skill} 手动指定本轮只使用该 Skill。"
                    f"仅在 {normalized_active_skill} 的能力边界内处理当前请求。"
                    "如果请求明显不匹配，说明更合适的 Skill 并建议用户切换；不要自动切换到其他 Skill。"
                    f"{recommendation_instruction}"
                    "直接产出可发送给用户的最终回答。"
                ),
                "done_when": "产出当前指定 Skill 能力范围内的最终回答或明确的切换建议。",
            },
            item_index=0,
        )
        if step is None:
            raise ValueError(f"failed to build manual active skill step: {normalized_active_skill}")

        step.step_id = "s1"
        step.depends_on = []
        step.is_final_step = True
        plan = ExecutionPlan(
            user_goal=message,
            routing_reason=reason,
            routing_method="manual_active_skill",
            steps=[step],
            multi_skill_mode=False,
            planner_metrics={"manual_active_skill": True, "llm_calls": 0},
        )
        routing_result = RoutingResult(
            selected_skill=selected_skill,
            skill_name=normalized_active_skill,
            confidence=1.0,
            reason=reason,
            routing_method="manual_active_skill",
            candidate_skills=list(all_skill_packages),
            planned_order=[normalized_active_skill],
        )
        return RuntimeBootstrapResult(routing_result=routing_result, execution_plan=plan)

    @staticmethod
    def _format_manual_skill_recommendation_instruction(
        *,
        active_skill_name: str,
        skill_recommendation_candidates: List[Dict[str, Any]],
    ) -> str:
        if not skill_recommendation_candidates:
            return ""
        first = skill_recommendation_candidates[0]
        recommended_name = str(first.get("name") or "").strip()
        if not recommended_name or recommended_name == active_skill_name:
            return ""
        description = str(first.get("description") or "").strip()
        when_to_use = str(first.get("when_to_use") or "").strip()
        reason = str(first.get("reason") or "").strip()
        matched_keywords = [
            str(item).strip()
            for item in (first.get("matched_keywords") or [])
            if str(item).strip()
        ]
        matched_tags = [
            str(item).strip()
            for item in (first.get("matched_tags") or [])
            if str(item).strip()
        ]
        evidence_parts = []
        if description:
            evidence_parts.append(f"描述：{description}")
        if when_to_use:
            evidence_parts.append(f"适用场景：{when_to_use}")
        if matched_keywords:
            evidence_parts.append(f"匹配关键词：{', '.join(matched_keywords[:5])}")
        if matched_tags:
            evidence_parts.append(f"匹配标签：{', '.join(matched_tags[:5])}")
        if reason:
            evidence_parts.append(f"推荐原因：{reason}")
        evidence = "；".join(evidence_parts)
        suffix = f"（{evidence}）" if evidence else ""
        return (
            f"系统只读推荐：根据当前问题，/{recommended_name} 可能比 /{active_skill_name} 更匹配{suffix}。"
            f"本轮仍必须继续按 /{active_skill_name} 执行，禁止自动切换或调用 /{recommended_name}。"
            f"如果回答中需要提示用户，只能建议其重新发送 /{recommended_name}。"
        )

    def build_dynamic_step_from_adjustment(
        self,
        *,
        state: ExecutionState,
        completed_step: ExecutionStep,
        message: str,
        all_tools: List[Dict],
        item: Dict[str, Any],
        item_index: int,
    ) -> Optional[ExecutionStep]:
        if not isinstance(item, dict):
            return None

        step_type = str(item.get("step_type") or "").strip().lower()
        skill_name = str(item.get("skill_name") or "").strip()
        if step_type not in {"skill", "general", "synthesis"}:
            step_type = "skill" if skill_name else "general"

        target_intents = [
            str(intent).strip()
            for intent in (item.get("target_intents") or [])
            if str(intent).strip()
        ]
        if not target_intents:
            fallback_intent = str(item.get("intent") or item.get("goal") or "").strip()
            if fallback_intent:
                target_intents = [fallback_intent]

        goal = str(item.get("goal") or "").strip() or (
            f"处理新增子问题：{'；'.join(target_intents)}" if target_intents else "处理新增步骤"
        )

        if step_type == "skill" and skill_name:
            selected_skill = state.available_skill_packages.get(skill_name)
            if not selected_skill:
                logger.warning("[Agent] Ignoring dynamic plan adjustment, unknown skill: %s", skill_name)
                return None
            raw_allow_all_tools = item.get("allow_all_tools")
            explicit_allow_all_tools: Optional[bool]
            if isinstance(raw_allow_all_tools, bool):
                explicit_allow_all_tools = raw_allow_all_tools
            elif isinstance(raw_allow_all_tools, str):
                normalized_allow_all_tools = raw_allow_all_tools.strip().lower()
                if normalized_allow_all_tools in {"1", "true", "yes", "y"}:
                    explicit_allow_all_tools = True
                elif normalized_allow_all_tools in {"0", "false", "no", "n"}:
                    explicit_allow_all_tools = False
                else:
                    explicit_allow_all_tools = None
            else:
                explicit_allow_all_tools = None
            allowed_tools, allow_all_tools = self.services.planning_policy.resolve_skill_step_tool_policy(
                selected_skill=selected_skill,
                intent=goal,
                all_tools=all_tools,
                allow_all_tools_override=explicit_allow_all_tools,
            )
            instructions = str(item.get("instructions") or "").strip() or (
                f"仅处理当前新增子问题：{'；'.join(target_intents) or goal}。遵循 {skill_name} 能力边界执行。"
                "当前步骤仅输出中间结果，不输出最终回答。"
            )
            done_when = str(item.get("done_when") or "").strip() or "产出结构化交接结果。"
            output_schema = item.get("output_schema") if isinstance(item.get("output_schema"), dict) else None
            (
                allowed_tools,
                allow_all_tools,
                instructions,
                tools_disabled_by_user,
            ) = self.services.planning_policy.apply_user_tool_constraint(
                message=message,
                instructions=instructions,
                allowed_tools=allowed_tools,
                allow_all_tools=allow_all_tools,
            )
            explicit_tool_selection = (
                "allowed_tool_names" in item or "allow_all_tools" in item
            )
        elif step_type == "synthesis":
            skill_name = "final_synthesizer"
            allowed_tools = []
            allow_all_tools = False
            instructions = str(item.get("instructions") or "").strip() or (
                "基于当前所有已完成步骤输出进行统一回答，覆盖新增问题，不暴露内部执行细节。"
                "不要输出 HandoffPayload、JSON 交接结构、step_id、from_skill 等内部字段。"
            )
            done_when = str(item.get("done_when") or "").strip() or "产出覆盖全部问题的最终完整答复。"
            output_schema = None
            tools_disabled_by_user = False
            explicit_tool_selection = True
        else:
            skill_name = "general_assistant"
            allowed_tools = [
                str(name).strip()
                for name in (item.get("allowed_tool_names") or [])
                if str(name).strip()
            ]
            raw_allow_all_tools = item.get("allow_all_tools")
            allow_all_tools = bool(raw_allow_all_tools) if isinstance(raw_allow_all_tools, bool) else False
            instructions = str(item.get("instructions") or "").strip() or (
                f"该新增步骤未绑定专用 Skill，仅处理当前子问题：{'；'.join(target_intents) or goal}。"
                "当前步骤仅输出中间结果，不输出最终回答。"
            )
            done_when = str(item.get("done_when") or "").strip() or "产出结构化交接结果。"
            output_schema = None
            (
                allowed_tools,
                allow_all_tools,
                instructions,
                tools_disabled_by_user,
            ) = self.services.planning_policy.apply_user_tool_constraint(
                message=message,
                instructions=instructions,
                allowed_tools=allowed_tools,
                allow_all_tools=allow_all_tools,
            )
            explicit_tool_selection = (
                "allowed_tool_names" in item or "allow_all_tools" in item
            )
            inject_tools = self._attachment_tool_names_to_inject(message=message)
            if inject_tools:
                existing = set(allowed_tools)
                for t in inject_tools:
                    if t not in existing:
                        allowed_tools.append(t)
                if not tools_disabled_by_user:
                    allow_all_tools = True

        step_id = str(item.get("step_id") or "").strip() or (
            f"dyn_{completed_step.step_id}_{item_index + 1}_{state.total_runtime_steps() + item_index + 1}"
        )
        return ExecutionStep(
            step_id=step_id,
            skill_name=skill_name,
            goal=goal,
            instructions=instructions,
            step_type=step_type,
            target_intents=target_intents,
            blocked_intents=[],
            allowed_tool_names=allowed_tools,
            explicit_tool_selection=explicit_tool_selection,
            allow_all_tools=allow_all_tools,
            tools_disabled_by_user=tools_disabled_by_user,
            done_when=done_when,
            output_schema=output_schema,
            depends_on=[completed_step.step_id],
            is_final_step=False,
        )

    def convert_decision_json_to_plan_adjustment(
        self,
        *,
        state: ExecutionState,
        completed_step: ExecutionStep,
        message: str,
        all_tools: List[Dict],
        decision_json: Dict[str, Any],
    ) -> Optional[PlanAdjustment]:
        if not isinstance(decision_json, dict):
            return None

        action = str(decision_json.get("action") or "continue").strip().lower()
        allowed_actions = {"continue", "select_skill", "replan", "finish", "none", "noop"}
        if action not in allowed_actions:
            logger.warning("[AgentControl] Ignoring unknown action: %s", action)
            return None
        if action in {"", "continue", "none", "noop"}:
            return None

        raw_steps = decision_json.get("steps")
        if not isinstance(raw_steps, list):
            raw_steps = []

        if action == "select_skill" and not raw_steps:
            skill_name = str(decision_json.get("skill_name") or "").strip()
            if skill_name:
                target_intents = [
                    str(intent).strip()
                    for intent in (decision_json.get("target_intents") or [])
                    if str(intent).strip()
                ] or list(completed_step.target_intents or []) or [completed_step.goal]
                raw_steps = [
                    {
                        "step_type": "skill",
                        "skill_name": skill_name,
                        "goal": str(decision_json.get("goal") or "").strip()
                        or f"继续处理：{'；'.join(target_intents)}",
                        "target_intents": target_intents,
                        "instructions": (
                            str(decision_json.get("instructions") or "").strip()
                            or f"仅处理当前新增子问题：{'；'.join(target_intents)}。遵循 {skill_name} 能力边界执行。"
                            "当前步骤仅输出中间结果，不输出最终回答。"
                        ),
                        "done_when": str(decision_json.get("done_when") or "").strip()
                        or "产出结构化交接结果。",
                    }
                ]

        inserted_steps: List[ExecutionStep] = []
        for index, item in enumerate(raw_steps):
            dynamic_step = self.build_dynamic_step_from_adjustment(
                state=state,
                completed_step=completed_step,
                message=message,
                all_tools=all_tools,
                item=item,
                item_index=index,
            )
            if dynamic_step:
                inserted_steps.append(dynamic_step)

        next_step_index = decision_json.get("next_step_index")
        try:
            next_step_index = int(next_step_index) if next_step_index is not None else None
        except (TypeError, ValueError):
            next_step_index = None

        replace_remaining_raw = decision_json.get("replace_remaining")
        if replace_remaining_raw is None:
            replace_remaining = action in {"replan", "finish"}
        elif isinstance(replace_remaining_raw, bool):
            replace_remaining = replace_remaining_raw
        elif isinstance(replace_remaining_raw, str):
            replace_remaining = replace_remaining_raw.strip().lower() in {"1", "true", "yes", "y"}
        else:
            replace_remaining = bool(replace_remaining_raw)

        if action == "finish":
            return PlanAdjustment(
                inserted_steps=[],
                replace_remaining=True,
                next_step_index=next_step_index,
                reason=str(decision_json.get("reason") or "agent control chose finish").strip(),
                action="finish",
                source="agent_control",
            )

        if not inserted_steps and not replace_remaining and next_step_index is None:
            return None

        return PlanAdjustment(
            inserted_steps=inserted_steps,
            replace_remaining=replace_remaining,
            next_step_index=next_step_index,
            reason=str(decision_json.get("reason") or f"agent control chose {action}").strip(),
            action=action,
            source="agent_control",
        )

    async def decide(self, request: AgentControlRequest) -> Optional[PlanAdjustment]:
        remaining_steps = request.state.remaining_runtime_steps(request.state.current_step_index + 1)
        decision_signals = self._build_controller_decision_signals(
            request=request,
            remaining_steps=remaining_steps,
        )

        # Short-circuit: when deterministic signals point to a completed answer
        # with no conflicting conditions, skip the controller LLM call.
        if (
            (
                decision_signals["recommended_action"] == "finish"
                or decision_signals["single_step_optional_followup_answered"]
                or decision_signals["single_step_final_answered"]
            )
            and not decision_signals["should_force_final_synthesis"]
            and not decision_signals["has_unfinished_subtasks"]
            and decision_signals["remaining_non_final_step_count"] == 0
            and decision_signals["step_success"]
            and not decision_signals["output_looks_intermediate_structured"]
            and (
                decision_signals["current_step_is_final_like"]
                or decision_signals["single_step_optional_followup_answered"]
                or decision_signals["single_step_final_answered"]
            )
        ):
            logger.info("[AgentControl] Deterministic finish, skipping controller LLM call")
            self.services.record_observability_span(
                turn_id=request.state.current_turn_id,
                conversation_id=request.state.conversation_id,
                user_id=request.state.user_id,
                span_type="llm",
                phase="control",
                name="agent_control",
                status="skipped",
                loop_index=request.state.current_step_index + 1,
                duration_ms=0,
                skill_name=request.completed_step.skill_name,
                metadata={
                    "action": "finish",
                    "raw_action": "finish",
                    "completed_step_id": request.completed_step.step_id,
                    "adjusted": False,
                    "short_circuit": True,
                },
            )
            return None

        prompt = self.build_prompt(request, decision_signals=decision_signals)

        llm_started_at = time.perf_counter()
        control_ai_service = self._get_control_ai_service()
        chat_kwargs = self._build_control_chat_kwargs(control_ai_service)
        try:
            response = await control_ai_service.chat(
                [
                    {"role": "system", "content": render_prompt("runtime/agent_controller_system.md")},
                    {"role": "user", "content": prompt},
                ],
                **chat_kwargs,
            )
            llm_duration_ms = (time.perf_counter() - llm_started_at) * 1000
            content = response.get("content", "") if isinstance(response, dict) else str(response)
            parsed = parse_json_object(content)
            raw_action = str(parsed.get("action") or "continue").strip().lower()
            adjustment = self.convert_decision_json_to_plan_adjustment(
                state=request.state,
                completed_step=request.completed_step,
                message=request.message,
                all_tools=request.all_tools,
                decision_json=parsed,
            )
            adjustment = self._normalize_adjustment_against_signals(
                request=request,
                adjustment=adjustment,
                decision_signals=decision_signals,
            )
            prompt_tokens, completion_tokens, total_tokens = self.services.extract_usage_metrics(response)
            self.services.record_observability_span(
                turn_id=request.state.current_turn_id,
                conversation_id=request.state.conversation_id,
                user_id=request.state.user_id,
                span_type="llm",
                phase="control",
                name="agent_control",
                status="success",
                loop_index=request.state.current_step_index + 1,
                duration_ms=llm_duration_ms,
                model_used=response.get("model_used") if isinstance(response, dict) else None,
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                total_tokens=total_tokens,
                skill_name=request.completed_step.skill_name,
                metadata={
                    "action": adjustment.action if adjustment else raw_action,
                    "raw_action": raw_action,
                    "completed_step_id": request.completed_step.step_id,
                    "adjusted": bool(adjustment),
                    "finish_guard_applied": bool(adjustment and adjustment.action == "replan" and raw_action == "finish"),
                },
            )
            return adjustment
        except Exception as exc:
            logger.warning("[AgentControl] Failed to decide plan adjustment: %s", exc)
            self.services.record_observability_span(
                turn_id=request.state.current_turn_id,
                conversation_id=request.state.conversation_id,
                user_id=request.state.user_id,
                span_type="llm",
                phase="control",
                name="agent_control",
                status="failed",
                loop_index=request.state.current_step_index + 1,
                duration_ms=(time.perf_counter() - llm_started_at) * 1000,
                skill_name=request.completed_step.skill_name,
                metadata={
                    "completed_step_id": request.completed_step.step_id,
                    "error": str(exc),
                },
            )
            return None

    async def bootstrap(
        self,
        *,
        message: str,
        all_skill_packages: List[SkillPackage],
        all_tools: List[Dict],
        active_skill_name: Optional[str] = None,
        skill_recommendation_candidates: Optional[List[Dict[str, Any]]] = None,
        conversation_state: Optional[ConversationRuntimeState] = None,
        durable_memory_context: Optional[Any] = None,
        current_turn_id: Optional[str] = None,
        conversation_id: Optional[str] = None,
        user_id: Optional[str] = None,
    ) -> RuntimeBootstrapResult:
        normalized_active_skill = str(active_skill_name or "").strip()
        if normalized_active_skill:
            return self._manual_active_skill_bootstrap_plan(
                message=message,
                all_skill_packages=all_skill_packages,
                all_tools=all_tools,
                active_skill_name=normalized_active_skill,
                skill_recommendation_candidates=skill_recommendation_candidates or [],
                conversation_state=conversation_state,
                durable_memory_context=durable_memory_context,
                current_turn_id=current_turn_id,
                conversation_id=conversation_id,
            )

        if not getattr(self.services, "ai_service", None):
            return self._fallback_bootstrap_plan(
                message=message,
                all_skill_packages=all_skill_packages,
                all_tools=all_tools,
                active_skill_name=active_skill_name or (
                    conversation_state.last_active_skill_name if conversation_state else None
                ),
            )

        prompt = self.build_initial_prompt(
            message=message,
            all_skill_packages=all_skill_packages,
            all_tools=all_tools,
            active_skill_name=active_skill_name,
            conversation_state=conversation_state,
            durable_memory_context=durable_memory_context,
        )
        llm_started_at = time.perf_counter()
        control_ai_service = self._get_control_ai_service()
        chat_kwargs = self._build_control_chat_kwargs(control_ai_service)
        try:
            response = await control_ai_service.chat(
                [
                    {"role": "system", "content": render_prompt("runtime/bootstrap_controller_system.md")},
                    {"role": "user", "content": prompt},
                ],
                **chat_kwargs,
            )
            llm_duration_ms = (time.perf_counter() - llm_started_at) * 1000
            content = response.get("content", "") if isinstance(response, dict) else str(response)
            parsed = parse_json_object(content)
            raw_steps = parsed.get("steps")
            if not isinstance(raw_steps, list) or not raw_steps:
                raise ValueError("empty bootstrap steps")

            skill_map = {pkg.name: pkg for pkg in all_skill_packages}
            state = ExecutionState(
                conversation_id=conversation_id or "bootstrap",
                current_turn_id=current_turn_id,
                plan=ExecutionPlan(
                    user_goal=message,
                    routing_reason=str(parsed.get("reason") or "runtime bootstrap").strip(),
                    routing_method="runtime_bootstrap",
                    steps=[],
                    multi_skill_mode=False,
                ),
                available_skill_packages=skill_map,
                durable_memory_context=durable_memory_context,
                shared_memory=dict((conversation_state.shared_memory or {}) if conversation_state else {}),
                open_goals=list((conversation_state.open_goals or []) if conversation_state else []),
                pending_user_input=(
                    dict(conversation_state.pending_user_input)
                    if conversation_state and conversation_state.pending_user_input
                    else None
                ),
                last_active_skill_name=(
                    conversation_state.last_active_skill_name
                    if conversation_state
                    else None
                ),
            )
            anchor = ExecutionStep(
                step_id="request_root",
                skill_name="runtime_entry",
                goal=message,
                instructions="runtime bootstrap",
                step_type="general",
            )
            built_steps: List[ExecutionStep] = []
            for index, item in enumerate(raw_steps):
                step = self.build_dynamic_step_from_adjustment(
                    state=state,
                    completed_step=anchor if index == 0 else built_steps[-1],
                    message=message,
                    all_tools=all_tools,
                    item=item,
                    item_index=index,
                )
                if not step:
                    continue
                step.step_id = str(item.get("step_id") or "").strip() or f"s{index + 1}"
                step.depends_on = [] if index == 0 else [built_steps[-1].step_id]
                step.is_final_step = False
                built_steps.append(step)
                state.set_runtime_steps(list(built_steps))
                break

            if not built_steps:
                raise ValueError("bootstrap planner produced no valid steps")

            intents: List[str] = []
            for step in built_steps:
                for intent in step.target_intents or [step.goal]:
                    normalized = str(intent).strip()
                    if normalized and normalized not in intents:
                        intents.append(normalized)
            # Bootstrap always outputs exactly 1 step. Only append synthesis
            # when the agent_controller later inserts additional steps via
            # decide(); for a single bootstrap step, synthesis is redundant
            # because that step IS the final step.
            if len(built_steps) > 1:
                built_steps = self.services.planning_policy.append_final_synthesis_step_if_needed(
                    built_steps,
                    intents or [message],
                )
            for idx, step in enumerate(built_steps):
                step.is_final_step = idx == len(built_steps) - 1
                if idx > 0 and not step.depends_on:
                    step.depends_on = [built_steps[idx - 1].step_id]

            prompt_tokens, completion_tokens, total_tokens = self.services.extract_usage_metrics(response)
            plan = ExecutionPlan(
                user_goal=message,
                routing_reason=str(parsed.get("reason") or "runtime bootstrap").strip(),
                routing_method="runtime_bootstrap",
                steps=built_steps,
                multi_skill_mode=len(built_steps) > 1,
                planner_metrics={
                    # bootstrap 合并了路由+规划，tokens 已经在下面的 bootstrap span 记过了，
                    # 这里保留 metadata 但不让 agent_service 再记 phase="plan" span
                    "already_recorded_in_bootstrap": True,
                    "llm_calls": 1,
                    "llm_duration_ms": llm_duration_ms,
                    "model_used": response.get("model_used") if isinstance(response, dict) else None,
                    "prompt_tokens": prompt_tokens,
                    "completion_tokens": completion_tokens,
                    "total_tokens": total_tokens,
                },
            )
            routing_result = self._build_bootstrap_routing_result(
                all_skill_packages=all_skill_packages,
                execution_plan=plan,
                reason=plan.routing_reason,
                active_skill_name=active_skill_name,
            )
            # bootstrap 合并了 routing + plan 到同一次 LLM 调用，并在下面记了一个
            # phase="bootstrap" 的 span。为避免重复记账，不把 tokens/llm_calls
            # 回填到 routing_result —— 否则 _record_routing_span 和 planner span
            # 会再各记一条同样数据的 span，造成 overview 指标虚报三倍。
            routing_result.llm_calls = 0
            routing_result.llm_duration_ms = llm_duration_ms
            routing_result.llm_model_used = response.get("model_used") if isinstance(response, dict) else None
            routing_result.llm_usage = None
            self.services.record_observability_span(
                turn_id=current_turn_id,
                conversation_id=conversation_id,
                user_id=user_id,
                span_type="llm",
                phase="bootstrap",
                name="runtime_bootstrap",
                status="success",
                loop_index=0,
                duration_ms=llm_duration_ms,
                model_used=response.get("model_used") if isinstance(response, dict) else None,
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                total_tokens=total_tokens,
                skill_name=routing_result.skill_name,
                metadata={
                    "steps_count": len(built_steps),
                    "reason": plan.routing_reason,
                },
            )
            return RuntimeBootstrapResult(routing_result=routing_result, execution_plan=plan)
        except Exception as exc:
            logger.warning("[AgentBootstrap] Failed to bootstrap initial plan: %s", exc)
            self.services.record_observability_span(
                turn_id=current_turn_id,
                conversation_id=conversation_id,
                user_id=user_id,
                span_type="llm",
                phase="bootstrap",
                name="runtime_bootstrap",
                status="failed",
                loop_index=0,
                duration_ms=(time.perf_counter() - llm_started_at) * 1000,
                metadata={"error": str(exc)},
            )
            return self._fallback_bootstrap_plan(
                message=message,
                all_skill_packages=all_skill_packages,
                all_tools=all_tools,
                active_skill_name=active_skill_name,
            )

    def adjust_from_step_output(
        self,
        *,
        state: ExecutionState,
        completed_step: ExecutionStep,
        step_result: StepResult,
        message: str,
        all_tools: List[Dict],
    ) -> Optional[PlanAdjustment]:
        raw_adjustment = step_result.output.get("plan_adjustment")
        if not isinstance(raw_adjustment, dict):
            return None

        raw_steps = raw_adjustment.get("steps")
        if not isinstance(raw_steps, list):
            raw_steps = [raw_adjustment]

        inserted_steps: List[ExecutionStep] = []
        for index, item in enumerate(raw_steps):
            dynamic_step = self.build_dynamic_step_from_adjustment(
                state=state,
                completed_step=completed_step,
                message=message,
                all_tools=all_tools,
                item=item,
                item_index=index,
            )
            if dynamic_step:
                if dynamic_step.step_type == "skill" and not dynamic_step.allowed_tool_names:
                    selected_skill = state.available_skill_packages.get(dynamic_step.skill_name)
                    if selected_skill:
                        dynamic_step.allowed_tool_names = list(selected_skill.allowed_tools or [])
                inserted_steps.append(dynamic_step)

        if not inserted_steps:
            return None

        return PlanAdjustment(
            inserted_steps=inserted_steps,
            replace_remaining=bool(raw_adjustment.get("replace_remaining", False)),
            next_step_index=raw_adjustment.get("next_step_index"),
            reason=str(raw_adjustment.get("reason") or "step requested plan adjustment").strip(),
            action="replan",
            source="step_output",
        )
