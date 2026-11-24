import pytest

from runtime.agent_runtime.agent_controller import AgentControlRequest, AgentController
from runtime.skills.models import ExecutionPlan, ExecutionState, ExecutionStep, RoutingResult, StepResult


class _NoLlmServices:
    def __init__(self):
        self.spans = []

    def get_control_ai_service(self):
        raise AssertionError("controller LLM should be skipped for completed optional follow-up answers")

    def extract_usage_metrics(self, payload):
        return (0, 0, 0)

    def record_observability_span(self, **kwargs):
        self.spans.append(kwargs)


@pytest.mark.asyncio
async def test_optional_followup_answer_finishes_without_extra_controller_step():
    step = ExecutionStep(
        step_id="s1",
        skill_name="general_assistant",
        goal="Inspect waveform",
        instructions="Produce a structured handoff result. Do not output the final answer.",
        step_type="general",
        done_when="Produce a structured handoff result.",
    )
    state = ExecutionState(
        conversation_id="desktop-copilot-test",
        current_turn_id="turn-1",
        plan=ExecutionPlan(user_goal="inspect", routing_reason="single step", routing_method="test", steps=[step]),
        skills_executed=["general_assistant"],
    )
    result = StepResult(
        step_id="s1",
        skill_name="general_assistant",
        success=True,
        summary="Visual waveform inspection complete.",
        raw_text=(
            "Based on the displayed waveform, POL ST5 and POL ST6 show sharp high-frequency "
            "transients around the 4-8 second range, while POL ST8 is comparatively flat. "
            "These findings are signal-derived observations for review, not a clinical diagnosis."
        ),
        output={"text": "Visual waveform inspection complete."},
        tool_calls_count=2,
    )
    services = _NoLlmServices()
    controller = AgentController(services)

    adjustment = await controller.decide(AgentControlRequest(
        state=state,
        completed_step=step,
        step_result=result,
        handoff={"summary": result.summary},
        message="Look at the waveform and move the viewport if it helps you see.",
        all_tools=[],
        routing_result=RoutingResult(routing_method="test", planned_order=[]),
    ))

    assert adjustment is None
    assert services.spans[-1]["status"] == "skipped"
    assert services.spans[-1]["metadata"]["action"] == "finish"


@pytest.mark.asyncio
async def test_final_verdict_answer_finishes_even_with_intermediate_template():
    step = ExecutionStep(
        step_id="s1",
        skill_name="eeg-result-interpretation",
        goal="Interpret HFO results",
        instructions="Produce a structured handoff result. Do not output the final answer.",
        step_type="skill",
        done_when="Produce a structured handoff result.",
    )
    state = ExecutionState(
        conversation_id="desktop-copilot-test",
        current_turn_id="turn-2",
        plan=ExecutionPlan(user_goal="final verdict", routing_reason="single step", routing_method="test", steps=[step]),
        skills_executed=["eeg-result-interpretation"],
        open_goals=["Identify the strongest HFO generator channels"],
    )
    result = StepResult(
        step_id="s1",
        skill_name="eeg-result-interpretation",
        success=True,
        summary="Final verdict: recording is suitable and POL ST5/ST6 are the strongest channels.",
        raw_text=(
            "Final verdict: this recording is suitable for HFO analysis. The sampling rate and "
            "Nyquist limit support the configured HFO band, detection produced reviewable events, "
            "and the strongest HFO generator channels are POL ST5 and POL ST6 based on the observed "
            "event distribution and visual bursts. Human review is still required before clinical use."
        ),
        output={"text": "Final verdict complete."},
        tool_calls_count=3,
    )
    services = _NoLlmServices()
    controller = AgentController(services)

    adjustment = await controller.decide(AgentControlRequest(
        state=state,
        completed_step=step,
        step_result=result,
        handoff={"summary": result.summary},
        message="Decide whether this recording is suitable and which channels are strongest.",
        all_tools=[],
        routing_result=RoutingResult(routing_method="test", planned_order=[]),
    ))

    assert adjustment is None
    assert services.spans[-1]["status"] == "skipped"
    assert services.spans[-1]["metadata"]["action"] == "finish"


@pytest.mark.asyncio
async def test_hitl_staged_ui_command_finishes_without_apply_step():
    step = ExecutionStep(
        step_id="s1",
        skill_name="general_assistant",
        goal="Stage event annotation",
        instructions="Produce a structured handoff result. Do not output the final answer.",
        step_type="general",
        done_when="Produce a structured handoff result.",
    )
    state = ExecutionState(
        conversation_id="desktop-copilot-test",
        current_turn_id="turn-3",
        plan=ExecutionPlan(user_goal="annotate first event", routing_reason="single step", routing_method="test", steps=[step]),
        skills_executed=["general_assistant"],
    )
    result = StepResult(
        step_id="s1",
        skill_name="general_assistant",
        success=True,
        summary="The annotation for the first detected HFO event has been staged for your approval.",
        raw_text=(
            "The annotation for the first detected HFO event has been staged for your approval. "
            "Label: confirmed HFO (accepted). The annotation is queued and waiting for you to Apply in the UI."
        ),
        output={"text": "The annotation is queued and waiting for you to Apply in the UI."},
        tool_calls_count=2,
    )
    services = _NoLlmServices()
    controller = AgentController(services)

    adjustment = await controller.decide(AgentControlRequest(
        state=state,
        completed_step=step,
        step_result=result,
        handoff={"summary": result.summary},
        message="Annotate the first detected event as a confirmed HFO for review.",
        all_tools=[],
        routing_result=RoutingResult(routing_method="test", planned_order=[]),
    ))

    assert adjustment is None
    assert services.spans[-1]["status"] == "skipped"
    assert services.spans[-1]["metadata"]["action"] == "finish"
