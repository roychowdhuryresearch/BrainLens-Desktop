import json
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from runtime.agent_runtime.agent_controller import AgentControlRequest, AgentController
from runtime.agent_runtime.conversation_shell import RuntimeConversationShell
from runtime.agent_runtime.final_output import RuntimeFinalOutputCoordinator
from runtime.agent_runtime.infra_adapter import RuntimeInfraAdapter
from runtime.agent_runtime.message_compression import RuntimeMessageCompressor
from runtime.agent_runtime.planning_policy import RuntimePlanningPolicy
from runtime.agent_runtime.postprocess_factory import RuntimePostprocessManager
from runtime.agent_runtime.prompt_assembly import PromptAssemblyService
from runtime.agent_runtime.step_executor import StepExecutionRequest, StepExecutor
from runtime.agent_runtime.tool_executor import ToolExecutor
from runtime.agent_runtime.tool_result_utils import (
    classify_tool_family,
    extract_knowledge_base_slugs_from_sources,
    extract_sources_from_tool_result,
    extract_tool_focus_args,
    infer_tool_error_type,
    normalize_tool_args,
    summarize_tool_result,
    tool_provider_name,
)
from runtime.agent_runtime.orchestrator import RuntimeBootstrapResult
from runtime.skills.models import ExecutionState, ExecutionStep, RoutingResult, SkillRuntimeContext, StepResult

logger = logging.getLogger(__name__)


class AgentRuntimePortAdapter:
    """Runtime boundary between headless orchestration and application shell."""

    def __init__(
        self,
        service: Any,
        *,
        max_tool_iterations: int,
        max_parallel_tool_calls: int,
        tool_call_timeout_seconds: int,
        vl_tool_timeout_seconds: int,
    ) -> None:
        self.service = service
        self.ai_service = service.ai_service
        self.prompt_assembly = PromptAssemblyService()
        self.planning_policy = RuntimePlanningPolicy()
        self.infra = RuntimeInfraAdapter(service)
        self.conversation_shell = RuntimeConversationShell(service)
        self.message_compressor = RuntimeMessageCompressor()
        self.postprocess = RuntimePostprocessManager(
            ai_service=service.ai_service,
            ai_models=getattr(service, "_ai_models", []) or [],
            router_model_config=getattr(getattr(service, "router_model", None), "router_model_config", None),
            router_ai_service_getter=lambda: (
                service.router_model.get_router_ai_service()
                if getattr(service, "router_model", None)
                else None
            ),
        )
        self.agent_controller = AgentController(self)
        self.step_executor = StepExecutor(self, max_tool_iterations=max_tool_iterations)
        self.tool_executor = ToolExecutor(
            self,
            max_parallel_tool_calls=max_parallel_tool_calls,
            tool_call_timeout_seconds=tool_call_timeout_seconds,
            vl_tool_timeout_seconds=vl_tool_timeout_seconds,
        )
        self.final_output = RuntimeFinalOutputCoordinator(service, postprocess=self.postprocess)

    def get_control_ai_service(self):
        resolver = getattr(self.service, "router_model", None)
        if resolver is not None:
            try:
                router_ai = resolver.get_router_ai_service()
                if router_ai:
                    return router_ai
            except Exception as exc:
                logger.warning("[RuntimePort] Failed to get router AI service for controller: %s", exc)
        return self.ai_service

    def get_compress_ai_service(self):
        """Return a fast AI service for tool result summarization (e.g., qwen-turbo)."""
        compress_svc = getattr(self.postprocess, "_compress_ai_service", None)
        if compress_svc:
            return compress_svc
        bundle = getattr(self.postprocess, "bundle", None)
        if bundle:
            svc = getattr(bundle, "compress_ai_service", None)
            if svc:
                return svc
        # Last resort: use the router AI service (lightweight model)
        control_svc = self.get_control_ai_service()
        if control_svc and control_svc is not self.ai_service:
            return control_svc
        return None

    def get_summarizer_ai_service(self):
        """Return the summarizer AI service for tool-result summarization.

        Priority: summarizer_model > compress_model > router_model > None.
        """
        summarizer_svc = getattr(self.postprocess, "_summarizer_ai_service", None)
        if summarizer_svc:
            return summarizer_svc
        bundle = getattr(self.postprocess, "bundle", None)
        if bundle:
            svc = getattr(bundle, "summarizer_ai_service", None)
            if svc:
                return svc
        # Fallback: use compress service
        return self.get_compress_ai_service()

    async def maybe_build_fast_path_bootstrap(
        self,
        *,
        request,
        all_skill_packages: List[Dict],
        all_tools: List[Dict],
    ) -> Optional[RuntimeBootstrapResult]:
        del all_skill_packages, all_tools
        # Layer 1: rule-based (arithmetic only, instant)
        use_fast = self.planning_policy.should_use_fast_path(
            message=request.message,
            active_skill_name=request.active_skill_name,
            conversation_state=request.conversation_state,
        )
        # Layer 2: LLM-based (short messages, ~2s)
        if not use_fast:
            fast_ai = self.get_compress_ai_service() or self.ai_service
            use_fast = await self.planning_policy.should_use_fast_path_llm(
                message=request.message,
                ai_service=fast_ai,
                active_skill_name=request.active_skill_name,
                conversation_state=request.conversation_state,
            )
        if not use_fast:
            return None

        execution_plan = self.planning_policy.build_fast_path_plan(message=request.message)
        routing_result = RoutingResult(
            selected_skill=None,
            skill_name=None,
            confidence=1.0,
            reason=execution_plan.routing_reason,
            routing_method=execution_plan.routing_method,
            candidate_skills=[],
            planned_order=[],
        )
        return RuntimeBootstrapResult(
            routing_result=routing_result,
            execution_plan=execution_plan,
        )

    def __getattr__(self, name: str):
        forward_map = {
            "refresh_postprocess_services": (self.postprocess, "refresh"),
            "execute_tool": (self.infra, "execute_tool"),
            "search_knowledge_base": (self.infra, "search_knowledge_base"),
            "format_context": (self.infra, "format_context"),
            "_extract_sources": (self.infra, "extract_sources"),
            "get_mcp_tools": (self.infra, "get_mcp_tools"),
            "resolve_real_tool_name": (self.infra, "resolve_real_tool_name"),
            "get_hitl_tool_policy": (self.infra, "get_hitl_tool_policy"),
            "_convert_mcp_tools_to_ai_format": (self.infra, "convert_mcp_tools_to_ai_format"),
            "refresh_mcp_tools": (self.infra, "refresh_mcp_tools"),
            "resolve_tools_for_request": (self.infra, "resolve_tools_for_request"),
            "resolve_skill_packages_for_request": (self.service, "resolve_skill_packages_for_request"),
            "init_conversation_and_turn": (self.conversation_shell, "init_conversation_and_turn"),
            "load_history_for_request": (self.conversation_shell, "load_history_for_request"),
            "load_conversation_runtime_state": (self.conversation_shell, "load_conversation_runtime_state"),
            "save_conversation_runtime_state": (self.conversation_shell, "save_conversation_runtime_state"),
            "get_pending_user_input_snapshot": (self.conversation_shell, "get_pending_user_input_snapshot"),
            "prepare_context_pack_for_request": (self.conversation_shell, "prepare_context_pack_for_request"),
            "update_context_summary_after_turn": (self.conversation_shell, "update_context_summary_after_turn"),
            "clear_cancel_flag": (self.service, "clear_cancel_flag"),
            "is_cancelled": (self.service, "is_cancelled"),
            "on_request_started": (self.service, "on_request_started"),
            "bootstrap_runtime_turn": (self.service, "bootstrap_runtime_turn"),
            "maybe_persist_durable_memory": (self.service, "maybe_persist_durable_memory"),
            "on_routing_resolved": (self.service, "on_routing_resolved"),
            "on_plan_created": (self.service, "on_plan_created"),
            "on_step_started": (self.service, "on_step_started"),
            "on_step_failed": (self.service, "on_step_failed"),
            "on_step_completed": (self.service, "on_step_completed"),
            "on_plan_adjusted": (self.service, "on_plan_adjusted"),
            "on_plan_completed": (self.service, "on_plan_completed"),
            "on_plan_failed": (self.service, "on_plan_failed"),
        }
        target = forward_map.get(name)
        if target is not None:
            owner, attr_name = target
            return getattr(owner, attr_name)

        if name == "run_step_react_loop":
            async def _run_step_react_loop(
                *,
                step: ExecutionStep,
                state: ExecutionState,
                message: str,
                history: List[Dict],
                knowledge_base_id: Optional[str],
                all_tools: List[Dict],
                base_context_pack,
                routing_result: RoutingResult,
                event_callback=None,
            ):
                return await self.step_executor.execute(
                    StepExecutionRequest(
                        step=step,
                        state=state,
                        message=message,
                        history=history,
                        knowledge_base_id=knowledge_base_id,
                        all_tools=all_tools,
                        base_context_pack=base_context_pack,
                        routing_result=routing_result,
                        event_callback=event_callback,
                    )
                )
            return _run_step_react_loop

        if name == "build_step_handoff":
            return self.prompt_assembly.build_step_handoff

        if name == "compose_final_answer_from_state":
            return self.prompt_assembly.compose_final_answer_from_state

        if name == "decide_plan_adjustment_after_step":
            async def _decide_plan_adjustment_after_step(
                *,
                state: ExecutionState,
                completed_step: ExecutionStep,
                step_result: StepResult,
                handoff: Dict[str, Any],
                message: str,
                all_tools: List[Dict],
                routing_result: RoutingResult,
            ):
                should_run = self.planning_policy.should_run_agent_control_after_step(
                    ai_service_available=bool(getattr(self, "ai_service", None)),
                    state=state,
                    completed_step=completed_step,
                    step_result=step_result,
                )
                if not should_run:
                    return None
                return await self.agent_controller.decide(
                    AgentControlRequest(
                        state=state,
                        completed_step=completed_step,
                        step_result=step_result,
                        handoff=handoff,
                        message=message,
                        all_tools=all_tools,
                        routing_result=routing_result,
                    )
                )
            return _decide_plan_adjustment_after_step

        if name == "maybe_adjust_plan_after_step":
            async def _maybe_adjust_plan_after_step(
                *,
                state: ExecutionState,
                completed_step: ExecutionStep,
                step_result: StepResult,
                message: str,
                all_tools: List[Dict],
                routing_result: RoutingResult,
            ):
                del routing_result
                return self.agent_controller.adjust_from_step_output(
                    state=state,
                    completed_step=completed_step,
                    step_result=step_result,
                    message=message,
                    all_tools=all_tools,
                )
            return _maybe_adjust_plan_after_step

        if name in {
            "evaluate_runtime_final_answer",
            "run_verification_stage",
            "finalize_success_response",
            "finalize_failure_response",
            "emit_final_content_and_done",
        }:
            return getattr(self.final_output, name)

        raise AttributeError(name)

    @staticmethod
    def _extract_usage_metrics(payload: Optional[Dict[str, Any]]) -> tuple[int, int, int]:
        usage = payload.get("usage") if isinstance(payload, dict) else None
        if not isinstance(usage, dict):
            return 0, 0, 0
        return (
            int(usage.get("prompt_tokens") or 0),
            int(usage.get("completion_tokens") or 0),
            int(usage.get("total_tokens") or 0),
        )

    def record_observability_span(
        self,
        *,
        turn_id: Optional[str],
        conversation_id: Optional[str],
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
        ) -> None:
        self.service.record_observability_span(
            turn_id=turn_id,
            conversation_id=conversation_id,
            user_id=user_id,
            span_type=span_type,
            phase=phase,
            name=name,
            status=status,
            loop_index=loop_index,
            started_at=started_at,
            ended_at=ended_at,
            duration_ms=duration_ms,
            model_used=model_used,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            total_tokens=total_tokens,
            tool_name=tool_name,
            skill_name=skill_name,
            metadata=metadata,
        )

    @staticmethod
    def tool_args_signature(function_name: str, function_args: Dict[str, Any]) -> str:
        try:
            serialized_args = json.dumps(function_args or {}, ensure_ascii=False, sort_keys=True, default=str)
        except TypeError:
            serialized_args = json.dumps(str(function_args), ensure_ascii=False)
        return f"{function_name}:{serialized_args}"

    def track_tool_call_signature(
        self,
        *,
        turn_id: Optional[str],
        step_id: Optional[str],
        function_name: str,
        function_args: Dict[str, Any],
    ) -> Dict[str, Any]:
        return self.service.track_tool_call_signature(
            turn_id=turn_id,
            step_id=step_id,
            function_name=function_name,
            function_args=function_args,
        )

    def classify_tool_family(self, tool_name: str) -> str:
        return classify_tool_family(tool_name)

    def tool_provider_name(self, tool_name: str) -> str:
        provider = self.infra.tool_provider_identity(tool_name)
        return provider or tool_provider_name(tool_name)

    def normalize_tool_args(self, function_args: Any) -> Dict[str, Any]:
        return normalize_tool_args(function_args)

    def extract_tool_focus_args(self, function_args: Dict[str, Any]) -> Dict[str, Any]:
        return extract_tool_focus_args(function_args)

    def summarize_tool_result(self, tool_result: Any) -> Dict[str, Any]:
        return summarize_tool_result(tool_result)

    def extract_sources_from_tool_result(self, result: Any) -> List[Dict]:
        return extract_sources_from_tool_result(result)

    def extract_knowledge_base_slugs_from_sources(self, sources: List[Dict]) -> List[str]:
        return extract_knowledge_base_slugs_from_sources(sources)

    def infer_tool_error_type(self, error: Optional[str], status: str) -> str:
        return infer_tool_error_type(error, status)

    def extract_usage_metrics(self, payload: Optional[Dict[str, Any]]) -> tuple[int, int, int]:
        return self._extract_usage_metrics(payload)
