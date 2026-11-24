from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from runtime.agent_history.db import Base
from runtime.agent_history.models import AgentSummary
from runtime.agent_history.summary_repo import SummaryRepository
from runtime.agent_runtime.conversation_state import CONVERSATION_RUNTIME_STATE_KEY, ConversationRuntimeState
from runtime.skills.models import ExecutionPlan, ExecutionState, ExecutionStep


def test_summary_repo_preserves_runtime_state_metadata(monkeypatch):
    engine = create_engine("sqlite://")
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine, tables=[AgentSummary.__table__])
    monkeypatch.setattr("runtime.agent_history.summary_repo.SessionLocal", TestingSessionLocal)

    repo = SummaryRepository()
    repo.save(
        conversation_id="conv-1",
        summary_text="summary",
        summary_turn=1,
        important_facts=["fact-a"],
    )
    repo.save_runtime_state(
        conversation_id="conv-1",
        runtime_state=ConversationRuntimeState(
            conversation_id="conv-1",
            turn_count=2,
            open_goals=["继续处理问题"],
            pending_user_input={"prompt": "请补充项目ID", "input_type": "text"},
        ).to_dict(),
    )
    repo.save(
        conversation_id="conv-1",
        summary_text="summary-2",
        summary_turn=2,
        constraints=["constraint-a"],
    )

    metadata = repo.get_metadata("conv-1")

    assert metadata["important_facts"] == []
    assert metadata["constraints"] == ["constraint-a"]
    assert metadata[CONVERSATION_RUNTIME_STATE_KEY]["turn_count"] == 2
    assert metadata[CONVERSATION_RUNTIME_STATE_KEY]["open_goals"] == ["继续处理问题"]
    assert metadata[CONVERSATION_RUNTIME_STATE_KEY]["pending_user_input"]["prompt"] == "请补充项目ID"


def test_conversation_runtime_state_round_trip():
    payload = ConversationRuntimeState(
        conversation_id="conv-2",
        turn_count=4,
        last_user_goal="继续分析",
        last_final_answer="最终答案",
        open_goals=["补充说明"],
        shared_memory={"s1": {"summary": "已有结果"}},
        pending_actions=[{"action_id": "a2", "step_id": "s2", "goal": "继续"}],
        active_plan_steps=[{"step_id": "s2", "goal": "继续"}],
        pending_user_input={"prompt": "请补充参数", "input_type": "text"},
        last_active_skill_name="analysis_skill",
        skills_executed=["analysis_skill"],
    ).to_dict()

    restored = ConversationRuntimeState.from_dict("conv-2", payload)

    assert restored.turn_count == 4
    assert restored.last_user_goal == "继续分析"
    assert restored.last_final_answer == "最终答案"
    assert restored.open_goals == ["补充说明"]
    assert restored.shared_memory["s1"]["summary"] == "已有结果"
    assert restored.pending_actions[0]["step_id"] == "s2"
    assert restored.active_plan_steps[0]["step_id"] == "s2"
    assert restored.pending_user_input["prompt"] == "请补充参数"
    assert restored.last_active_skill_name == "analysis_skill"


def test_execution_state_syncs_runtime_scratchpad_back_to_plan():
    state = ExecutionState(
        conversation_id="conv-3",
        current_turn_id="turn-3",
        plan=ExecutionPlan(
            user_goal="处理问题",
            routing_reason="test",
            routing_method="fake",
            steps=[
                ExecutionStep(
                    step_id="s1",
                    skill_name="general_assistant",
                    goal="第一步",
                    instructions="do first",
                    step_type="general",
                )
            ],
        ),
    )

    state.apply_runtime_plan_adjustment(
        step_index=0,
        inserted_steps=[
            ExecutionStep(
                step_id="s2",
                skill_name="followup_skill",
                goal="第二步",
                instructions="do second",
                step_type="skill",
            )
        ],
        replace_remaining=False,
    )

    assert state.total_runtime_steps() == 2
    assert [step.step_id for step in state.runtime_steps()] == ["s1", "s2"]
    assert [step.step_id for step in state.plan_view().steps] == ["s1", "s2"]
    assert [step.step_id for step in state.plan.steps] == ["s1"]
    assert state.plan.multi_skill_mode is True
    assert state.plan_view().steps[-1].is_final_step is True
