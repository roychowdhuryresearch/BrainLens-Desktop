from datetime import datetime, timedelta

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from runtime.agent_history.db import Base
from runtime.agent_history.models import AgentConversation, AgentMessage, AgentTurn
from runtime.agent_history.observability_service import AgentObservabilityService


def _build_test_session():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)
    return TestingSessionLocal


def test_list_turns_uses_turn_scoped_final_answer_preview(monkeypatch):
    testing_session = _build_test_session()
    monkeypatch.setattr("runtime.agent_history.observability_service.SessionLocal", testing_session)
    monkeypatch.setattr(AgentObservabilityService, "_resolve_usernames", staticmethod(lambda db, user_ids: {}))

    created_at = datetime(2026, 4, 13, 12, 0, 0)
    db = testing_session()
    try:
        db.add(
            AgentConversation(
                id="conv-1",
                external_conversation_id="conv-1",
                user_id="user-1",
                title="Conversation 1",
                created_at=created_at,
                updated_at=created_at,
            )
        )
        db.add_all(
            [
                AgentTurn(
                    id="turn-1",
                    conversation_id="conv-1",
                    turn_number=1,
                    user_message="question-1",
                    status="completed",
                    created_at=created_at,
                    completed_at=created_at + timedelta(seconds=5),
                ),
                AgentTurn(
                    id="turn-2",
                    conversation_id="conv-1",
                    turn_number=2,
                    user_message="question-2",
                    status="completed",
                    created_at=created_at + timedelta(minutes=1),
                    completed_at=created_at + timedelta(minutes=1, seconds=5),
                ),
                AgentMessage(
                    id="msg-1",
                    conversation_id="conv-1",
                    role="assistant",
                    content="first final answer",
                    created_at=created_at + timedelta(seconds=2),
                ),
                AgentMessage(
                    id="msg-2",
                    conversation_id="conv-1",
                    role="assistant",
                    content="second final answer " + ("x" * 240),
                    created_at=created_at + timedelta(minutes=1, seconds=2),
                ),
            ]
        )
        db.commit()
    finally:
        db.close()

    service = AgentObservabilityService()
    result = service.list_turns(limit=10, offset=0, sort_order="asc")

    assert [row["turn_id"] for row in result["turns"]] == ["turn-1", "turn-2"]
    assert result["turns"][0]["final_answer"] == "first final answer"
    assert result["turns"][1]["final_answer"].startswith("second final answer ")
    assert result["turns"][1]["final_answer"].endswith("...")
    assert len(result["turns"][1]["final_answer"]) == 203


def test_get_turn_detail_returns_full_final_answer(monkeypatch):
    testing_session = _build_test_session()
    monkeypatch.setattr("runtime.agent_history.observability_service.SessionLocal", testing_session)
    monkeypatch.setattr(AgentObservabilityService, "_resolve_usernames", staticmethod(lambda db, user_ids: {}))

    created_at = datetime(2026, 4, 13, 13, 0, 0)
    full_answer = "完整最终答案 " + ("A" * 260)

    db = testing_session()
    try:
        db.add(
            AgentConversation(
                id="conv-2",
                external_conversation_id="conv-2",
                user_id="user-2",
                title="Conversation 2",
                created_at=created_at,
                updated_at=created_at,
            )
        )
        db.add(
            AgentTurn(
                id="turn-detail",
                conversation_id="conv-2",
                turn_number=1,
                user_message="question-detail",
                status="completed",
                created_at=created_at,
                completed_at=created_at + timedelta(seconds=8),
            )
        )
        db.add(
            AgentMessage(
                id="msg-detail",
                conversation_id="conv-2",
                role="assistant",
                content=full_answer,
                created_at=created_at + timedelta(seconds=3),
            )
        )
        db.commit()
    finally:
        db.close()

    service = AgentObservabilityService()
    detail = service.get_turn_detail("turn-detail")

    assert detail is not None
    assert detail["turn"]["final_answer"] == full_answer
