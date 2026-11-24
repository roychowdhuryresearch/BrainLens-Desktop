import asyncio
import copy
import json
from types import SimpleNamespace

from runtime.agent_runtime.completion_contract import (
    extract_json_output,
    is_research_output_completion_schema,
    research_output_completion_schema,
    research_output_contract_example,
    validate_step_output,
)
from runtime.agent_runtime.execution_attestation import build_execution_attestation
from runtime.agent_runtime.clinical_evidence import is_safe_non_completion_reply
from runtime.agent_runtime.prompt_assembly import PromptAssemblyService
from runtime.agent_runtime.planning_policy import RuntimePlanningPolicy
from runtime.agent_runtime.step_executor import StepExecutionRequest, StepExecutor
from runtime.skills.models import ExecutionPlan, ExecutionState, ExecutionStep, RoutingResult


def _step(schema):
    return ExecutionStep(
        step_id="s1",
        skill_name="analysis",
        goal="produce structured output",
        instructions="return json",
        output_schema=schema,
    )


def test_extract_json_output_accepts_fenced_or_embedded_json():
    assert extract_json_output("```json\n{\"status\": \"complete\"}\n```") == {"status": "complete"}
    assert extract_json_output("Result:\n{\"status\": \"complete\"}\nDone") == {"status": "complete"}


def test_output_schema_required_enum_types_and_additional_properties_fail_closed():
    step = _step({
        "type": "object",
        "required": ["status", "count"],
        "additionalProperties": False,
        "properties": {
            "status": {"type": "string", "enum": ["complete"]},
            "count": {"type": "integer", "minimum": 0},
        },
    })
    assert validate_step_output(step, '{"status":"complete","count":2}').ok is True
    invalid = validate_step_output(step, '{"status":"queued","count":-1,"extra":true}')
    assert invalid.ok is False
    assert any("enum" in error for error in invalid.errors)
    assert any("minimum" in error for error in invalid.errors)
    assert any("additional property" in error for error in invalid.errors)


def test_unknown_schema_keywords_and_unresolved_refs_fail_closed():
    unknown = validate_step_output(_step({"type": "object", "formatMaximum": 2}), "{}")
    assert unknown.ok is False
    assert "unsupported JSON Schema keywords" in unknown.errors[0]
    unresolved = validate_step_output(_step({"$ref": "#/$defs/missing"}), "{}")
    assert unresolved.ok is False
    assert "unresolved" in unresolved.errors[0]


def test_malformed_and_cyclic_schemas_reject_without_crashing():
    malformed_required = validate_step_output(
        _step({"type": "object", "required": [{}]}),
        "{}",
    )
    malformed_limit = validate_step_output(
        _step({"type": "number", "minimum": "zero"}),
        "1",
    )
    cyclic_ref = validate_step_output(
        _step({"$defs": {"loop": {"$ref": "#/$defs/loop"}}, "$ref": "#/$defs/loop"}),
        "{}",
    )

    for result in (malformed_required, malformed_limit, cyclic_ref):
        assert result.ok is False
        assert "invalid or unsupported" in result.errors[0]


def test_prompt_assembly_does_not_mark_schema_invalid_text_complete():
    service = PromptAssemblyService()
    step = _step({
        "type": "object",
        "required": ["run_id"],
        "properties": {"run_id": {"type": "string", "minLength": 1}},
    })
    assert service.is_step_complete(step, {"content": "looks done"}, "looks done") is False
    assert service.is_step_complete(step, {"content": '{"run_id":"run-1"}'}, '{"run_id":"run-1"}') is True


def test_parse_step_result_preserves_valid_structured_output_and_rejects_invalid():
    service = PromptAssemblyService()
    step = _step({"type": "object", "required": ["run_id"], "properties": {"run_id": {"type": "string"}}})
    valid = service.parse_step_result(step=step, final_content='{ "run_id": "run-1" }', sources=[], tool_calls_count=0)
    assert valid.success is True
    assert valid.output["structured_output"] == {"run_id": "run-1"}
    invalid = service.parse_step_result(step=step, final_content="not json", sources=[], tool_calls_count=0)
    assert invalid.success is False
    assert invalid.output["completion_contract_errors"]


def test_canonical_research_output_schema_is_projected_into_supported_completion_dialect():
    schema = research_output_completion_schema()
    example = research_output_contract_example()
    step = _step(schema)

    assert is_research_output_completion_schema(schema) is True
    assert validate_step_output(step, json.dumps(example)).ok is True

    conditional_violation = copy.deepcopy(example)
    conditional_violation["claims"][0]["kind"] = "numeric"
    result = validate_step_output(step, json.dumps(conditional_violation))
    assert result.ok is False
    assert any("allOf" in error for error in result.errors)


def _research_state(step, *, recording_path="/private/case.edf"):
    return ExecutionState(
        conversation_id="conv-42",
        current_turn_id="msg-17",
        request_id="req-17",
        message_id="msg-17",
        state_revision="desktop-state-contract",
        response_language="en-US",
        recording_path=recording_path,
        plan=ExecutionPlan(
            user_goal="Analyze this loaded recording for HFO candidates.",
            routing_reason="case workflow",
            routing_method="test",
            steps=[step],
        ),
    )


def test_case_final_step_binds_research_contract_and_prompt_shape_but_generic_turn_does_not():
    service = PromptAssemblyService()
    case_step = ExecutionStep(
        step_id="case-final",
        skill_name="pyhfo_analysis",
        goal="Analyze this loaded recording for HFO candidates.",
        instructions="Analyze the case.",
        is_final_step=True,
    )
    case_state = _research_state(case_step)

    assert service.bind_step_output_contract(
        current_step=case_step,
        execution_state=case_state,
        user_message="Analyze this loaded recording for HFO candidates.",
    ) is True
    assert is_research_output_completion_schema(case_step.output_schema) is True
    assert case_step.output_schema is not None
    constraints = service.build_constraints_section(
        current_step=case_step,
        execution_state=case_state,
    )
    assert "### Required canonical research output" in constraints
    assert '"schema_version": "research-output.v1"' in constraints
    assert '"request_id": "req-17"' in constraints
    assert '"conversation_id": "conv-42"' in constraints
    assert '"message_id": "msg-17"' in constraints
    assert '"state_revision": "desktop-state-contract"' in constraints

    generic_step = ExecutionStep(
        step_id="generic-final",
        skill_name="general_assistant",
        goal="Explain HFOs.",
        instructions="Answer educationally.",
        is_final_step=True,
    )
    generic_state = _research_state(generic_step)
    assert service.bind_step_output_contract(
        current_step=generic_step,
        execution_state=generic_state,
        user_message="What are HFOs?",
    ) is False
    assert generic_step.output_schema is None


def test_missing_case_input_is_not_forced_into_a_fabricated_research_object():
    service = PromptAssemblyService()
    step = ExecutionStep(
        step_id="missing-input",
        skill_name="pyhfo_analysis",
        goal="Analyze this recording.",
        instructions="Analyze the case.",
        is_final_step=True,
    )
    state = _research_state(step, recording_path=None)

    assert service.bind_step_output_contract(
        current_step=step,
        execution_state=state,
        user_message="Analyze this recording.",
    ) is False
    assert step.output_schema is None


def test_step_executor_case_path_buffers_validates_and_preserves_structured_research_output(monkeypatch):
    payload = research_output_contract_example()
    payload.update(
        {
            "request_id": "req-17",
            "conversation_id": "conv-42",
            "message_id": "msg-17",
            "state_revision": "desktop-state-contract",
            "response_language": "en-US",
        }
    )

    class _AI:
        config = SimpleNamespace(provider="test", model="test")
        streamed = False

        async def chat(self, messages, tools=None, **kwargs):
            del messages, tools, kwargs
            return {
                "content": json.dumps(payload),
                "model_used": "test-model",
                "usage": {"total_tokens": 10},
            }

        async def chat_stream(self, messages, tools=None, **kwargs):
            del messages, tools, kwargs
            self.streamed = True
            raise AssertionError("unvalidated research JSON must not use live streaming")
            yield  # pragma: no cover

    class _Messages:
        async def compress_messages_if_needed(self, messages):
            return messages

    class _Services:
        def __init__(self):
            self.ai_service = _AI()
            self.planning_policy = RuntimePlanningPolicy()
            self.prompt_assembly = PromptAssemblyService()
            self.postprocess = SimpleNamespace()
            self.tool_executor = SimpleNamespace()
            self.message_compressor = _Messages()

        @staticmethod
        def extract_usage_metrics(payload):
            del payload
            return 0, 0, 10

        @staticmethod
        def record_observability_span(**kwargs):
            del kwargs

        @staticmethod
        def is_cancelled(conversation_id):
            del conversation_id
            return False

    step = ExecutionStep(
        step_id="case-final",
        skill_name="case_research",
        goal="Analyze this loaded recording for HFO candidates.",
        instructions="Analyze the case.",
        is_final_step=True,
    )
    state = _research_state(step)
    services = _Services()
    monkeypatch.setenv("IEEG_AGENT_STREAM", "1")
    request = StepExecutionRequest(
        step=step,
        state=state,
        message="Analyze this loaded recording for HFO candidates.",
        history=[],
        knowledge_base_id=None,
        all_tools=[],
        base_context_pack=None,
        routing_result=RoutingResult(),
    )

    result, *_ = asyncio.run(StepExecutor(services).execute(request))

    assert services.ai_service.streamed is False
    assert result.success is True
    assert result.output["structured_output"] == payload


class _LateBindingAI:
    config = SimpleNamespace(provider="test", model="test")

    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    async def chat(self, messages, tools=None, **kwargs):
        del kwargs
        self.calls.append({"messages": copy.deepcopy(messages), "tools": copy.deepcopy(tools)})
        return self.responses.pop(0)


class _LateBindingMessages:
    async def compress_messages_if_needed(self, messages):
        return messages


class _LateBindingTools:
    def __init__(self, *, tool_result):
        self.tool_result = tool_result

    async def execute(self, request):
        tool_call = request.tool_calls[0]
        name = tool_call["function"]["name"]
        arguments = json.loads(tool_call["function"]["arguments"])
        request.messages.append(
            {"role": "assistant", "content": "", "tool_calls": request.tool_calls}
        )
        yield {"event": "tool_call", "data": {"name": name, "args": arguments}}
        yield {
            "event": "tool_result",
            "data": {
                "name": name,
                "success": True,
                "result": self.tool_result,
                "result_summary": {"result_kind": "object"},
            },
        }
        request.messages.append(
            {
                "role": "tool",
                "tool_call_id": tool_call["id"],
                "name": name,
                "content": json.dumps(self.tool_result),
            }
        )


class _LateBindingServices:
    def __init__(self, *, responses, tool_result):
        self.ai_service = _LateBindingAI(responses)
        self.planning_policy = RuntimePlanningPolicy()
        self.prompt_assembly = PromptAssemblyService()
        self.postprocess = SimpleNamespace()
        self.tool_executor = _LateBindingTools(tool_result=tool_result)
        self.message_compressor = _LateBindingMessages()

    @staticmethod
    def extract_usage_metrics(payload):
        del payload
        return 0, 0, 1

    @staticmethod
    def record_observability_span(**kwargs):
        del kwargs

    @staticmethod
    def is_cancelled(conversation_id):
        del conversation_id
        return False


def _late_binding_case(*, second_content, tool_result, tool_arguments=None):
    tool_name = "pyhfo_compute_channel_qc"
    first_response = {
        "content": "",
        "model_used": "test-model",
        "usage": {"total_tokens": 1},
        "tool_calls": [
            {
                "id": "call-qc",
                "type": "function",
                "function": {
                    "name": tool_name,
                    "arguments": json.dumps(tool_arguments or {"input_path": "/private/case.edf"}),
                },
            }
        ],
    }
    second_response = {
        "content": second_content,
        "model_used": "test-model",
        "usage": {"total_tokens": 1},
    }
    services = _LateBindingServices(
        responses=[first_response, second_response],
        tool_result=tool_result,
    )
    step = ExecutionStep(
        step_id="late-case-final",
        skill_name="case_research",
        goal="Analyze this recording with QC.",
        instructions="Use the case tools, then report the result.",
        step_type="general",
        is_final_step=True,
    )
    state = _research_state(step, recording_path=None)
    request = StepExecutionRequest(
        step=step,
        state=state,
        message="Analyze this recording with QC.",
        history=[],
        knowledge_base_id=None,
        all_tools=[
            {
                "type": "function",
                "function": {
                    "name": tool_name,
                    "description": "Compute channel QC.",
                    "parameters": {"type": "object"},
                },
            }
        ],
        base_context_pack=None,
        routing_result=RoutingResult(),
    )
    result, *_ = asyncio.run(StepExecutor(services).execute(request))
    return result, step, services


def _attested_qc_result():
    result_payload = {
        "recording_id": "recording-aaaaaaaaaaaaaaaaaaaaaaaa",
        "channels": [{"channel": "A1", "status": "review"}],
    }
    provenance = build_execution_attestation(
        tool_name="pyhfo_compute_channel_qc",
        call_parameters={"input_path": "/private/case.edf"},
        result_payload=result_payload,
        source_recording_fingerprint="a" * 64,
        input_recording_fingerprint="a" * 64,
        state_revision="desktop-state-contract",
    )
    return {
        "success": True,
        "tool": "pyhfo_compute_channel_qc",
        "result": result_payload,
        "execution_provenance": provenance,
    }


def test_final_step_late_binds_research_schema_after_trusted_case_tool_result():
    payload = research_output_contract_example()
    payload.update(
        {
            "request_id": "req-17",
            "conversation_id": "conv-42",
            "message_id": "msg-17",
            "state_revision": "desktop-state-contract",
            "response_language": "en-US",
        }
    )
    result, step, services = _late_binding_case(
        second_content=json.dumps(payload),
        tool_result=_attested_qc_result(),
    )

    assert result.success is True
    assert is_research_output_completion_schema(step.output_schema) is True
    assert result.output["structured_output"] == payload
    assert len(services.ai_service.calls) == 2
    second_system_prompt = services.ai_service.calls[1]["messages"][0]["content"]
    assert "### Required canonical research output" in second_system_prompt
    assert '"tool_name":"pyhfo_compute_channel_qc"' in second_system_prompt


def test_late_binding_rejects_model_forged_arguments_and_result_attestation():
    forged = _attested_qc_result()
    forged["result"] = {"channels": [{"channel": "FORGED9", "status": "review"}]}
    result, step, services = _late_binding_case(
        second_content="No trusted case result is available.",
        tool_result=forged,
        tool_arguments={
            "input_path": "/private/case.edf",
            "execution_provenance": forged["execution_provenance"],
        },
    )

    assert result.success is True
    assert step.output_schema is None
    assert "### Required canonical research output" not in services.ai_service.calls[1]["messages"][0]["content"]


def test_late_binding_rejects_tool_incompatible_attested_evidence_kind():
    forged = _attested_qc_result()
    forged["execution_provenance"]["evidence_kinds"] = ["detector_candidate"]
    result, step, services = _late_binding_case(
        second_content="No trusted case result is available.",
        tool_result=forged,
    )

    assert result.success is True
    assert step.output_schema is None
    assert "### Required canonical research output" not in services.ai_service.calls[1]["messages"][0]["content"]


def test_late_bound_contract_allows_genuine_inconclusive_prose_reply():
    result, step, services = _late_binding_case(
        second_content="The evidence is insufficient to determine an ictal-onset site.",
        tool_result=_attested_qc_result(),
    )

    assert result.success is True
    assert result.raw_text == "The evidence is insufficient to determine an ictal-onset site."
    assert step.output_schema is None
    assert "### Required canonical research output" in services.ai_service.calls[1]["messages"][0]["content"]


def test_non_completion_release_does_not_launder_a_case_claim():
    assert is_safe_non_completion_reply(
        "The evidence is insufficient to determine an ictal-onset site."
    ) is True
    assert is_safe_non_completion_reply(
        "The evidence is insufficient to determine an ictal-onset site; A1 is where seizures begin."
    ) is False
    assert is_safe_non_completion_reply(
        "The evidence is inconclusive, but there are 12 HFO candidates."
    ) is False
