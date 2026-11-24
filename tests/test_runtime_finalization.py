import asyncio
from types import SimpleNamespace

from runtime.agent_runtime.orchestrator import RuntimeFinalizationResult
from runtime.services.agent_service import AgentService
from runtime.skills.models import ExecutionPlan, ExecutionState, ExecutionStep


def test_agent_service_delegates_advisory_verification_result():
    """Verification is advisory-only: it surfaces a verification event but never
    triggers a reflow plan adjustment. AgentService passes the runtime port's
    result straight through."""
    service = object.__new__(AgentService)

    async def fake_evaluate_runtime_final_answer(
        *,
        conversation_id,
        user_question,
        final_content,
        sources,
        state,
    ):
        assert conversation_id == "conv-1"
        assert user_question == "原始问题"
        assert final_content == "不完整答案"
        assert sources == []
        assert state.get_last_runtime_step().step_id == "s1"
        return RuntimeFinalizationResult(
            final_content=final_content,
            sources=sources,
            verification_event={
                "event": "verification",
                "data": {
                    "verdict": "failure",
                    "reason": "missing key detail",
                },
            },
        )

    service._runtime_port = SimpleNamespace(
        evaluate_runtime_final_answer=fake_evaluate_runtime_final_answer,
    )

    state = ExecutionState(
        conversation_id="conv-1",
        current_turn_id="turn-1",
        plan=ExecutionPlan(
            user_goal="原始问题",
            routing_reason="runtime bootstrap",
            routing_method="runtime_bootstrap",
            steps=[
                ExecutionStep(
                    step_id="s1",
                    skill_name="final_synthesizer",
                    goal="生成最终答案",
                    instructions="生成最终答案。",
                    step_type="synthesis",
                    is_final_step=True,
                )
            ],
        ),
    )

    result = asyncio.run(
        service.evaluate_runtime_final_answer(
            conversation_id="conv-1",
            user_question="原始问题",
            final_content="不完整答案",
            sources=[],
            state=state,
        )
    )

    assert isinstance(result, RuntimeFinalizationResult)
    assert result.verification_event is not None
    assert result.verification_event["data"]["verdict"] == "failure"
    # advisory-only: verification never produces a reflow plan adjustment
    assert result.plan_adjustment is None
