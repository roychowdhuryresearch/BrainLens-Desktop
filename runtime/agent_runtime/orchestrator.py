import asyncio
import json
import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, AsyncGenerator, Dict, List, Mapping, Optional

logger = logging.getLogger(__name__)

_PUBLIC_TURN_ERROR_MESSAGE = "The agent could not complete this request. Please try again."

_TRUSTED_ACTION_RECEIPT_TOOLS = {"emit_ui_command", "wait_for_ui_command"}
def _sanitize_public_event(event: Dict[str, Any]) -> Dict[str, Any]:
    """Prevent provider/runtime exception details from crossing the wire."""
    if isinstance(event, dict) and event.get("event") == "error":
        return {"event": "error", "data": {"message": _PUBLIC_TURN_ERROR_MESSAGE}}
    return event

from runtime.agent_runtime import post_turn
from runtime.agent_runtime.action_receipts import (
    REVIEW_ACK_TRANSPORT_VERSION,
    bind_terminal_review_receipt_scope,
    canonical_action_receipt,
)
from runtime.agent_runtime.clinical_evidence import recording_fingerprint_for_path
from runtime.agent_runtime.conversation_state import ConversationRuntimeState
from runtime.agent_runtime.planning_policy import RuntimePlanningPolicy
from runtime.agent_runtime.research_evidence_ledger import (
    CANONICAL_UI_EVIDENCE_PROVIDER,
    trusted_research_evidence_entries,
)
from runtime.agent_runtime.runtime_port_protocol import AgentRuntimePort
from runtime.context.models import ContextPack
from runtime.skills.models import ExecutionPlan, ExecutionState, ExecutionStep, RoutingResult, SkillPackage


@dataclass
class AgentTurnRequest:
    message: str
    request_id: Optional[str] = None
    conversation_id: Optional[str] = None
    knowledge_base_id: Optional[str] = None
    active_skill_name: Optional[str] = None
    user_id: Optional[str] = None
    user_role: Optional[str] = None
    skill_environment: Optional[str] = None
    user_context: Optional[Any] = None
    skill_packages_override: Optional[List[SkillPackage]] = None
    allowed_skill_names: Optional[List[str]] = None
    skill_recommendation_candidates: List[Dict[str, Any]] = field(default_factory=list)
    conversation_state: Optional[ConversationRuntimeState] = None
    current_turn_id: Optional[str] = None
    runtime_turn_count: int = 0
    durable_memory_context: Optional[Any] = None
    response_tone: Optional[Dict[str, Any]] = None
    response_mode: str = "default"
    response_language: Optional[str] = None
    recording_path: Optional[str] = None  # the EDF the desktop currently has loaded (default input_path)
    # The desktop's PyHFO session for this turn. Carried on the request because this process starts
    # before the backend exists and so cannot inherit the session from its environment.
    session_url: Optional[str] = None
    session_token: Optional[str] = None
    state_revision: Optional[str] = None


@dataclass
class PlanAdjustment:
    inserted_steps: List[ExecutionStep] = field(default_factory=list)
    replace_remaining: bool = False
    next_step_index: Optional[int] = None
    reason: str = ""
    action: str = "adjust_plan"
    source: str = "step_output"


@dataclass
class RuntimeBootstrapResult:
    routing_result: RoutingResult
    execution_plan: ExecutionPlan


@dataclass
class RuntimeFinalizationResult:
    final_content: str
    sources: List[Dict[str, Any]] = field(default_factory=list)
    verification_event: Optional[Dict[str, Any]] = None
    plan_adjustment: Optional[PlanAdjustment] = None


class AgentOrchestrator:
    """Headless agent turn runner.

    The orchestrator owns the request lifecycle and ReAct step sequencing,
    while the injected `port` provides application-shell concerns such as MCP,
    persistence, logging, and post-processing hooks.
    """

    def __init__(self, port: AgentRuntimePort):
        self.port = port

    @staticmethod
    def _event_signature(event: Dict[str, Any]) -> str:
        event_type = str(event.get("event") or "")
        data = event.get("data")
        try:
            payload = json.dumps(data, sort_keys=True, ensure_ascii=False, default=str)
        except TypeError:
            payload = repr(data)
        return f"{event_type}:{payload}"

    @staticmethod
    def _canonical_action_receipt(value: Any) -> Optional[Dict[str, Any]]:
        return canonical_action_receipt(value)

    @staticmethod
    def _is_terminal_review_receipt(value: Any) -> bool:
        return bool(
            isinstance(value, Mapping)
            and value.get("contract_version")
            in {"ieeg-agent.v1", REVIEW_ACK_TRANSPORT_VERSION}
            and value.get("effect") == "review_write"
            and value.get("terminal") is True
            and str(value.get("receipt_id") or "").strip()
            and str(value.get("command_id") or "").strip()
            and str(value.get("command_type") or "").strip()
        )

    @staticmethod
    def _active_review_scope(state: ExecutionState) -> Optional[Dict[str, str]]:
        scope = {
            "request_id": str(state.request_id or "").strip(),
            "message_id": str(state.message_id or "").strip(),
            "conversation_id": str(state.conversation_id or "").strip(),
            "state_revision": str(state.state_revision or "").strip(),
        }
        if any(not value for value in scope.values()):
            return None
        fingerprint = recording_fingerprint_for_path(state.recording_path, fresh=True)
        if not fingerprint:
            return None
        return {"recording_fingerprint": fingerprint, **scope}

    @classmethod
    def _receipt_for_active_state(
        cls,
        *,
        state: ExecutionState,
        receipt: Mapping[str, Any],
        active_scope: Optional[Mapping[str, str]] = None,
    ) -> Optional[Dict[str, Any]]:
        if not cls._is_terminal_review_receipt(receipt):
            return cls._canonical_action_receipt(receipt)

        from runtime.agent_runtime import ui_command_context

        scope = dict(active_scope or cls._active_review_scope(state) or {})
        issued_scope = ui_command_context.authority_scope_for_command(
            str(receipt.get("command_id") or "")
        )
        provenance = receipt.get("provenance")
        if (
            not scope
            or not issued_scope
            or any(issued_scope.get(field) != value for field, value in scope.items())
            or issued_scope.get("command_type") != receipt.get("command_type")
            or not isinstance(provenance, Mapping)
            or issued_scope.get("payload_sha256") != provenance.get("payload_sha256")
        ):
            return None
        return bind_terminal_review_receipt_scope(
            receipt,
            recording_fingerprint=scope["recording_fingerprint"],
            request_id=scope["request_id"],
            message_id=scope["message_id"],
            conversation_id=scope["conversation_id"],
            state_revision=scope["state_revision"],
        )

    @classmethod
    def _iter_action_receipts(cls, value: Any, *, depth: int = 0):
        if depth > 6:
            return
        receipt = cls._canonical_action_receipt(value)
        if receipt is not None:
            yield receipt
            return
        # A broker transport ACK may not yet contain trusted runtime-only scope.
        # Yield only a terminal review-shaped candidate; promotion still requires
        # full structural validation plus a fresh command issuance binding.
        if cls._is_terminal_review_receipt(value):
            yield dict(value)
            return
        if isinstance(value, Mapping):
            for nested in value.values():
                yield from cls._iter_action_receipts(nested, depth=depth + 1)
        elif isinstance(value, list):
            for nested in value:
                yield from cls._iter_action_receipts(nested, depth=depth + 1)

    @classmethod
    def _capture_trusted_action_receipts(
        cls,
        *,
        state: ExecutionState,
        events: List[Dict[str, Any]],
    ) -> None:
        """Capture receipts only from successful ieeg_ui tool-result events."""

        active_scope: Optional[Dict[str, str]] = None
        indexed: Dict[str, Dict[str, Any]] = {}
        for raw_receipt in state.action_receipts:
            if cls._is_terminal_review_receipt(raw_receipt) and active_scope is None:
                active_scope = cls._active_review_scope(state)
            receipt = cls._receipt_for_active_state(
                state=state,
                receipt=raw_receipt,
                active_scope=active_scope,
            )
            if receipt is not None:
                indexed[str(receipt.get("receipt_id"))] = receipt
        for event in events:
            if not isinstance(event, Mapping) or event.get("event") != "tool_result":
                continue
            data = event.get("data")
            if not isinstance(data, Mapping) or data.get("success") is not True:
                continue
            name = str(data.get("name") or "").strip()
            if name not in _TRUSTED_ACTION_RECEIPT_TOOLS:
                continue
            if str(data.get("provider_name") or "").strip() != CANONICAL_UI_EVIDENCE_PROVIDER:
                continue
            for raw_receipt in cls._iter_action_receipts(data.get("result")):
                if cls._is_terminal_review_receipt(raw_receipt) and active_scope is None:
                    active_scope = cls._active_review_scope(state)
                receipt = cls._receipt_for_active_state(
                    state=state,
                    receipt=raw_receipt,
                    active_scope=active_scope,
                )
                if receipt is None:
                    continue
                receipt_id = str(receipt["receipt_id"])
                previous = indexed.get(receipt_id)
                if previous is None or (
                    bool(receipt.get("terminal")), int(receipt.get("transition_count") or 0)
                ) >= (
                    bool(previous.get("terminal")), int(previous.get("transition_count") or 0)
                ):
                    indexed[receipt_id] = receipt
        state.action_receipts[:] = list(indexed.values())[-128:]

    @classmethod
    def _revalidate_trusted_action_receipts(cls, *, state: ExecutionState) -> None:
        """Drop receipts whose recording/turn binding changed after capture."""

        active_scope = cls._active_review_scope(state)
        revalidated: List[Dict[str, Any]] = []
        for raw_receipt in state.action_receipts:
            receipt = cls._receipt_for_active_state(
                state=state,
                receipt=raw_receipt,
                active_scope=active_scope,
            )
            if receipt is not None:
                revalidated.append(receipt)
        state.action_receipts[:] = revalidated[-128:]

    @classmethod
    def _terminal_review_receipt_seal(
        cls,
        *,
        state: ExecutionState,
    ) -> tuple[tuple[str, str], ...]:
        return tuple(
            sorted(
                (
                    str(receipt.get("receipt_id") or ""),
                    str(receipt.get("scope_sha256") or ""),
                )
                for receipt in state.action_receipts
                if cls._is_terminal_review_receipt(receipt)
            )
        )

    @classmethod
    def _capture_trusted_research_evidence(
        cls,
        *,
        state: ExecutionState,
        events: List[Dict[str, Any]],
    ) -> None:
        """Retain full results only for exact built-in evidence-producing tools.

        Tool names are an authority boundary.  Suffix matching would let an
        unrelated MCP such as ``evil__wait_for_ui_command`` inject receipts or
        scientific evidence into the final clinical validator.
        """

        state.research_evidence_ledger.extend(
            trusted_research_evidence_entries(state=state, events=events)
        )
        state.research_evidence_ledger[:] = state.research_evidence_ledger[-128:]

    @staticmethod
    def _is_actionable_plan_adjustment(adjustment: Optional[PlanAdjustment]) -> bool:
        return bool(
            adjustment
            and (
                adjustment.inserted_steps
                or adjustment.replace_remaining
                or adjustment.next_step_index is not None
            )
        )

    @staticmethod
    def _serialize_step(step: ExecutionStep) -> Dict[str, Any]:
        return {
            "step_id": step.step_id,
            "skill_name": step.skill_name,
            "step_type": step.step_type,
            "goal": step.goal,
            "target_intents": step.target_intents,
            "is_final_step": step.is_final_step,
        }

    @staticmethod
    def _dedup_non_empty(values: List[str]) -> List[str]:
        deduped: List[str] = []
        seen = set()
        for value in values:
            normalized = str(value or "").strip()
            if not normalized or normalized in seen:
                continue
            seen.add(normalized)
            deduped.append(normalized)
        return deduped

    @classmethod
    def _derive_open_goals(
        cls,
        *,
        state: ExecutionState,
        next_step_index: int,
        user_message: str,
        pending_user_input: Optional[Dict[str, Any]] = None,
        final_content: str = "",
    ) -> List[str]:
        if final_content.strip() and next_step_index >= state.total_runtime_steps():
            return []

        goals = [
            step.goal
            for step in state.remaining_runtime_steps(next_step_index)
            if step.step_type != "synthesis"
        ]
        if pending_user_input:
            prompt = str(pending_user_input.get("prompt") or "").strip()
            if prompt:
                goals.insert(0, prompt)
        if not goals and not final_content.strip() and user_message.strip():
            goals.append(user_message.strip())
        return cls._dedup_non_empty(goals)

    @classmethod
    def _serialize_active_plan_steps(
        cls,
        *,
        state: ExecutionState,
        next_step_index: int,
    ) -> List[Dict[str, Any]]:
        return state.serialize_pending_runtime_actions(next_step_index)

    @staticmethod
    def _trim_shared_memory(shared_memory: Dict[str, Any], limit: int = 8) -> Dict[str, Any]:
        if not shared_memory:
            return {}
        items = list(shared_memory.items())[-limit:]
        return {str(key): value for key, value in items}

    @staticmethod
    def _should_skip_post_step_replanning(
        *,
        state: ExecutionState,
        completed_step: ExecutionStep,
        step_result,
    ) -> bool:
        if not step_result.success or step_result.output.get("waiting_for_input"):
            return False
        # Fast-path plans always skip replanning
        if RuntimePlanningPolicy.is_fast_path_plan(getattr(state, "plan", None)):
            return True
        # agent_control 调多了会陷入"再加一步、再加一步"的死循环。观测到的 case：
        # general_assistant 已经在 is_final_step 上成功输出 2700 字答案，agent_control
        # 仍判 has_unfinished_subtasks=true，然后从 available_skills 里硬塞一个不相关
        # 的 skill（如 document-retrieval），浪费 60-120s LLM 时间。
        # 硬上限：单 turn 内 agent_control 最多介入 2 次；再多就信任已有 step。
        # 注意：早先实现用 total_runtime_steps() vs len(plan.steps) 的差做 proxy，
        # 但一次 replace_remaining=True 带 ≥3 步插入就能把 delta 拉到 >2，把合法的
        # 大改写误判成循环介入，所以改为显式计数 PlanAdjustment.source == agent_control。
        if getattr(state, "agent_control_interventions", 0) > 2:
            return True
        return False

    @staticmethod
    def _is_manual_active_skill_turn(request: AgentTurnRequest) -> bool:
        return bool(str(request.active_skill_name or "").strip())

    async def _save_conversation_runtime_state(
        self,
        *,
        request: AgentTurnRequest,
        state: ExecutionState,
        next_step_index: int,
        final_content: str = "",
        pending_user_input: Optional[Dict[str, Any]] = None,
    ) -> None:
        saver = getattr(self.port, "save_conversation_runtime_state", None)
        if not callable(saver):
            return

        previous = request.conversation_state or ConversationRuntimeState(conversation_id=state.conversation_id)
        if request.runtime_turn_count <= 0:
            request.runtime_turn_count = max(int(previous.turn_count or 0) + 1, 1)
        runtime_state = ConversationRuntimeState(
            conversation_id=state.conversation_id,
            turn_count=request.runtime_turn_count,
            last_user_goal=request.message,
            last_final_answer=final_content.strip(),
            open_goals=self._derive_open_goals(
                state=state,
                next_step_index=next_step_index,
                user_message=request.message,
                pending_user_input=pending_user_input,
                final_content=final_content,
            ),
            shared_memory=self._trim_shared_memory(state.shared_memory),
            pending_actions=self._serialize_active_plan_steps(
                state=state,
                next_step_index=next_step_index,
            ),
            active_plan_steps=self._serialize_active_plan_steps(
                state=state,
                next_step_index=next_step_index,
            ),
            pending_user_input=pending_user_input,
            last_active_skill_name=state.last_active_skill_name,
            skills_executed=self._dedup_non_empty(state.skills_executed),
        )
        state.open_goals = list(runtime_state.open_goals)
        state.pending_user_input = runtime_state.pending_user_input
        await saver(
            conversation_id=state.conversation_id,
            runtime_state=runtime_state,
        )
        request.conversation_state = runtime_state

    def _apply_plan_adjustment(
        self,
        *,
        state: ExecutionState,
        step_index: int,
        adjustment: PlanAdjustment,
    ) -> int:
        insertion_index = step_index + 1
        if adjustment.source == "agent_control":
            state.agent_control_interventions += 1
        state.apply_runtime_plan_adjustment(
            step_index=step_index,
            inserted_steps=adjustment.inserted_steps,
            replace_remaining=adjustment.replace_remaining,
        )

        next_step_index = adjustment.next_step_index
        if next_step_index is None:
            return insertion_index
        # Never move execution backward to re-run an already-completed step. The
        # LLM/skill-supplied next_step_index is untrusted: a value <= step_index
        # (even 0) combined with inserted_steps used to be honored verbatim,
        # re-triggering non-idempotent tool calls (re-detect / re-classify) and —
        # together with the replanning channel — looping until the hard iteration
        # cap. The only valid continuation is the step right after the
        # just-completed one (where inserts/replacements land) or further ahead.
        try:
            target = int(next_step_index)
        except (TypeError, ValueError):
            return insertion_index
        return min(max(target, insertion_index), state.total_runtime_steps())

    async def stream(self, request: AgentTurnRequest) -> AsyncGenerator[Dict, None]:
        conv_id = str(request.conversation_id or "").strip() or f"conv_ephemeral_{uuid.uuid4().hex}"
        request.conversation_id = conv_id
        request.request_id = str(request.request_id or "").strip() or f"req_{uuid.uuid4().hex}"
        request_start_time = datetime.now()
        self.port.clear_cancel_flag(conv_id)
        self.port.refresh_postprocess_services()
        manual_active_skill_turn = self._is_manual_active_skill_turn(request)

        yield {"event": "status", "data": {"message": "正在连接..."}}

        current_turn_id = await self.port.init_conversation_and_turn(
            conversation_id=conv_id,
            message=request.message,
            active_skill_name=request.active_skill_name,
            user_id=request.user_id,
        )
        request.current_turn_id = current_turn_id
        response_message_id = f"msg_{uuid.uuid4().hex}"
        self.port.on_request_started(
            conversation_id=conv_id,
            message=request.message,
            active_skill_name=request.active_skill_name,
        )

        yield {"event": "status", "data": {"message": "正在处理您的请求..."}}

        routing_result: Optional[RoutingResult] = None
        execution_plan: Optional[ExecutionPlan] = None
        total_iterations = 0
        model_used = "unknown"
        tokens_used: Optional[int] = None
        durable_success_committed = False
        terminal_done_emitted = False

        try:
            yield {"event": "status", "data": {"message": "正在整理上下文..."}}

            # 上一轮的 save_runtime_state 已经 schedule 到后台。这里读 state 前必须
            # 先等它落盘，否则新 turn 的 bootstrap 会读到上上一轮的 state（pending
            # input 没清、open goals 还挂在上面）。3s 超时是兜底：DB 写通常 <50ms，
            # 超过 3s 基本是进程卡死，此时读旧 state 也没用了。
            await post_turn.wait_for_conversation(conv_id, timeout=3.0)

            # Parallelize independent I/O: history, tools, skills, state
            async def _load_state():
                loader = getattr(self.port, "load_conversation_runtime_state", None)
                return await loader(conv_id) if callable(loader) else None

            history, all_tools, all_skill_packages, conv_state = await asyncio.gather(
                self.port.load_history_for_request(conv_id),
                self.port.resolve_tools_for_request(
                    message=request.message,
                    user_context=request.user_context,
                ),
                self.port.resolve_skill_packages_for_request(request),
                _load_state(),
            )
            if conv_state is not None:
                request.conversation_state = conv_state
                request.runtime_turn_count = max(int(conv_state.turn_count or 0) + 1, 1)

            # Start context_pack preparation early -- it only depends on
            # history (already resolved) and runs in parallel with bootstrap.
            context_pack_coro = self.port.prepare_context_pack_for_request(
                conversation_id=conv_id,
                history=history,
                message=request.message,
                skill_context=None,
                current_turn_id=current_turn_id,
                user_id=request.user_id,
            )

            # Bootstrap: try fast-path first, fall back to full LLM bootstrap.
            bootstrap_result: Optional[RuntimeBootstrapResult] = None
            maybe_fast_path_bootstrap = getattr(self.port, "maybe_build_fast_path_bootstrap", None)
            if callable(maybe_fast_path_bootstrap):
                bootstrap_result = await maybe_fast_path_bootstrap(
                    request=request,
                    all_skill_packages=all_skill_packages,
                    all_tools=all_tools,
                )

            if bootstrap_result is None:
                bootstrap_turn = getattr(self.port, "bootstrap_runtime_turn", None)
                if not callable(bootstrap_turn):
                    raise AttributeError("runtime port must implement bootstrap_runtime_turn")
                # Run bootstrap LLM call and context_pack in parallel
                bootstrap_result, context_pack = await asyncio.gather(
                    bootstrap_turn(
                        request=request,
                        all_skill_packages=all_skill_packages,
                        all_tools=all_tools,
                    ),
                    context_pack_coro,
                )
            else:
                # Fast-path resolved synchronously; await the context_pack coroutine
                context_pack = await context_pack_coro

            routing_result = bootstrap_result.routing_result
            execution_plan = bootstrap_result.execution_plan
            self.port.on_routing_resolved(
                current_turn_id=current_turn_id,
                conversation_id=conv_id,
                user_id=request.user_id,
                message=request.message,
                all_skill_packages=all_skill_packages,
                routing_result=routing_result,
            )
            self.port.on_plan_created(
                current_turn_id=current_turn_id,
                conversation_id=conv_id,
                user_id=request.user_id,
                execution_plan=execution_plan,
            )

            plan_steps_data = [
                {
                    "step_id": step.step_id,
                    "skill_name": step.skill_name,
                    "step_type": step.step_type,
                    "goal": step.goal,
                    "target_intents": step.target_intents,
                    "is_final_step": step.is_final_step,
                }
                for step in execution_plan.steps
            ]
            yield {
                "event": "plan_created",
                "data": {
                    "multi_skill_mode": execution_plan.multi_skill_mode,
                    "steps": plan_steps_data,
                },
            }

            state = ExecutionState(
                conversation_id=conv_id,
                current_turn_id=current_turn_id,
                plan=execution_plan,
                request_id=request.request_id,
                message_id=response_message_id,
                state_revision=request.state_revision,
                user_id=request.user_id,
                user_role=request.user_role,
                available_skill_packages={pkg.name: pkg for pkg in all_skill_packages},
                durable_memory_context=request.durable_memory_context,
                response_tone=dict(request.response_tone or {}),
                response_mode=request.response_mode or "default",
                response_language=request.response_language,
                recording_path=request.recording_path,
                shared_memory=dict((request.conversation_state.shared_memory or {}) if request.conversation_state else {}),
                open_goals=list((request.conversation_state.open_goals or []) if request.conversation_state else []),
                pending_user_input=(
                    dict(request.conversation_state.pending_user_input)
                    if request.conversation_state and request.conversation_state.pending_user_input
                    else None
                ),
                last_active_skill_name=(
                    request.conversation_state.last_active_skill_name
                    if request.conversation_state
                    else None
                ),
            )

            # Co-pilot: bind only the command accumulator. UI state itself is read through the
            # ieeg_ui MCP get_ui_state tool from the broker.
            from runtime.agent_runtime import ui_command_context
            ui_command_context.begin_ui_turn(
                state.ui_commands,
                authority_scope={
                    "request_id": state.request_id,
                    "message_id": state.message_id,
                    "conversation_id": state.conversation_id,
                    "state_revision": state.state_revision,
                    "recording_path": state.recording_path,
                },
            )

            # Anchor PyHFO single-recording tools to the recording the desktop has loaded, so a
            # tool call that omits input_path operates on the right file (not a stale session one).
            from runtime.agent_runtime import pyhfo_tools
            pyhfo_tools.begin_active_recording(request.recording_path)
            # ...and to the desktop session that asked, so work the workspace owns is handed back to
            # it instead of being computed here where no panel can show it.
            pyhfo_tools.begin_desktop_session(
                getattr(request, "session_url", None),
                getattr(request, "session_token", None),
            )

            step_index = 0
            # 可通过 port 注入配置，默认 3 次
            _port_max_cycles = getattr(self.port, "max_finalization_cycles", None)
            MAX_FINALIZATION_CYCLES = int(_port_max_cycles) if _port_max_cycles else 3
            finalization_cycles = 0
            evaluated_review_receipt_seal: tuple[tuple[str, str], ...] = ()
            while True:
                finalization_cycles += 1
                if finalization_cycles > MAX_FINALIZATION_CYCLES:
                    logger.error("[Orchestrator] Finalization cycle limit exceeded (%d)", MAX_FINALIZATION_CYCLES)
                    break
                while step_index < state.total_runtime_steps():
                    step = state.get_runtime_step(step_index)
                    if step is None:
                        break
                    if self.port.is_cancelled(conv_id):
                        await self._save_conversation_runtime_state(
                            request=request,
                            state=state,
                            next_step_index=step_index,
                        )
                        await self.port.finalize_failure_response(
                            conversation_id=conv_id,
                            current_turn_id=current_turn_id,
                            status="cancelled",
                            error_message="User cancelled the request",
                            total_iterations=total_iterations,
                        )
                        yield {"event": "error", "data": {"message": "请求已取消"}}
                        return

                    state.set_current_step_index(step_index)
                    self.port.on_step_started(
                        conversation_id=conv_id,
                        step_index=step_index,
                        total_steps=state.total_runtime_steps(),
                        step=step,
                    )

                    if step.step_type == "skill":
                        yield {
                            "event": "skill_routing",
                            "data": {
                                "step_index": step_index,
                                "total_steps": state.total_runtime_steps(),
                                "step_id": step.step_id,
                                "skill_name": step.skill_name,
                                "goal": step.goal,
                            },
                        }

                    yield {
                        "event": "step_status",
                        "data": {
                            "message": f"步骤 {step_index + 1}/{state.total_runtime_steps()}：{step.skill_name} - {step.goal}"
                        },
                    }
                    yield {"event": "status", "data": {"message": f"正在思考... (第{step_index + 1}步)"}}

                    step_started_at = datetime.now()
                    streamed_step_event_signatures: set[str] = set()
                    live_step_events: "asyncio.Queue[Dict[str, Any]]" = asyncio.Queue()

                    async def _push_live_step_event(event: Dict[str, Any]) -> None:
                        await live_step_events.put(event)
                    _STEP_TIMEOUT_SECONDS = 300  # 5 分钟单步超时保护
                    # Defense-in-depth: bind all six result vars before the try so a
                    # fall-through can never reuse the PREVIOUS step's stale values
                    # (which would store the prior step's result under this step's id).
                    step_result = None
                    step_iterations = 0
                    step_sources = []
                    step_events = []
                    step_model = None
                    step_tokens = None
                    try:
                        step_task = asyncio.create_task(
                            asyncio.wait_for(
                                self.port.run_step_react_loop(
                                    step=step,
                                    state=state,
                                    message=request.message,
                                    history=history,
                                    knowledge_base_id=request.knowledge_base_id,
                                    all_tools=all_tools,
                                    base_context_pack=context_pack,
                                    routing_result=routing_result,
                                    event_callback=_push_live_step_event,
                                ),
                                timeout=_STEP_TIMEOUT_SECONDS,
                            )
                        )
                        while True:
                            if step_task.done() and live_step_events.empty():
                                break
                            try:
                                event = await asyncio.wait_for(live_step_events.get(), timeout=0.05)
                            except asyncio.TimeoutError:
                                continue
                            streamed_step_event_signatures.add(self._event_signature(event))
                            yield _sanitize_public_event(event)

                        (
                            step_result,
                            step_iterations,
                            step_sources,
                            step_events,
                            step_model,
                            step_tokens,
                        ) = await step_task
                    except asyncio.TimeoutError as step_error:
                        # Do NOT fall through: the result vars were never bound, so the
                        # success path below would either crash (UnboundLocalError on the
                        # first step) or silently reuse the previous step's results (later
                        # steps). Fail the step cleanly like the generic handler does.
                        logger.error(
                            "[Orchestrator] Step %s timed out after %ds",
                            step.step_id, _STEP_TIMEOUT_SECONDS,
                        )
                        self.port.on_step_failed(
                            conversation_id=conv_id,
                            current_turn_id=current_turn_id,
                            user_id=request.user_id,
                            step=step,
                            step_index=step_index,
                            step_started_at=step_started_at,
                            error=step_error,
                        )
                        raise RuntimeError(
                            f"Step {step.step_id} ({step.skill_name}) timed out after "
                            f"{_STEP_TIMEOUT_SECONDS}s"
                        ) from step_error
                    except Exception as step_error:
                        self.port.on_step_failed(
                            conversation_id=conv_id,
                            current_turn_id=current_turn_id,
                            user_id=request.user_id,
                            step=step,
                            step_index=step_index,
                            step_started_at=step_started_at,
                            error=step_error,
                        )
                        raise

                    for event in step_events:
                        if self._event_signature(event) in streamed_step_event_signatures:
                            continue
                        yield _sanitize_public_event(event)

                    self._capture_trusted_action_receipts(state=state, events=step_events)
                    self._capture_trusted_research_evidence(state=state, events=step_events)

                    total_iterations += step_iterations
                    state.total_iterations = total_iterations
                    state.step_results[step.step_id] = step_result
                    if step.output_schema is not None and not step_result.success:
                        contract_error = RuntimeError(
                            f"Step {step.step_id} did not satisfy its completion contract"
                        )
                        self.port.on_step_failed(
                            conversation_id=conv_id,
                            current_turn_id=current_turn_id,
                            user_id=request.user_id,
                            step=step,
                            step_index=step_index,
                            step_started_at=step_started_at,
                            error=contract_error,
                        )
                        yield {
                            "event": "step_completed",
                            "data": {
                                "step_index": step_index,
                                "step_id": step.step_id,
                                "skill_name": step.skill_name,
                                "status": "failed",
                                "summary": "Step completion contract was not satisfied.",
                                "success": False,
                            },
                        }
                        raise contract_error
                    handoff = self.port.build_step_handoff(step, step_result)
                    state.shared_memory[step.step_id] = handoff
                    state.skills_executed.append(step.skill_name)
                    state.last_active_skill_name = step.skill_name
                    state.all_sources.extend(step_sources)

                    if step_model:
                        model_used = step_model
                    if step_tokens is not None:
                        tokens_used = step_tokens

                    self.port.on_step_completed(
                        conversation_id=conv_id,
                        current_turn_id=current_turn_id,
                        user_id=request.user_id,
                        step=step,
                        step_index=step_index,
                        total_steps=state.total_runtime_steps(),
                        step_result=step_result,
                        handoff=handoff,
                        step_started_at=step_started_at,
                    )

                    yield {
                        "event": "step_handoff",
                        "data": {
                            "step_id": step.step_id,
                            "skill_name": step.skill_name,
                            "handoff": handoff,
                        },
                    }
                    yield {
                        "event": "step_completed",
                        "data": {
                            "step_index": step_index,
                            "step_id": step.step_id,
                            "skill_name": step.skill_name,
                            "status": "success" if step_result.success else "failed",
                            "summary": handoff.get("summary", "") if isinstance(handoff, dict) else "",
                            "success": step_result.success,
                        },
                    }
                    yield {
                        "event": "step_status",
                        "data": {
                            "message": f"已完成步骤 {step_index + 1}/{state.total_runtime_steps()}：{step.skill_name}"
                        },
                    }

                    if step_result.output.get("waiting_for_input"):
                        pending_input_loader = getattr(self.port, "get_pending_user_input_snapshot", None)
                        pending_user_input = (
                            pending_input_loader(conv_id)
                            if callable(pending_input_loader)
                            else None
                        )
                        state.pending_user_input = pending_user_input
                        await self._save_conversation_runtime_state(
                            request=request,
                            state=state,
                            next_step_index=step_index,
                            pending_user_input=pending_user_input,
                        )
                        yield {"event": "status", "data": {"message": "等待用户输入..."}}
                        return

                    plan_adjustment: Optional[PlanAdjustment] = None

                    # Skip expensive controller LLM call when the plan is a
                    # fast-path plan (rules-based, no replanning needed).
                    #
                    # Historically there was also a "bootstrap single-step plan
                    # + success" shortcut here; it was wrong because bootstrap
                    # **always** emits exactly 1 step by design, relying on the
                    # controller to add follow-up steps for multi-stage
                    # requests. Skipping the controller in that case made
                    # multi-task queries (e.g. "自我介绍，然后 X，再 Y") stop
                    # after the first sub-task. The controller itself has its
                    # own short-circuit for genuinely-complete single-step
                    # answers, so we always let it run for bootstrap plans.
                    _skip_controller = self._should_skip_post_step_replanning(
                        state=state,
                        completed_step=step,
                        step_result=step_result,
                    ) or manual_active_skill_turn
                    if not _skip_controller:
                        control_decider = getattr(self.port, "decide_plan_adjustment_after_step", None)
                        if callable(control_decider):
                            plan_adjustment = await control_decider(
                                state=state,
                                completed_step=step,
                                step_result=step_result,
                                handoff=handoff,
                                message=request.message,
                                all_tools=all_tools,
                                routing_result=routing_result,
                            )

                    if (
                        not self._is_actionable_plan_adjustment(plan_adjustment)
                        and not manual_active_skill_turn
                        and not self._should_skip_post_step_replanning(
                            state=state,
                            completed_step=step,
                            step_result=step_result,
                        )
                    ):
                        plan_adjustment = await self.port.maybe_adjust_plan_after_step(
                            state=state,
                            completed_step=step,
                            step_result=step_result,
                            message=request.message,
                            all_tools=all_tools,
                            routing_result=routing_result,
                        )

                    if self._is_actionable_plan_adjustment(plan_adjustment):
                        if plan_adjustment.source == "agent_control":
                            yield {
                                "event": "agent_control",
                                "data": {
                                    "action": plan_adjustment.action,
                                    "source": plan_adjustment.source,
                                    "reason": plan_adjustment.reason,
                                    "selected_skills": [
                                        inserted.skill_name
                                        for inserted in plan_adjustment.inserted_steps
                                        if inserted.step_type == "skill"
                                    ],
                                },
                            }

                        step_index = self._apply_plan_adjustment(
                            state=state,
                            step_index=step_index,
                            adjustment=plan_adjustment,
                        )
                        self.port.on_plan_adjusted(
                            conversation_id=conv_id,
                            state=state,
                            completed_step=step,
                            adjustment=plan_adjustment,
                        )
                        yield {
                            "event": "plan_updated",
                            "data": {
                                "action": plan_adjustment.action,
                                "source": plan_adjustment.source,
                                "reason": plan_adjustment.reason,
                                "inserted_steps": [
                                    self._serialize_step(inserted)
                                    for inserted in plan_adjustment.inserted_steps
                                ],
                                "total_steps": state.total_runtime_steps(),
                            },
                        }
                        state.pending_user_input = None
                        await self._save_conversation_runtime_state(
                            request=request,
                            state=state,
                            next_step_index=step_index,
                        )
                        continue

                    step_index += 1
                    state.pending_user_input = None
                    await self._save_conversation_runtime_state(
                        request=request,
                        state=state,
                        next_step_index=step_index,
                    )

                yield {"event": "status", "data": {"message": "执行计划已完成，正在汇总最终答案..."}}
                final_result = await self.port.compose_final_answer_from_state(state)
                final_content = final_result["content"]
                sources = final_result["sources"]
                self._revalidate_trusted_action_receipts(state=state)
                evaluated_review_receipt_seal = self._terminal_review_receipt_seal(
                    state=state
                )

                finalization_decider = getattr(self.port, "evaluate_runtime_final_answer", None)
                if callable(finalization_decider):
                    finalization_result: RuntimeFinalizationResult = await finalization_decider(
                        conversation_id=conv_id,
                        user_question=request.message,
                        final_content=final_content,
                        sources=sources,
                        state=state,
                    )
                    final_content = finalization_result.final_content
                    sources = finalization_result.sources
                    if finalization_result.verification_event:
                        yield finalization_result.verification_event
                    if (
                        self._is_actionable_plan_adjustment(finalization_result.plan_adjustment)
                        and not manual_active_skill_turn
                    ):
                        last_completed_index = max(state.total_runtime_steps() - 1, 0)
                        completed_step = state.get_runtime_step(last_completed_index)
                        if completed_step is None:
                            if last_completed_index < len(state.plan.steps):
                                completed_step = state.plan.steps[last_completed_index]
                            else:
                                # No steps exist - create a dummy step for the adjustment
                                completed_step = ExecutionStep(
                                    step_id="finalization_anchor",
                                    skill_name="final_synthesizer",
                                    goal="finalization",
                                    instructions="",
                                    step_type="synthesis",
                                )
                        state.set_current_step_index(last_completed_index)
                        step_index = self._apply_plan_adjustment(
                            state=state,
                            step_index=last_completed_index,
                            adjustment=finalization_result.plan_adjustment,
                        )
                        self.port.on_plan_adjusted(
                            conversation_id=conv_id,
                            state=state,
                            completed_step=completed_step,
                            adjustment=finalization_result.plan_adjustment,
                        )
                        yield {
                            "event": "plan_updated",
                            "data": {
                                "action": finalization_result.plan_adjustment.action,
                                "source": finalization_result.plan_adjustment.source,
                                "reason": finalization_result.plan_adjustment.reason,
                                "inserted_steps": [
                                    self._serialize_step(inserted)
                                    for inserted in finalization_result.plan_adjustment.inserted_steps
                                ],
                                "total_steps": state.total_runtime_steps(),
                            },
                        }
                        await self._save_conversation_runtime_state(
                            request=request,
                            state=state,
                            next_step_index=step_index,
                        )
                        continue
                else:
                    # verification 现在是 advisory-only：只检测 + 追加 disclaimer，
                    # 不改写答案、不回流 ReAct，所以不阻塞且与流式兼容。
                    final_content, verification_event = await self.port.run_verification_stage(
                        conversation_id=conv_id,
                        user_question=request.message,
                        final_content=final_content,
                        state=state,
                    )
                    if verification_event:
                        yield verification_event
                break

            # 语言一致性只依赖主 system prompt 约束，不再在最终输出后做 fast
            # pass 翻译补救，避免“先答错再修”的路径继续存在。

            self._revalidate_trusted_action_receipts(state=state)
            if self._terminal_review_receipt_seal(state=state) != evaluated_review_receipt_seal:
                raise RuntimeError(
                    "terminal review receipt scope changed during finalization"
                )

            terminal_action_receipts = [
                dict(receipt)
                for receipt in state.action_receipts
                if isinstance(receipt, Mapping) and receipt.get("terminal") is True
            ]
            success_result = await self.port.finalize_success_response(
                conversation_id=conv_id,
                current_turn_id=current_turn_id,
                final_content=final_content,
                total_iterations=total_iterations,
                model_used=model_used,
                tokens_used=tokens_used,
                sources=sources,
                message_id=state.message_id,
                request_id=state.request_id,
                state_revision=state.state_revision,
                action_receipts=terminal_action_receipts,
                research_output=state.research_output,
            )
            # The assistant message and completed turn are now durable.  Any
            # observer, delivery, or post-turn failure below may fail transport,
            # but must never rewrite this committed turn as failed.
            durable_success_committed = True

            # Success-only work is scheduled after the durable boundary.  It
            # remains asynchronous so a slow summary/memory backend does not
            # delay the terminal stream event.
            state.pending_user_input = None
            post_turn.schedule(
                self._save_conversation_runtime_state(
                    request=request,
                    state=state,
                    next_step_index=state.total_runtime_steps(),
                    final_content=final_content,
                ),
                name=f"save_state:{conv_id}",
                conv_id=conv_id,
            )
            post_turn.schedule(
                self.port.update_context_summary_after_turn(
                    conversation_id=conv_id,
                    message=request.message,
                    final_content=final_content,
                ),
                name=f"context_summary:{conv_id}",
                conv_id=conv_id,
            )
            post_turn.schedule(
                self.port.maybe_persist_durable_memory(
                    request=request,
                    state=state,
                    final_content=final_content,
                    sources=sources,
                ),
                name=f"memory_persist:{conv_id}",
                conv_id=conv_id,
            )

            yield {
                "event": "plan_completed",
                "data": {
                    "skills_executed": state.skills_executed,
                    "total_steps": state.total_runtime_steps(),
                },
            }
            self.port.on_plan_completed(
                conversation_id=conv_id,
                execution_plan=execution_plan,
                total_iterations=total_iterations,
                request_start_time=request_start_time,
                skills_executed=state.skills_executed,
            )

            # Release this turn's post-turn tasks (save_state / summary / memory, scheduled
            # above) into the protected bucket BEFORE the terminal 'done' is emitted. Clients
            # routinely close the SSE stream the instant they see 'done', and a STOP in that
            # window would otherwise let cancel_for_conversation cancel the still-cancellable
            # save_state and lose the just-completed turn's state. The finally-block release
            # is now an idempotent no-op for this path and still covers failure/early return.
            post_turn.release_conversation(conv_id)

            async for event in self.port.emit_final_content_and_done(
                final_content=final_content,
                conversation_id=conv_id,
                active_skill_name_result=state.skills_executed[-1] if state.skills_executed else None,
                skill_reason=routing_result.reason if routing_result else "",
                routing_result=routing_result,
                total_iterations=total_iterations,
                request_start_time=request_start_time,
                sources=sources,
                success_result=success_result,
                action_receipts=terminal_action_receipts,
                ui_commands=list(state.ui_commands),
                research_output=state.research_output,
                already_streamed=getattr(state, "streamed_answer", ""),
            ):
                public_event = _sanitize_public_event(event)
                if public_event.get("event") == "done":
                    terminal_done_emitted = True
                yield public_event
        except Exception as error:
            logger.exception(
                "[Orchestrator] turn failed conv_id=%s (detail kept server-side)",
                conv_id,
            )
            if terminal_done_emitted:
                return
            if not durable_success_committed:
                try:
                    self.port.on_plan_failed(
                        conversation_id=conv_id,
                        execution_plan=execution_plan,
                        total_iterations=total_iterations,
                        request_start_time=request_start_time,
                    )
                except Exception:
                    logger.exception("[Orchestrator] failure observer raised conv_id=%s", conv_id)
                if "state" in locals():
                    with_context_index = min(
                        int(getattr(state, "current_step_index", 0) or 0),
                        state.total_runtime_steps(),
                    )
                    try:
                        await self._save_conversation_runtime_state(
                            request=request,
                            state=state,
                            next_step_index=with_context_index,
                        )
                    except Exception:
                        logger.exception("[Orchestrator] failed to save failure state conv_id=%s", conv_id)
                try:
                    await self.port.finalize_failure_response(
                        conversation_id=conv_id,
                        current_turn_id=current_turn_id,
                        status="failed",
                        error_message=str(error),
                        total_iterations=total_iterations,
                    )
                except Exception:
                    logger.exception("[Orchestrator] failed to finalize failure conv_id=%s", conv_id)
            yield {
                "event": "error",
                "data": {"message": _PUBLIC_TURN_ERROR_MESSAGE},
            }
        finally:
            from runtime.agent_runtime import ui_command_context

            ui_command_context.end_ui_turn()
            # 把本 turn 已 schedule 的 post-turn 任务从 cancellable 桶搬到 released 桶。
            # 下一轮如果用户在 turn 2 里按"停止"，内部会调 cancel_for_conversation，
            # 它只碰 cancellable 桶；已经 release 的（本 turn 的 save_state / summary /
            # memory）不会被误伤，下一轮 bootstrap 仍能 wait_for_conversation 等到它们。
            post_turn.release_conversation(conv_id)
