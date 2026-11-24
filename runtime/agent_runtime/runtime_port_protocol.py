"""
AgentRuntimePort Protocol - Orchestrator 的端口接口定义

为 AgentOrchestrator 的 `port` 参数提供类型约定。
所有 port 实现（如 AgentRuntimePortAdapter）应满足此 Protocol。
这使得 IDE 能提供自动补全，重构时能发现漏实现的方法。
"""

from datetime import datetime
from typing import Any, AsyncGenerator, Dict, List, Optional, Protocol, Tuple

from runtime.agent_runtime.conversation_state import ConversationRuntimeState
from runtime.context.models import ContextPack
from runtime.skills.models import ExecutionPlan, ExecutionState, ExecutionStep, RoutingResult, SkillPackage, StepResult


class AgentRuntimePort(Protocol):
    """Orchestrator 所需的全部端口方法。

    Orchestrator 通过 duck-typing 调用这些方法。此 Protocol 仅用于
    类型检查和文档，不强制继承。
    """

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def clear_cancel_flag(self, conversation_id: str) -> None: ...

    def refresh_postprocess_services(self) -> None: ...

    async def init_conversation_and_turn(
        self, *, conversation_id: str, message: str,
        active_skill_name: Optional[str], user_id: Optional[str],
    ) -> str: ...

    def on_request_started(
        self, *, conversation_id: str, message: str,
        active_skill_name: Optional[str],
    ) -> None: ...

    # ------------------------------------------------------------------
    # Data loading
    # ------------------------------------------------------------------

    async def load_history_for_request(self, conversation_id: str) -> List[Dict]: ...

    async def load_conversation_runtime_state(
        self, conversation_id: str,
    ) -> Optional[ConversationRuntimeState]: ...

    async def save_conversation_runtime_state(
        self, *, conversation_id: str, runtime_state: ConversationRuntimeState,
    ) -> None: ...

    def get_pending_user_input_snapshot(
        self, conversation_id: str,
    ) -> Optional[Dict[str, Any]]: ...

    async def resolve_tools_for_request(
        self, *, message: str, user_context: Any,
    ) -> List[Dict]: ...

    async def resolve_skill_packages_for_request(self, request: Any) -> List[SkillPackage]: ...

    # ------------------------------------------------------------------
    # Bootstrap / routing
    # ------------------------------------------------------------------

    async def bootstrap_runtime_turn(
        self, *, request: Any, all_skill_packages: List[SkillPackage], all_tools: List[Dict],
    ) -> Any: ...

    async def maybe_build_fast_path_bootstrap(
        self, *, request: Any, all_skill_packages: List[SkillPackage], all_tools: List[Dict],
    ) -> Optional[Any]: ...

    def on_routing_resolved(self, **kwargs: Any) -> None: ...

    def on_plan_created(self, **kwargs: Any) -> None: ...

    async def prepare_context_pack_for_request(self, **kwargs: Any) -> Optional[ContextPack]: ...

    # ------------------------------------------------------------------
    # Cancellation
    # ------------------------------------------------------------------

    def is_cancelled(self, conversation_id: str) -> bool: ...

    # ------------------------------------------------------------------
    # Step execution
    # ------------------------------------------------------------------

    def on_step_started(self, **kwargs: Any) -> None: ...

    async def run_step_react_loop(
        self, *, step: ExecutionStep, state: ExecutionState, **kwargs: Any,
    ) -> Tuple[StepResult, int, List[Dict], List[Dict], str, Optional[int]]: ...

    def on_step_failed(self, **kwargs: Any) -> None: ...

    def build_step_handoff(self, step: ExecutionStep, step_result: StepResult) -> Dict[str, Any]: ...

    def on_step_completed(self, **kwargs: Any) -> None: ...

    # ------------------------------------------------------------------
    # Plan adjustment
    # ------------------------------------------------------------------

    async def maybe_adjust_plan_after_step(self, **kwargs: Any) -> Optional[Any]: ...

    async def decide_plan_adjustment_after_step(self, **kwargs: Any) -> Optional[Any]: ...

    def on_plan_adjusted(self, **kwargs: Any) -> None: ...

    # ------------------------------------------------------------------
    # Finalization
    # ------------------------------------------------------------------

    async def compose_final_answer_from_state(self, state: ExecutionState) -> Dict[str, Any]: ...

    async def evaluate_runtime_final_answer(self, **kwargs: Any) -> Any: ...

    async def run_verification_stage(self, **kwargs: Any) -> Tuple[str, Optional[Dict]]: ...

    # ------------------------------------------------------------------
    # Post-turn
    # ------------------------------------------------------------------

    async def maybe_persist_durable_memory(self, **kwargs: Any) -> None: ...

    async def update_context_summary_after_turn(self, **kwargs: Any) -> None: ...

    async def finalize_success_response(self, **kwargs: Any) -> Dict[str, Any]: ...

    async def finalize_failure_response(self, **kwargs: Any) -> None: ...

    def on_plan_completed(self, **kwargs: Any) -> None: ...

    def on_plan_failed(self, **kwargs: Any) -> None: ...

    async def emit_final_content_and_done(self, **kwargs: Any) -> AsyncGenerator[Dict, None]: ...

    # ------------------------------------------------------------------
    # Optional configurable attributes
    # ------------------------------------------------------------------

    max_finalization_cycles: Optional[int]
