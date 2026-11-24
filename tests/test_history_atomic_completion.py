from __future__ import annotations

import json

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker

from runtime.agent_history.db import Base, _ensure_agent_message_metadata_column
from runtime.agent_history.models import (
    AGENT_MESSAGE_AUDIT_SCHEMA_VERSION,
    AgentConversation,
    AgentMessage,
    AgentTurn,
)
from runtime.agent_history.service import AgentHistoryService


def _database(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'history.db'}")
    Base.metadata.create_all(bind=engine)
    factory = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    with factory() as db:
        db.add(AgentConversation(id="conv-1", user_id="doctor-1", title="case"))
        db.add(
            AgentTurn(
                id="turn-1",
                conversation_id="conv-1",
                turn_number=1,
                user_message="summarize",
                status="running",
            )
        )
        db.commit()
    return factory


def _receipt():
    observed = {"operation_id_sha256": "f" * 64}
    return {
        "contract_version": "ieeg-agent.v1",
        "receipt_id": "receipt-1",
        "request_id": "req-1",
        "conversation_id": "conv-1",
        "command_id": "command-1",
        "command_type": "analysis.run_qc",
        "status": "complete",
        "terminal": True,
        "success": True,
        "occurred_at": "2026-07-15T18:01:00Z",
        "effect": "analysis",
        "requires_confirmation": False,
        "state_revision": "desktop-state-1",
        "owner": "desktop.detection",
        "research_impact": "research_output",
        "idempotency": {
            "mode": "deduplicate_by_key",
            "key_scope": "command_type_and_payload",
            "key_supplied": False,
        },
        "retry": {"mode": "same_key_only", "max_attempts": 2, "backoff_ms": 1000},
        "timeout_seconds": 300,
        "approval_role": "none",
        "affected_resources": ["detection_runs", "analysis_state"],
        "postcondition_name": "compute_result_and_run_provenance_are_recorded",
        "data_sensitivity": "research_derived",
        "provenance": {
            "source": "mcp",
            "payload_sha256": "a" * 64,
            "command_effect": "analysis.run_qc",
            "effect_class": "derived_analysis",
        },
        "transitions": [
            {
                "sequence": 1,
                "from": "running",
                "to": "complete",
                "observed_at": "2026-07-15T18:01:00Z",
                "source": "renderer_ack",
                "state_revision": "desktop-state-1",
                "conversation_id": "conv-1",
                "evidence_sha256": "e" * 64,
            }
        ],
        "transition_count": 2,
        "created_at": "2026-07-15T18:00:00Z",
        "result": {"observed": observed},
        "postcondition": {
            "name": "compute_result_and_run_provenance_are_recorded",
            "state_revision": "desktop-state-1",
            "verified": True,
            "observed_at": "2026-07-15T18:01:00Z",
            "source": "backend",
            "evidence": observed,
        },
    }


def _research_output():
    return {
        "schema_version": "research-output.v1",
        "output_id": "output-1",
        "message_id": "msg-preallocated-1",
        "request_id": "req-1",
        "conversation_id": "conv-1",
        "state_revision": "desktop-state-1",
        "summary": "One candidate run was produced for review.",
    }


def test_message_and_completed_turn_commit_as_one_transaction(tmp_path, monkeypatch):
    factory = _database(tmp_path)
    monkeypatch.setattr("runtime.agent_history.service.SessionLocal", factory)
    monkeypatch.setattr("runtime.agent_history.message_repo.SessionLocal", factory)

    result = AgentHistoryService().persist_turn_completion_atomic(
        conversation_id="conv-1",
        turn_id="turn-1",
        status="completed",
        final_content="Evidence-linked answer.",
        total_iterations=2,
        model_used="test-model",
        tokens_used=12,
        sources=[{"url": "https://example.invalid/source"}],
        message_id="msg-preallocated-1",
        request_id="req-1",
        state_revision="desktop-state-1",
        action_receipts=[_receipt()],
        research_output=_research_output(),
    )

    assert result["message"]["id"] == "msg-preallocated-1"
    assert result["message"]["message_id"] == "msg-preallocated-1"
    assert result["message"]["role"] == "assistant"
    assert result["message"]["metadata"]["schema_version"] == AGENT_MESSAGE_AUDIT_SCHEMA_VERSION
    assert result["message"]["metadata"]["message_id"] == "msg-preallocated-1"
    assert result["message"]["metadata"]["conversation_id"] == "conv-1"
    assert result["message"]["metadata"]["request_id"] == "req-1"
    assert result["message"]["metadata"]["state_revision"] == "desktop-state-1"
    assert result["message"]["completion_turn_id"] == "turn-1"
    assert result["message"]["action_receipts"] == [_receipt()]
    assert result["message"]["research_output"] == _research_output()
    assert result["turn"]["status"] == "completed"
    with factory() as db:
        assert db.query(AgentMessage).count() == 1
        assert db.get(AgentTurn, "turn-1").status == "completed"

    history = AgentHistoryService()
    recovered = history.get_conversation_messages("conv-1")
    recent = history.get_recent_messages("conv-1")
    assert recovered[0]["message_id"] == "msg-preallocated-1"
    assert recovered[0]["action_receipts"] == [_receipt()]
    assert recovered[0]["research_output"] == _research_output()
    assert recent[0]["action_receipts"] == recovered[0]["action_receipts"]
    assert recent[0]["research_output"] == recovered[0]["research_output"]


def test_commit_failure_rolls_back_both_message_and_turn(tmp_path, monkeypatch):
    factory = _database(tmp_path)

    class FailingCommitSession:
        def __init__(self):
            self._inner = factory()

        def __getattr__(self, name):
            return getattr(self._inner, name)

        def commit(self):
            raise RuntimeError("simulated commit failure")

    monkeypatch.setattr(
        "runtime.agent_history.service.SessionLocal",
        FailingCommitSession,
    )

    with pytest.raises(RuntimeError, match="simulated commit failure"):
        AgentHistoryService().persist_turn_completion_atomic(
            conversation_id="conv-1",
            turn_id="turn-1",
            status="completed",
            final_content="Must not survive.",
            message_id="msg-preallocated-1",
            request_id="req-1",
            state_revision="desktop-state-1",
            action_receipts=[_receipt()],
            research_output=_research_output(),
        )

    with factory() as db:
        assert db.query(AgentMessage).count() == 0
        assert db.get(AgentTurn, "turn-1").status == "running"


def test_ack_serialization_failure_happens_before_commit(tmp_path, monkeypatch):
    factory = _database(tmp_path)
    monkeypatch.setattr("runtime.agent_history.service.SessionLocal", factory)

    def fail_before_commit(_message):
        raise RuntimeError("simulated ack serialization failure")

    monkeypatch.setattr(AgentMessage, "to_dict", fail_before_commit)
    with pytest.raises(RuntimeError, match="ack serialization failure"):
        AgentHistoryService().persist_turn_completion_atomic(
            conversation_id="conv-1",
            turn_id="turn-1",
            status="completed",
            final_content="Must not survive.",
            message_id="msg-preallocated-1",
            request_id="req-1",
            state_revision="desktop-state-1",
            action_receipts=[_receipt()],
            research_output=_research_output(),
        )

    with factory() as db:
        assert db.query(AgentMessage).count() == 0
        assert db.get(AgentTurn, "turn-1").status == "running"


def test_success_path_has_no_fallible_post_commit_refresh(tmp_path, monkeypatch):
    factory = _database(tmp_path)

    class RefreshForbiddenSession:
        def __init__(self):
            self._inner = factory()

        def __getattr__(self, name):
            return getattr(self._inner, name)

        def refresh(self, _value):
            raise AssertionError("refresh must not run after commit")

    monkeypatch.setattr("runtime.agent_history.service.SessionLocal", RefreshForbiddenSession)
    result = AgentHistoryService().persist_turn_completion_atomic(
        conversation_id="conv-1",
        turn_id="turn-1",
        status="completed",
        final_content="Durable answer.",
        message_id="msg-preallocated-1",
        request_id="req-1",
        state_revision="desktop-state-1",
        action_receipts=[_receipt()],
        research_output=_research_output(),
    )

    assert result["message"]["message_id"] == "msg-preallocated-1"
    with factory() as db:
        assert db.query(AgentMessage).count() == 1
        assert db.get(AgentTurn, "turn-1").status == "completed"


def test_completed_turn_cannot_be_rewritten_as_failed(tmp_path, monkeypatch):
    factory = _database(tmp_path)
    monkeypatch.setattr("runtime.agent_history.service.SessionLocal", factory)
    history = AgentHistoryService()
    history.persist_turn_completion_atomic(
        conversation_id="conv-1",
        turn_id="turn-1",
        status="completed",
        final_content="Durable answer.",
        message_id="msg-preallocated-1",
        request_id="req-1",
        state_revision="desktop-state-1",
        action_receipts=[_receipt()],
        research_output=_research_output(),
    )

    with pytest.raises(ValueError, match="turn_terminal_transition_forbidden"):
        history.persist_turn_completion_atomic(
            conversation_id="conv-1",
            turn_id="turn-1",
            status="failed",
            error_message="late transport failure",
        )

    with factory() as db:
        assert db.query(AgentMessage).count() == 1
        assert db.get(AgentTurn, "turn-1").status == "completed"


def test_additive_metadata_migration_keeps_legacy_rows_readable(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'legacy-history.db'}")
    with engine.begin() as connection:
        connection.execute(
            text(
                """
                CREATE TABLE agent_messages (
                    id VARCHAR(64) PRIMARY KEY,
                    conversation_id VARCHAR(64),
                    role VARCHAR(16),
                    content TEXT,
                    name VARCHAR(128),
                    tool_call_id VARCHAR(128),
                    sources TEXT,
                    created_at DATETIME
                )
                """
            )
        )
        connection.execute(
            text(
                "INSERT INTO agent_messages "
                "(id, conversation_id, role, content, name, tool_call_id, sources) "
                "VALUES ('legacy-msg', 'legacy-conv', 'assistant', 'legacy answer', '', '', NULL)"
            )
        )

    _ensure_agent_message_metadata_column(engine)

    assert "metadata_json" in {
        str(column["name"]) for column in inspect(engine).get_columns("agent_messages")
    }
    factory = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    with factory() as db:
        recovered = db.get(AgentMessage, "legacy-msg").to_dict()
    assert recovered["message_id"] == "legacy-msg"
    assert recovered["metadata"] == {}
    assert recovered["completion_turn_id"] is None
    assert recovered["action_receipts"] == []
    assert recovered["research_output"] is None


def test_invalid_nonterminal_receipt_rolls_back_message_and_turn(tmp_path, monkeypatch):
    factory = _database(tmp_path)
    monkeypatch.setattr("runtime.agent_history.service.SessionLocal", factory)

    with pytest.raises(ValueError, match="terminal_action_receipt_invalid"):
        AgentHistoryService().persist_turn_completion_atomic(
            conversation_id="conv-1",
            turn_id="turn-1",
            status="completed",
            final_content="Must not survive.",
            action_receipts=[{**_receipt(), "terminal": False, "status": "running"}],
        )

    with factory() as db:
        assert db.query(AgentMessage).count() == 0
        assert db.get(AgentTurn, "turn-1").status == "running"


@pytest.mark.parametrize(
    "receipt",
    [
        {**_receipt(), "conversation_id": "conv-other"},
        {
            **_receipt(),
            "status": "applied",
            "effect": "compute",
            "terminal": True,
        },
        {key: value for key, value in _receipt().items() if key != "postcondition"},
    ],
    ids=["cross-conversation", "applied-compute", "missing-proof"],
)
def test_noncanonical_or_cross_scope_terminal_receipts_roll_back(tmp_path, monkeypatch, receipt):
    factory = _database(tmp_path)
    monkeypatch.setattr("runtime.agent_history.service.SessionLocal", factory)

    with pytest.raises(ValueError, match="terminal_action_receipt_invalid"):
        AgentHistoryService().persist_turn_completion_atomic(
            conversation_id="conv-1",
            turn_id="turn-1",
            status="completed",
            final_content="Must not survive.",
            message_id="msg-preallocated-1",
            request_id="req-1",
            state_revision="desktop-state-1",
            action_receipts=[receipt],
        )

    with factory() as db:
        assert db.query(AgentMessage).count() == 0
        assert db.get(AgentTurn, "turn-1").status == "running"


def test_terminal_audit_history_rejects_instead_of_mutating_sensitive_evidence(
    tmp_path,
    monkeypatch,
):
    factory = _database(tmp_path)
    monkeypatch.setattr("runtime.agent_history.service.SessionLocal", factory)
    unsafe_receipt = {
        **_receipt(),
    }
    unsafe_observed = {
        "output_path": "/private/cases/patient-17/result.json",
        "credential": "sk-secret-token-value",
    }
    unsafe_receipt["result"] = {"observed": unsafe_observed}
    unsafe_receipt["postcondition"] = {
        **unsafe_receipt["postcondition"],
        "evidence": unsafe_observed,
    }
    unsafe_output = {
        **_research_output(),
        "summary": "MRN=123456 should never be serialized verbatim.",
    }

    with pytest.raises(ValueError, match="terminal_audit_metadata_unsafe"):
        AgentHistoryService().persist_turn_completion_atomic(
            conversation_id="conv-1",
            turn_id="turn-1",
            status="completed",
            final_content="Safe answer.",
            message_id="msg-preallocated-1",
            request_id="req-1",
            state_revision="desktop-state-1",
            action_receipts=[unsafe_receipt],
            research_output=unsafe_output,
        )

    with factory() as db:
        assert db.query(AgentMessage).count() == 0
        assert db.get(AgentTurn, "turn-1").status == "running"


def test_research_output_message_scope_mismatch_rolls_back(tmp_path, monkeypatch):
    factory = _database(tmp_path)
    monkeypatch.setattr("runtime.agent_history.service.SessionLocal", factory)

    with pytest.raises(ValueError, match="research_output_message_scope_mismatch"):
        AgentHistoryService().persist_turn_completion_atomic(
            conversation_id="conv-1",
            turn_id="turn-1",
            status="completed",
            final_content="Must not survive.",
            message_id="msg-expected",
            request_id="req-1",
            state_revision="desktop-state-1",
            research_output={**_research_output(), "message_id": "msg-other"},
        )

    with factory() as db:
        assert db.query(AgentMessage).count() == 0
        assert db.get(AgentTurn, "turn-1").status == "running"


@pytest.mark.parametrize(
    ("field", "value", "error"),
    [
        ("conversation_id", "conv-other", "research_output_conversation_scope_mismatch"),
        ("request_id", "req-other", "research_output_request_scope_mismatch"),
        ("state_revision", "desktop-state-other", "research_output_state_scope_mismatch"),
    ],
)
def test_research_output_active_turn_scope_mismatch_rolls_back(
    tmp_path,
    monkeypatch,
    field,
    value,
    error,
):
    factory = _database(tmp_path)
    monkeypatch.setattr("runtime.agent_history.service.SessionLocal", factory)

    with pytest.raises(ValueError, match=error):
        AgentHistoryService().persist_turn_completion_atomic(
            conversation_id="conv-1",
            turn_id="turn-1",
            status="completed",
            final_content="Must not survive.",
            message_id="msg-preallocated-1",
            request_id="req-1",
            state_revision="desktop-state-1",
            research_output={**_research_output(), field: value},
        )

    with factory() as db:
        assert db.query(AgentMessage).count() == 0
        assert db.get(AgentTurn, "turn-1").status == "running"


def test_cross_scope_metadata_recovers_as_empty_audit_object():
    message = AgentMessage(
        id="msg-preallocated-1",
        conversation_id="conv-1",
        role="assistant",
        content="answer",
        metadata_json=json.dumps(
            {
                "schema_version": AGENT_MESSAGE_AUDIT_SCHEMA_VERSION,
                "message_id": "msg-preallocated-1",
                "turn_id": "turn-other",
                "conversation_id": "conv-other",
                "request_id": "req-other",
                "state_revision": "desktop-state-other",
                "action_receipts": [_receipt()],
                "research_output": _research_output(),
            }
        ),
    )

    recovered = message.to_dict()
    assert recovered["metadata"] == {}
    assert recovered["completion_turn_id"] is None
    assert recovered["action_receipts"] == []
    assert recovered["research_output"] is None


def test_cross_scope_nested_evidence_is_removed_from_generic_metadata():
    message = AgentMessage(
        id="msg-preallocated-1",
        conversation_id="conv-1",
        role="assistant",
        content="answer",
        metadata_json=json.dumps(
            {
                "schema_version": AGENT_MESSAGE_AUDIT_SCHEMA_VERSION,
                "message_id": "msg-preallocated-1",
                "turn_id": "turn-1",
                "conversation_id": "conv-1",
                "request_id": "req-1",
                "state_revision": "desktop-state-1",
                "action_receipts": [{**_receipt(), "conversation_id": "conv-other"}],
                "research_output": {**_research_output(), "conversation_id": "conv-other"},
            }
        ),
    )

    recovered = message.to_dict()
    assert recovered["metadata"]["conversation_id"] == "conv-1"
    assert recovered["metadata"]["action_receipts"] == []
    assert recovered["metadata"]["research_output"] is None
    assert recovered["action_receipts"] == []
    assert recovered["research_output"] is None
