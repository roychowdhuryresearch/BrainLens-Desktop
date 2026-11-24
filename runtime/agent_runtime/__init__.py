"""Production runtime package surface.

Main entrypoints:
- AgentOrchestrator
- AgentRuntimePortAdapter
- AgentController / StepExecutor / ToolExecutor
"""

from .orchestrator import (
    AgentOrchestrator,
    AgentTurnRequest,
    PlanAdjustment,
    RuntimeBootstrapResult,
    RuntimeFinalizationResult,
)
from .conversation_state import ConversationRuntimeState, CONVERSATION_RUNTIME_STATE_KEY
from .infra_adapter import RuntimeInfraAdapter
from .message_compression import RuntimeMessageCompressor
from .planning_policy import RuntimePlanningPolicy
from .postprocess_factory import PostprocessBundle, RuntimePostprocessManager
from .prompt_assembly import PromptAssemblyService


def __getattr__(name):
    if name == "AgentController":
        from .agent_controller import AgentController
        return AgentController
    if name == "AgentControlRequest":
        from .agent_controller import AgentControlRequest
        return AgentControlRequest
    if name == "StepExecutor":
        from .step_executor import StepExecutor
        return StepExecutor
    if name == "StepExecutionRequest":
        from .step_executor import StepExecutionRequest
        return StepExecutionRequest
    if name == "ToolExecutor":
        from .tool_executor import ToolExecutor
        return ToolExecutor
    if name == "ToolExecutionRequest":
        from .tool_executor import ToolExecutionRequest
        return ToolExecutionRequest
    if name == "AgentRuntimePortAdapter":
        from .runtime_port import AgentRuntimePortAdapter
        return AgentRuntimePortAdapter
    if name == "PromptAssemblyService":
        from .prompt_assembly import PromptAssemblyService
        return PromptAssemblyService
    if name == "RuntimeInfraAdapter":
        from .infra_adapter import RuntimeInfraAdapter
        return RuntimeInfraAdapter
    if name == "RuntimeMessageCompressor":
        from .message_compression import RuntimeMessageCompressor
        return RuntimeMessageCompressor
    if name == "RuntimePlanningPolicy":
        from .planning_policy import RuntimePlanningPolicy
        return RuntimePlanningPolicy
    if name == "RuntimePostprocessManager":
        from .postprocess_factory import RuntimePostprocessManager
        return RuntimePostprocessManager
    if name == "PostprocessBundle":
        from .postprocess_factory import PostprocessBundle
        return PostprocessBundle
    if name == "RuntimeConversationShell":
        from .conversation_shell import RuntimeConversationShell
        return RuntimeConversationShell
    if name == "RuntimeFinalOutputCoordinator":
        from .final_output import RuntimeFinalOutputCoordinator
        return RuntimeFinalOutputCoordinator
    raise AttributeError(name)

__all__ = [
    # Core
    "AgentOrchestrator",
    "AgentTurnRequest",
    "PlanAdjustment",
    "RuntimeBootstrapResult",
    "RuntimeFinalizationResult",
    "ConversationRuntimeState",
    "CONVERSATION_RUNTIME_STATE_KEY",
    "AgentController",
    "AgentControlRequest",
    "StepExecutor",
    "StepExecutionRequest",
    "ToolExecutor",
    "ToolExecutionRequest",
    "AgentRuntimePortAdapter",
    "PromptAssemblyService",
    "RuntimeInfraAdapter",
    "RuntimeMessageCompressor",
    "RuntimePlanningPolicy",
    "RuntimePostprocessManager",
    "PostprocessBundle",
    "RuntimeConversationShell",
    "RuntimeFinalOutputCoordinator",
]
