"""Regression coverage for runtime context, planning, tool calls and synthesis."""

import asyncio

import pytest

from runtime.context.manager import ContextManager
from runtime.context.noise_filter import is_low_value_message
from runtime.agent_runtime.orchestrator import AgentOrchestrator, PlanAdjustment
from runtime.agent_runtime.prompt_assembly import PromptAssemblyService
from runtime.skills.models import ExecutionPlan, ExecutionState, ExecutionStep, StepResult


def _make_step(step_id, *, is_final=False):
    return ExecutionStep(
        step_id=step_id,
        skill_name="some_skill",
        goal="goal",
        instructions="do it.",
        step_type="action",
        is_final_step=is_final,
    )


def _state_with_steps(n):
    steps = [_make_step(f"s{i}", is_final=(i == n - 1)) for i in range(n)]
    return ExecutionState(
        conversation_id="c",
        current_turn_id="t",
        plan=ExecutionPlan(
            user_goal="g",
            routing_reason="r",
            routing_method="runtime_bootstrap",
            steps=steps,
        ),
    )


# ---------------------------------------------------------------------------
# Recent-turns window must not collapse to [] on repeated prompts.
# ---------------------------------------------------------------------------

def test_recent_turns_survives_repeated_identical_prompts():
    """The old content-prefix `set()` matcher returned an EMPTY window when the
    recent turns shared first-100-char prefixes (e.g. a clinician repeating
    "继续" / "重新检测"), because `found_count` could never reach `keep_count`.
    The positional rewrite must always return the recent tail instead."""
    manager = ContextManager.__new__(ContextManager)  # no ai_service needed for this method

    # 8 turns of byte-identical prompts+replies → prefixes collapse to 2 entries.
    messages = []
    for _ in range(8):
        messages.append({"role": "user", "content": "重新检测一下这个录音的 HFO"})
        messages.append({"role": "assistant", "content": "好的，已经完成检测。"})

    recent = manager._get_recent_turns(messages, keep_turns=3)

    # keep_turns=3 → keep_count=6 most-recent user/assistant messages.
    assert recent != [], "recent window collapsed to [] (the bug)"
    assert len(recent) == 6
    assert recent == messages[-6:]


def test_recent_turns_returns_all_when_below_keep_count():
    manager = ContextManager.__new__(ContextManager)
    messages = [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "hello"},
    ]
    assert manager._get_recent_turns(messages, keep_turns=3) == messages


def test_output_rewrites_only_configured_terms():
    from runtime.agent_runtime.output_utils import sanitize_content

    message = "The study documents include the channel map."
    assert sanitize_content(message) == message
    assert sanitize_content(message, [("channel map", "montage")]) == "The study documents include the montage."


# ---------------------------------------------------------------------------
# Failed/empty steps must not be treated as synthesis evidence.
# ---------------------------------------------------------------------------

def _step(*, summary="", raw_text="", sources=None, output=None):
    return StepResult(
        step_id="s1",
        skill_name="hfo_detection_skill",
        success=bool(raw_text),
        summary=summary,
        output=output or {},
        raw_text=raw_text,
        sources=sources or [],
    )


def test_synthesis_evidence_gate_truth_table():
    gate = PromptAssemblyService._step_result_has_synthesis_evidence

    assert gate(None) is False
    # Empty step whose only "content" is the placeholder summary → NOT evidence.
    assert gate(_step(summary="hfo_detection_skill produced no text result")) is False
    # Real answer text → evidence.
    assert gate(_step(raw_text="HFO rate is highest in channels A1-A3.")) is True
    # Failed steps never become synthesis evidence, even if they contain stale
    # sources or structured fragments.
    assert gate(_step(sources=[{"doc_id": "d1"}])) is False
    assert gate(_step(output={"text": "结构化结果"})) is False
    # The same artifacts count only when the owning step succeeded.
    successful_source = _step(sources=[{"doc_id": "d1"}])
    successful_source.success = True
    assert gate(successful_source) is True
    successful_structured = _step(output={"text": "结构化结果"})
    successful_structured.success = True
    assert gate(successful_structured) is True


def test_compose_final_answer_does_not_leak_empty_step_placeholder():
    """A single step that produced no text must yield the honest "no answer"
    string, never the internal "<skill> produced no text result" placeholder."""
    step = ExecutionStep(
        step_id="s1",
        skill_name="hfo_detection_skill",
        goal="检测 HFO",
        instructions="检测 HFO。",
        step_type="action",
        is_final_step=True,
    )
    state = ExecutionState(
        conversation_id="c",
        current_turn_id="t",
        plan=ExecutionPlan(
            user_goal="检测 HFO",
            routing_reason="runtime bootstrap",
            routing_method="runtime_bootstrap",
            steps=[step],
        ),
    )
    state.step_results["s1"] = _step(summary="hfo_detection_skill produced no text result")

    result = asyncio.run(PromptAssemblyService().compose_final_answer_from_state(state))

    assert "produced no text result" not in result["content"]
    assert result["content"] == "No final answer was generated"


# ---------------------------------------------------------------------------
# Replan next_step_index must never move backward and
# re-run already-completed (non-idempotent) steps.
# ---------------------------------------------------------------------------

def test_plan_adjustment_never_moves_backward_even_with_inserts():
    orch = AgentOrchestrator.__new__(AgentOrchestrator)
    state = _state_with_steps(3)  # s0, s1, s2

    # Just finished step 1; a replan inserts a step but (untrusted) asks to jump
    # back to index 0. Must clamp the floor to insertion_index (2), not honor 0.
    adj = PlanAdjustment(
        inserted_steps=[_make_step("inserted")],
        next_step_index=0,
    )
    result = orch._apply_plan_adjustment(state=state, step_index=1, adjustment=adj)
    assert result >= 2, "execution moved backward into already-completed steps"
    assert result == 2


def test_plan_adjustment_clamps_forward_overshoot_to_plan_end():
    orch = AgentOrchestrator.__new__(AgentOrchestrator)
    state = _state_with_steps(3)
    adj = PlanAdjustment(next_step_index=99)
    result = orch._apply_plan_adjustment(state=state, step_index=1, adjustment=adj)
    assert result == state.total_runtime_steps()


def test_plan_adjustment_none_index_continues_after_current_step():
    orch = AgentOrchestrator.__new__(AgentOrchestrator)
    state = _state_with_steps(3)
    adj = PlanAdjustment(next_step_index=None)
    result = orch._apply_plan_adjustment(state=state, step_index=1, adjustment=adj)
    assert result == 2


# ---------------------------------------------------------------------------
# A user question that mentions an error must not be
# filtered out of the context window as an "error trace".
# ---------------------------------------------------------------------------

def test_noise_filter_keeps_user_error_questions():
    user_q = {"role": "user", "content": "为什么检测失败了？error: detection returned 0 events"}
    assert is_low_value_message(user_q) is False

    # But an assistant/tool error echo is still filtered.
    assert is_low_value_message({"role": "assistant", "content": "工具调用失败"}) is True


# ---------------------------------------------------------------------------
# Malformed tool-call arguments must be rejected with a
# structured error, never coerced to {} and executed.
# ---------------------------------------------------------------------------

def test_parse_tool_arguments_truth_table():
    from runtime.agent_runtime.tool_executor import parse_tool_arguments as parse

    # Well-formed / empty / already-dict → no error.
    assert parse('{"a": 1}') == ({"a": 1}, None)
    assert parse("") == ({}, None)
    assert parse("{}") == ({}, None)
    assert parse(None) == ({}, None)
    assert parse({"already": "dict"}) == ({"already": "dict"}, None)

    # Malformed / truncated JSON → (None, error).
    parsed, err = parse('{"query": "bad')  # truncated
    assert parsed is None and err and "valid JSON" in err
    parsed, err = parse("{not json}")
    assert parsed is None and err

    # Valid JSON but not an object → (None, error).
    parsed, err = parse("[1, 2, 3]")
    assert parsed is None and "JSON object" in err
    parsed, err = parse(123)
    assert parsed is None and err


# ---------------------------------------------------------------------------
# Empty/unexpanded api_key must fail fast with a clear error.
# ---------------------------------------------------------------------------

def test_ensure_api_key_rejects_empty_and_placeholder():
    from types import SimpleNamespace
    from runtime.services.ai_service import AIService

    fake = SimpleNamespace(config=SimpleNamespace(api_key="", model="glm-4"))
    with pytest.raises(ValueError):
        AIService._ensure_api_key(fake)

    fake.config.api_key = "${DASHSCOPE_API_KEY}"  # unexpanded placeholder
    with pytest.raises(ValueError):
        AIService._ensure_api_key(fake)

    fake.config.api_key = "test-only-key"  # valid → no raise
    AIService._ensure_api_key(fake)
