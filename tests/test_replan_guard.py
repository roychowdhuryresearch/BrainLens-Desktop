"""Regression tests for AgentOrchestrator._should_skip_post_step_replanning.

f363f1f 给 agent_control 死循环加了硬上限，但用 total_runtime_steps() vs
len(plan.steps) 的 delta 做 proxy —— 一次 replace_remaining=True 带 ≥3 步就
会把 delta 拉过 2，把合法的大改写误判成循环介入。换成显式计数
PlanAdjustment.source == "agent_control" 后：
  1. 单次 agent_control 用 replace_remaining=True 插入多步 → 不应触发 guard
  2. 3 次连续 agent_control 介入 → 应触发 guard
  3. step_output 来源的 adjustment（非 agent_control）→ 不计入介入次数
"""
from __future__ import annotations

from unittest.mock import MagicMock

from runtime.agent_runtime.orchestrator import AgentOrchestrator, PlanAdjustment
from runtime.skills.models import (
    ExecutionPlan,
    ExecutionState,
    ExecutionStep,
)


def _make_state(num_plan_steps: int = 1) -> ExecutionState:
    steps = [
        ExecutionStep(
            step_id=f"s{i}",
            skill_name="general_assistant",
            goal="",
            instructions="",
            step_type="general",
            is_final_step=(i == num_plan_steps - 1),
        )
        for i in range(num_plan_steps)
    ]
    plan = ExecutionPlan(
        user_goal="",
        routing_reason="",
        routing_method="test",
        steps=steps,
    )
    return ExecutionState(
        conversation_id="c1",
        current_turn_id="t1",
        plan=plan,
    )


def _make_step_result(success: bool = True, waiting_for_input: bool = False):
    out = {"waiting_for_input": True} if waiting_for_input else {}
    result = MagicMock()
    result.success = success
    result.output = out
    return result


def test_replan_guard_not_triggered_by_single_large_replace():
    """合法场景：agent_control 一次性用 replace_remaining=True 塞 5 步。
    按旧的 proxy 实现会把这个误判成 5 > 1+2 → skip。新实现只计 1 次介入 → 不 skip。"""
    state = _make_state(num_plan_steps=1)
    orch = AgentOrchestrator(port=MagicMock())

    adjustment = PlanAdjustment(
        inserted_steps=[
            ExecutionStep(
                step_id=f"new{i}",
                skill_name="general_assistant",
                goal="",
                instructions="",
                step_type="general",
            )
            for i in range(5)
        ],
        replace_remaining=True,
        source="agent_control",
    )
    orch._apply_plan_adjustment(state=state, step_index=0, adjustment=adjustment)
    assert state.agent_control_interventions == 1

    completed_step = state.plan.steps[0]
    skip = AgentOrchestrator._should_skip_post_step_replanning(
        state=state,
        completed_step=completed_step,
        step_result=_make_step_result(),
    )
    assert skip is False, "one agent_control intervention (even a big replace) must not trip the guard"


def test_replan_guard_triggered_after_three_agent_control_interventions():
    state = _make_state(num_plan_steps=1)
    orch = AgentOrchestrator(port=MagicMock())

    for i in range(3):
        adj = PlanAdjustment(
            inserted_steps=[
                ExecutionStep(
                    step_id=f"ac{i}",
                    skill_name="general_assistant",
                    goal="",
                    instructions="",
                    step_type="general",
                )
            ],
            source="agent_control",
        )
        orch._apply_plan_adjustment(state=state, step_index=0, adjustment=adj)

    assert state.agent_control_interventions == 3
    skip = AgentOrchestrator._should_skip_post_step_replanning(
        state=state,
        completed_step=state.plan.steps[0],
        step_result=_make_step_result(),
    )
    assert skip is True


def test_replan_guard_ignores_step_output_adjustments():
    """step_output 来源的 adjustment（step 自己写进 shared_memory 之类）不计入。"""
    state = _make_state(num_plan_steps=1)
    orch = AgentOrchestrator(port=MagicMock())

    for i in range(5):
        adj = PlanAdjustment(
            inserted_steps=[
                ExecutionStep(
                    step_id=f"so{i}",
                    skill_name="general_assistant",
                    goal="",
                    instructions="",
                    step_type="general",
                )
            ],
            source="step_output",
        )
        orch._apply_plan_adjustment(state=state, step_index=0, adjustment=adj)

    assert state.agent_control_interventions == 0
    skip = AgentOrchestrator._should_skip_post_step_replanning(
        state=state,
        completed_step=state.plan.steps[0],
        step_result=_make_step_result(),
    )
    assert skip is False


def test_replan_guard_still_false_on_failed_step_or_waiting_input():
    """失败 / 等用户输入时无论如何都不 skip（守在最前面）。"""
    state = _make_state(num_plan_steps=1)
    state.agent_control_interventions = 5  # 即便计数超了

    assert AgentOrchestrator._should_skip_post_step_replanning(
        state=state,
        completed_step=state.plan.steps[0],
        step_result=_make_step_result(success=False),
    ) is False

    assert AgentOrchestrator._should_skip_post_step_replanning(
        state=state,
        completed_step=state.plan.steps[0],
        step_result=_make_step_result(waiting_for_input=True),
    ) is False
