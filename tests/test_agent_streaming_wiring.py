"""Offline tests for the live-streaming wiring (no network).

Covers the two new pieces:
  - StepExecutor._stream_chat forwards content deltas as live `content` events
    and returns the assembled response + streamed text.
  - RuntimeFinalOutputCoordinator.emit_final_content_and_done skips a body that
    was already streamed live, emitting only the un-streamed tail (and falling
    back to the full body on any mismatch).
"""
import asyncio
from datetime import datetime
from types import SimpleNamespace

import pytest

from runtime.agent_runtime.clinical_evidence import ResearchOutputContractError
from runtime.agent_runtime.final_output import RuntimeFinalOutputCoordinator
from runtime.agent_runtime.planning_policy import RuntimePlanningPolicy
from runtime.agent_runtime.prompt_assembly import PromptAssemblyService
from runtime.agent_runtime.step_executor import StepExecutionRequest, StepExecutor
from runtime.skills.models import (
    ExecutionPlan,
    ExecutionState,
    ExecutionStep,
    RoutingResult,
)


async def _collect(agen):
    return [event async for event in agen]


class _FakeStreamingAIService:
    def __init__(self, content_pieces, final_response):
        self._pieces = content_pieces
        self._final = final_response

    async def chat_stream(self, messages, tools=None, **kwargs):
        for piece in self._pieces:
            yield {"type": "content", "text": piece}
        yield {"type": "final", "response": self._final}


def test_stream_chat_forwards_content_live_and_returns_response():
    svc = _FakeStreamingAIService(
        ["Hel", "lo"],
        {"content": "Hello", "tool_calls": None, "model_used": "qwen"},
    )
    ex = object.__new__(StepExecutor)
    ex.services = SimpleNamespace(ai_service=svc)

    seen = []

    async def callback(event):
        seen.append(event)

    response, streamed_text = asyncio.run(
        ex._stream_chat([{"role": "user", "content": "hi"}], [], {}, callback)
    )

    assert streamed_text == "Hello"
    assert response["content"] == "Hello"
    assert [e for e in seen if e["event"] == "content"] == [
        {"event": "content", "data": {"text": "Hel"}},
        {"event": "content", "data": {"text": "lo"}},
    ]


def test_structured_final_output_is_buffered_until_contract_validation():
    prose = ExecutionStep(
        step_id="prose",
        skill_name="general_assistant",
        goal="answer",
        instructions="answer",
        is_final_step=True,
    )
    structured = ExecutionStep(
        step_id="research",
        skill_name="final_synthesizer",
        goal="produce research output",
        instructions="produce research output",
        is_final_step=True,
        output_schema={"type": "object"},
    )
    assert StepExecutor._allows_live_final_content(prose) is True
    assert StepExecutor._allows_live_final_content(structured) is False


class _IntentStreamingAI:
    config = SimpleNamespace(provider="test", model="test")

    def __init__(self, content):
        self.content = content
        self.stream_called = False
        self.chat_called = False

    async def chat(self, messages, tools=None, **kwargs):
        del messages, tools, kwargs
        self.chat_called = True
        return {
            "content": self.content,
            "model_used": "test-model",
            "usage": {"total_tokens": 4},
        }

    async def chat_stream(self, messages, tools=None, **kwargs):
        del messages, tools, kwargs
        self.stream_called = True
        midpoint = max(1, len(self.content) // 2)
        yield {"type": "content", "text": self.content[:midpoint]}
        yield {"type": "content", "text": self.content[midpoint:]}
        yield {
            "type": "final",
            "response": {
                "content": self.content,
                "model_used": "test-model",
                "usage": {"total_tokens": 4},
            },
        }


class _NoopCompressor:
    async def compress_messages_if_needed(self, messages):
        return messages


class _StreamingServices:
    def __init__(self, content):
        self.ai_service = _IntentStreamingAI(content)
        self.planning_policy = RuntimePlanningPolicy()
        self.prompt_assembly = PromptAssemblyService()
        self.postprocess = SimpleNamespace()
        self.tool_executor = SimpleNamespace()
        self.message_compressor = _NoopCompressor()

    @staticmethod
    def extract_usage_metrics(payload):
        del payload
        return 0, 0, 4

    @staticmethod
    def record_observability_span(**kwargs):
        del kwargs

    @staticmethod
    def is_cancelled(conversation_id):
        del conversation_id
        return False


def _streaming_request(*, user_message, content, event_callback):
    step = ExecutionStep(
        step_id="final",
        skill_name="general_assistant",
        goal="Answer the user.",
        instructions="Answer directly.",
        step_type="general",
        is_final_step=True,
    )
    state = ExecutionState(
        conversation_id="conv-stream-contract",
        current_turn_id="turn-stream-contract",
        request_id="req-stream-contract",
        message_id="msg-stream-contract",
        response_language="en-US",
        plan=ExecutionPlan(
            user_goal=user_message,
            routing_reason="test",
            routing_method="test",
            steps=[step],
        ),
    )
    services = _StreamingServices(content)
    request = StepExecutionRequest(
        step=step,
        state=state,
        message=user_message,
        history=[],
        knowledge_base_id=None,
        all_tools=[],
        base_context_pack=None,
        routing_result=RoutingResult(),
        event_callback=event_callback,
    )
    result, *_ = asyncio.run(StepExecutor(services).execute(request))
    return result, state, services


def test_case_intent_buffers_unsafe_claim_until_terminal_rejection(monkeypatch):
    monkeypatch.setenv("IEEG_AGENT_STREAM", "1")
    public_events = []

    async def on_event(event):
        public_events.append(event)

    unsafe_claim = "A1 is where seizures begin."
    result, state, services = _streaming_request(
        user_message="Which lead starts seizures in this case?",
        content=unsafe_claim,
        event_callback=on_event,
    )

    assert services.ai_service.chat_called is True
    assert services.ai_service.stream_called is False
    assert [event for event in public_events if event.get("event") == "content"] == []

    state.step_results["final"] = result
    coordinator = object.__new__(RuntimeFinalOutputCoordinator)
    with pytest.raises(ResearchOutputContractError):
        asyncio.run(
            coordinator.evaluate_runtime_final_answer(
                conversation_id=state.conversation_id,
                user_question="Which lead starts seizures in this case?",
                final_content=result.raw_text,
                sources=[],
                state=state,
            )
        )
    assert [event for event in public_events if event.get("event") == "content"] == []


def test_generic_clinical_education_can_still_stream(monkeypatch):
    monkeypatch.setenv("IEEG_AGENT_STREAM", "1")
    public_events = []

    async def on_event(event):
        public_events.append(event)

    content = "SOZ means seizure-onset zone."
    result, _, services = _streaming_request(
        user_message="What is SOZ?",
        content=content,
        event_callback=on_event,
    )

    assert result.success is True
    assert services.ai_service.stream_called is True
    assert services.ai_service.chat_called is False
    assert "".join(
        event["data"]["text"]
        for event in public_events
        if event.get("event") == "content"
    ) == content


def _emit(
    coord,
    *,
    final_content,
    already_streamed,
    action_receipts=None,
    research_output=None,
):
    return asyncio.run(
        _collect(
            coord.emit_final_content_and_done(
                final_content=final_content,
                conversation_id="c",
                active_skill_name_result=None,
                skill_reason="",
                routing_result=None,
                total_iterations=1,
                request_start_time=datetime.now(),
                sources=[],
                success_result={"message_id": "m", "model_used": "x"},
                ui_commands=[],
                action_receipts=action_receipts,
                research_output=research_output,
                already_streamed=already_streamed,
            )
        )
    )


def _content_text(events):
    return "".join(e["data"]["text"] for e in events if e["event"] == "content")


def _make_coord():
    coord = object.__new__(RuntimeFinalOutputCoordinator)
    coord._resolve_sanitize_replacements = lambda: []
    return coord


def test_emit_final_skips_streamed_body_emits_only_tail():
    coord = _make_coord()
    body = "HFO are a biomarker of the epileptogenic zone."
    disclaimer = "\n\n(Note: this may not fully cover your question.)"
    events = _emit(coord, final_content=body + disclaimer, already_streamed=body)
    assert _content_text(events) == disclaimer   # body NOT re-emitted
    assert any(e["event"] == "done" for e in events)


def test_emit_final_with_no_streamed_content_emits_full_body():
    coord = _make_coord()
    body = "HFO are a biomarker of the epileptogenic zone."
    events = _emit(coord, final_content=body, already_streamed="")
    assert _content_text(events) == body


def test_emit_final_falls_back_to_full_body_on_prefix_mismatch():
    coord = _make_coord()
    body = "HFO are a biomarker of the epileptogenic zone."
    events = _emit(coord, final_content=body, already_streamed="something unrelated")
    assert _content_text(events) == body   # mismatch => safe full re-emit


def test_emit_final_tail_skip_is_strip_tolerant():
    # The streamed raw text has trailing whitespace; the final body is
    # whitespace-cleaned (strip) then has a disclaimer appended. The hardened
    # match must still recognize the body and emit only the tail.
    coord = _make_coord()
    streamed = "HFO are a biomarker of the epileptogenic zone.\n\n"   # raw, trailing ws
    disclaimer = "(Note: this may not fully cover your question.)"
    final = streamed.strip() + "\n\n" + disclaimer                    # cleaned body + tail
    events = _emit(coord, final_content=final, already_streamed=streamed)
    assert _content_text(events) == "\n\n" + disclaimer               # body NOT re-emitted


def test_emit_final_done_carries_only_validated_research_output_and_receipts():
    coord = _make_coord()
    research_output = {"schema_version": "research-output.v1", "output_id": "output-1"}
    receipts = [{"receipt_id": "receipt-1", "status": "complete"}]
    events = _emit(
        coord,
        final_content="Evidence ready.",
        already_streamed="",
        action_receipts=receipts,
        research_output=research_output,
    )
    done = next(event for event in events if event["event"] == "done")
    assert done["data"]["research_output"] == research_output
    assert done["data"]["action_receipts"] == receipts
