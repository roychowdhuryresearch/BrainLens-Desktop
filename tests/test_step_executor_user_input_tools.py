import asyncio
import json

from runtime.agent_runtime.step_executor import StepExecutionRequest, StepExecutor
from runtime.agent_runtime.user_input import cleanup_pending_input, get_pending_input
from runtime.skills.models import ExecutionPlan, ExecutionState, ExecutionStep, RoutingResult


class _FakeAIService:
    async def chat(self, messages, tools=None):
        del messages, tools
        return {
            "content": "",
            "model_used": "fake-model",
            "usage": {"total_tokens": 3},
            "tool_calls": [
                {
                    "id": "call-tool",
                    "type": "function",
                    "function": {"name": "known_tool", "arguments": json.dumps({"query": "ok"})},
                },
                {
                    "id": "call-input",
                    "type": "function",
                    "function": {
                        "name": "request_user_input",
                        "arguments": json.dumps({"prompt": "Need approval?", "input_type": "confirm"}),
                    },
                },
            ],
        }


class _FakePlanningPolicy:
    def resolve_step_tools(self, *, step, all_tools, skill_context=None):
        del step, skill_context
        return all_tools


class _FakePromptAssembly:
    def build_system_prompt(self, **kwargs):
        del kwargs
        return "system"

    def build_step_model_messages(self, **kwargs):
        del kwargs
        return []

    def is_step_complete(self, step, ai_response, final_content):
        del step, ai_response, final_content
        return False

    def dedup_sources(self, sources):
        return list(sources)

    def parse_step_result(self, **kwargs):
        raise AssertionError("mixed request_user_input test should return before final parsing")


class _FakePostprocess:
    def should_skip_llm_reasoning_summary(self, **kwargs):
        del kwargs
        return True

    def simplify_reasoning_by_rules(self, reasoning_content):
        return reasoning_content

    async def summarize_reasoning(self, reasoning_content):
        return reasoning_content


class _FakeMessageCompressor:
    async def compress_messages_if_needed(self, messages):
        return messages


class _FakeToolExecutor:
    def __init__(self):
        self.requests = []

    async def execute(self, request):
        self.requests.append(request)
        yield {
            "event": "tool_result",
            "data": {"name": "known_tool", "success": True, "result": {"ok": True}},
        }


class _FakeServices:
    def __init__(self):
        self.ai_service = _FakeAIService()
        self.planning_policy = _FakePlanningPolicy()
        self.prompt_assembly = _FakePromptAssembly()
        self.postprocess = _FakePostprocess()
        self.message_compressor = _FakeMessageCompressor()
        self.tool_executor = _FakeToolExecutor()
        self.spans = []

    def extract_usage_metrics(self, payload):
        del payload
        return 0, 0, 3

    def record_observability_span(self, **kwargs):
        self.spans.append(kwargs)

    def is_cancelled(self, conversation_id):
        del conversation_id
        return False


def test_request_user_input_does_not_skip_other_tool_calls():
    conversation_id = "conv-mixed-input-tools"
    cleanup_pending_input(conversation_id)
    services = _FakeServices()
    step = ExecutionStep(
        step_id="s1",
        skill_name="general_assistant",
        goal="test",
        instructions="test",
        step_type="general",
        is_final_step=True,
    )
    plan = ExecutionPlan(user_goal="test", routing_reason="test", routing_method="test", steps=[step])
    state = ExecutionState(conversation_id=conversation_id, current_turn_id="turn-1", plan=plan, user_id="user-1")
    request = StepExecutionRequest(
        step=step,
        state=state,
        message="run and ask",
        history=[],
        knowledge_base_id=None,
        all_tools=[
            {"type": "function", "function": {"name": "known_tool", "parameters": {"type": "object"}}},
            {"type": "function", "function": {"name": "request_user_input", "parameters": {"type": "object"}}},
        ],
        base_context_pack=None,
        routing_result=RoutingResult(),
    )

    result, iterations, sources, events, model_used, tokens_used = asyncio.run(
        StepExecutor(services).execute(request)
    )

    assert result.output["waiting_for_input"] is True
    assert result.tool_calls_count == 2
    assert iterations == 1
    assert sources == []
    assert model_used == "fake-model"
    assert tokens_used == 3
    assert [call["function"]["name"] for call in services.tool_executor.requests[0].tool_calls] == ["known_tool"]
    assert [event["event"] for event in events] == ["tool_result", "user_input_required"]
    assert get_pending_input(conversation_id) is not None
    cleanup_pending_input(conversation_id)
