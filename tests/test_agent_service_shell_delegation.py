import asyncio

from runtime.agent_runtime.conversation_state import ConversationRuntimeState
from runtime.agent_runtime.orchestrator import AgentTurnRequest
from runtime.services.agent_service import AgentService
from runtime.skills.models import ExecutionPlan, ExecutionState


class FakeInfra:
    def __init__(self, calls):
        self.calls = calls

    async def execute_mcp_tool(self, tool_name, args, conversation_id=None):
        self.calls.append(("execute_mcp_tool", tool_name, args, conversation_id))
        return {"from": "infra_mcp"}

    async def execute_vl_tool(self, args, conversation_id=None):
        self.calls.append(("execute_vl_tool", args, conversation_id))
        return {"from": "infra_vl"}


class FakeRuntimePort:
    def __init__(self):
        self.calls = []
        self.infra = FakeInfra(self.calls)

    async def execute_tool(self, *, tool_name, args, conversation_id=None, user_role=None, user_id=None):
        self.calls.append(("execute_tool", tool_name, args, conversation_id))
        return {"from": "execute_tool"}

    async def search_knowledge_base(self, query, repo_id=None):
        self.calls.append(("search_knowledge_base", query, repo_id))
        return [{"id": "doc-1"}]

    async def format_context(self, search_results):
        self.calls.append(("format_context", tuple(item["id"] for item in search_results)))
        return "formatted-context"

    def _extract_sources(self, search_results):
        self.calls.append(("extract_sources", len(search_results)))
        return [{"title": "doc"}]

    def get_mcp_tools(self, user_context=None):
        self.calls.append(("get_mcp_tools", getattr(user_context, "username", None)))
        return [{"function": {"name": "tool_a"}}]

    def _convert_mcp_tools_to_ai_format(self, mcp_tools):
        self.calls.append(("convert_mcp_tools", len(mcp_tools)))
        return [{"function": {"name": "converted"}}]

    def refresh_mcp_tools(self):
        self.calls.append(("refresh_mcp_tools",))

    async def resolve_tools_for_request(self, request):
        self.calls.append(("resolve_tools_for_request", request.message))
        return [{"function": {"name": "resolved"}}]

    async def init_conversation_and_turn(self, **kwargs):
        self.calls.append(("init_conversation_and_turn", kwargs["conversation_id"], kwargs["message"]))
        return "turn-1"

    async def load_history_for_request(self, conversation_id):
        self.calls.append(("load_history_for_request", conversation_id))
        return [{"role": "user", "content": "history"}]

    async def load_conversation_runtime_state(self, conversation_id):
        self.calls.append(("load_conversation_runtime_state", conversation_id))
        return ConversationRuntimeState(conversation_id=conversation_id, turn_count=2)

    async def save_conversation_runtime_state(self, *, conversation_id, runtime_state):
        self.calls.append(("save_conversation_runtime_state", conversation_id, runtime_state.turn_count))

    def get_pending_user_input_snapshot(self, conversation_id):
        self.calls.append(("get_pending_user_input_snapshot", conversation_id))
        return {"prompt": "请输入参数"}

    async def prepare_context_pack_for_request(self, **kwargs):
        self.calls.append(("prepare_context_pack_for_request", kwargs["conversation_id"], kwargs["message"]))
        return "context-pack"

    async def update_context_summary_after_turn(self, **kwargs):
        self.calls.append(("update_context_summary_after_turn", kwargs["conversation_id"]))

    async def evaluate_runtime_final_answer(self, **kwargs):
        self.calls.append(("evaluate_runtime_final_answer", kwargs["conversation_id"], kwargs["user_question"]))
        return "runtime-finalization"

    async def run_verification_stage(self, **kwargs):
        self.calls.append(("run_verification_stage", kwargs["conversation_id"]))
        return ("verified", {"event": "verification", "data": {"verdict": "success"}})

    async def finalize_success_response(self, **kwargs):
        self.calls.append(("finalize_success_response", kwargs["conversation_id"], kwargs["final_content"]))
        return {"message_id": "msg-1", "model_used": kwargs["model_used"], "tokens_used": kwargs["tokens_used"]}

    async def finalize_failure_response(self, **kwargs):
        self.calls.append(("finalize_failure_response", kwargs["conversation_id"], kwargs["status"]))


def test_agent_service_shell_sync_wrappers_delegate_to_runtime_port():
    service = object.__new__(AgentService)
    port = FakeRuntimePort()
    service._runtime_port = port

    assert service.get_mcp_tools() == [{"function": {"name": "tool_a"}}]
    assert service._convert_mcp_tools_to_ai_format([{"name": "x"}]) == [{"function": {"name": "converted"}}]
    service.refresh_mcp_tools()
    assert service._extract_sources([{"id": "doc-1"}]) == [{"title": "doc"}]

    assert ("refresh_mcp_tools",) in port.calls


def test_agent_service_shell_async_wrappers_delegate_to_runtime_port():
    service = object.__new__(AgentService)
    port = FakeRuntimePort()
    service._runtime_port = port
    request = AgentTurnRequest(message="show me tools", conversation_id="conv-1")

    async def run():
        assert await service._get_runtime_port().infra.execute_mcp_tool("tool_a", {"x": 1}, "conv-1") == {"from": "infra_mcp"}
        assert await service.execute_tool(tool_name="tool_a", args={"y": 2}, conversation_id="conv-1") == {
            "from": "execute_tool"
        }
        assert await service._get_runtime_port().infra.execute_vl_tool({"image_ref": "img-1"}, "conv-1") == {"from": "infra_vl"}
        assert await service.search_knowledge_base("query", "repo-1") == [{"id": "doc-1"}]
        assert await service.format_context([{"id": "doc-1"}]) == "formatted-context"
        assert await service.resolve_tools_for_request(request) == [{"function": {"name": "resolved"}}]

    asyncio.run(run())

    assert ("execute_mcp_tool", "tool_a", {"x": 1}, "conv-1") in port.calls
    assert ("resolve_tools_for_request", "show me tools") in port.calls


def test_agent_service_shell_conversation_and_final_output_wrappers_delegate_to_runtime_port():
    service = object.__new__(AgentService)
    port = FakeRuntimePort()
    service._runtime_port = port

    async def run():
        assert await service.init_conversation_and_turn(
            conversation_id="conv-1",
            message="hello",
            active_skill_name=None,
            user_id="u1",
        ) == "turn-1"
        assert await service.load_history_for_request("conv-1") == [{"role": "user", "content": "history"}]
        runtime_state = await service.load_conversation_runtime_state("conv-1")
        assert runtime_state.turn_count == 2
        await service.save_conversation_runtime_state(
            conversation_id="conv-1",
            runtime_state=ConversationRuntimeState(conversation_id="conv-1", turn_count=3),
        )
        assert service.get_pending_user_input_snapshot("conv-1") == {"prompt": "请输入参数"}
        assert await service.prepare_context_pack_for_request(
            conversation_id="conv-1",
            history=[],
            message="hello",
            skill_context=None,
            current_turn_id="turn-1",
            user_id="u1",
        ) == "context-pack"
        await service.update_context_summary_after_turn(
            conversation_id="conv-1",
            message="hello",
            final_content="world",
        )
        state = ExecutionState(
            conversation_id="conv-1",
            current_turn_id="turn-1",
            plan=ExecutionPlan(
                user_goal="goal",
                routing_reason="reason",
                routing_method="fake",
                steps=[],
            ),
        )
        assert await service.evaluate_runtime_final_answer(
            conversation_id="conv-1",
            user_question="hello",
            final_content="world",
            sources=[],
            state=state,
        ) == "runtime-finalization"
        assert await service.run_verification_stage(
            conversation_id="conv-1",
            user_question="hello",
            final_content="world",
            state=state,
        ) == ("verified", {"event": "verification", "data": {"verdict": "success"}})
        success_response = await service.finalize_success_response(
            conversation_id="conv-1",
            current_turn_id="turn-1",
            final_content="world",
            total_iterations=1,
            model_used="m1",
            tokens_used=5,
            sources=[],
        )
        assert success_response["message_id"] == "msg-1"
        await service.finalize_failure_response(
            conversation_id="conv-1",
            current_turn_id="turn-1",
            status="failed",
            error_message="boom",
            total_iterations=1,
        )

    asyncio.run(run())

    assert ("init_conversation_and_turn", "conv-1", "hello") in port.calls
    assert ("load_history_for_request", "conv-1") in port.calls
    assert ("save_conversation_runtime_state", "conv-1", 3) in port.calls
    assert ("prepare_context_pack_for_request", "conv-1", "hello") in port.calls
    assert ("evaluate_runtime_final_answer", "conv-1", "hello") in port.calls
    assert ("run_verification_stage", "conv-1") in port.calls
    assert ("finalize_success_response", "conv-1", "world") in port.calls
    assert ("finalize_failure_response", "conv-1", "failed") in port.calls
