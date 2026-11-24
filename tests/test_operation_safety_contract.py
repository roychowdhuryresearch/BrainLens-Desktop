import asyncio
import logging
import re

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

from runtime.api import internal_agent
from runtime.services.operation_safety_service import OperationSafetyService


def _create_operation(
    service: OperationSafetyService,
    *,
    suffix: str = "1",
    state_revision: str | None = "rev-7",
    params: dict | None = None,
):
    return service.create_pending_operation(
        request_id=f"req-{suffix}",
        session_id=f"session-{suffix}",
        conversation_id=f"conv-{suffix}",
        user_id=f"doctor-{suffix}",
        operation_type="config_change",
        target="review-policy",
        params=params if params is not None else {"threshold": 0.9, "enabled": True},
        description="Update review threshold",
        previous_state={"threshold": 0.8},
        state_revision=state_revision,
    )


def _scope(operation, **overrides):
    values = {
        "request_id": operation.request_id,
        "session_id": operation.session_id,
        "conversation_id": operation.conversation_id,
        "user_id": operation.user_id,
        "payload_digest": operation.payload_digest,
        "state_revision": operation.state_revision,
    }
    values.update(overrides)
    return values


def test_operation_ids_are_opaque_and_payload_digest_is_canonical_and_owned():
    service = OperationSafetyService()
    caller_params = {"nested": {"z": 3, "a": 1}, "enabled": True}
    operation = _create_operation(service, params=caller_params)
    same_payload = service.create_pending_operation(
        request_id="different-request",
        session_id="different-session",
        conversation_id="different-conversation",
        user_id="different-doctor",
        operation_type="config_change",
        target="review-policy",
        params={"enabled": True, "nested": {"a": 1, "z": 3}},
        description="Update review threshold",
        previous_state={"threshold": 0.8},
        state_revision="another-revision",
    )

    assert re.fullmatch(r"op_[0-9a-f]{32}", operation.operation_id)
    assert operation.operation_id != same_payload.operation_id
    assert re.fullmatch(r"[0-9a-f]{64}", operation.payload_digest)
    assert operation.payload_digest == same_payload.payload_digest

    caller_params["nested"]["a"] = 999
    assert operation.params["nested"]["a"] == 1

    # Even direct in-memory mutation of the approved semantic payload cannot
    # inherit the old approval digest.
    operation.params["nested"]["a"] = 777
    assert not service.confirm_operation(operation.operation_id, **_scope(operation))
    assert operation.status == "pending"


@pytest.mark.parametrize(
    ("field_name", "wrong_value"),
    [
        ("request_id", "req-other"),
        ("session_id", "session-other"),
        ("conversation_id", "conv-other"),
        ("user_id", "doctor-other"),
        ("payload_digest", "0" * 64),
        ("state_revision", "rev-other"),
    ],
)
def test_confirmation_fails_closed_on_every_scope_mismatch(field_name, wrong_value):
    service = OperationSafetyService()
    operation = _create_operation(service)

    assert not service.confirm_operation(
        operation.operation_id,
        **_scope(operation, **{field_name: wrong_value}),
    )
    assert operation.status == "pending"


def test_all_mutating_transitions_are_bound_to_the_same_immutable_scope():
    service = OperationSafetyService()
    operation = _create_operation(service)

    assert service.confirm_operation(operation.operation_id, **_scope(operation))
    assert not service.mark_executed(
        operation.operation_id,
        **_scope(operation, session_id="session-other"),
    )
    assert operation.status == "confirmed"
    assert service.mark_executed(operation.operation_id, **_scope(operation))
    assert service.rollback_operation(
        operation.operation_id,
        **_scope(operation, request_id="req-other"),
    ) is None
    assert operation.status == "executed"
    assert service.rollback_operation(operation.operation_id, **_scope(operation)) == {
        "threshold": 0.8
    }

    cancellable = _create_operation(service, suffix="2", state_revision=None)
    assert not service.cancel_operation(
        cancellable.operation_id,
        **_scope(cancellable, state_revision="unexpected-revision"),
    )
    assert cancellable.status == "pending"
    assert service.cancel_operation(cancellable.operation_id, **_scope(cancellable))


def test_operation_endpoints_return_stable_non_enumerating_scope_errors(monkeypatch):
    service = OperationSafetyService()
    operation = _create_operation(service)
    monkeypatch.setattr(
        "runtime.services.operation_safety_service.get_operation_safety_service",
        lambda: service,
    )

    for mismatch in (
        {"operation_id": "op_" + "f" * 32},
        {"request_id": "req-other"},
        {"session_id": "session-other"},
        {"conversation_id": "conv-other"},
        {"user_id": "doctor-other"},
        {"payload_digest": "0" * 64},
        {"state_revision": "rev-other"},
    ):
        action = {
            "operation_id": operation.operation_id,
            **_scope(operation),
            **mismatch,
        }
        with pytest.raises(HTTPException) as rejected:
            asyncio.run(
                internal_agent.confirm_operation(
                    internal_agent.OperationActionRequest(**action)
                )
            )
        assert rejected.value.status_code == 409
        assert rejected.value.detail == "operation_scope_or_state_invalid"
        assert operation.status == "pending"

    result = asyncio.run(
        internal_agent.confirm_operation(
            internal_agent.OperationActionRequest(
                operation_id=operation.operation_id,
                **_scope(operation),
            )
        )
    )
    assert result == {
        "status": "success",
        "operation_id": operation.operation_id,
        "confirmed": True,
    }


def test_create_endpoint_returns_digest_required_by_later_transition(monkeypatch):
    service = OperationSafetyService()
    monkeypatch.setattr(
        "runtime.services.operation_safety_service.get_operation_safety_service",
        lambda: service,
    )
    request = internal_agent.OperationCreateRequest(
        request_id="req-api",
        session_id="session-api",
        conversation_id="conv-api",
        user_id="doctor-api",
        operation_type="delete",
        target="candidate-17",
        params={"reason": "duplicate"},
        description="Delete duplicate candidate",
        state_revision="revision-api",
    )

    created = asyncio.run(internal_agent.create_operation(request))
    assert created["status"] == "success"
    assert re.fullmatch(r"[0-9a-f]{64}", created["payload_digest"])
    assert created["state_revision"] == "revision-api"

    cancelled = asyncio.run(
        internal_agent.cancel_operation(
            internal_agent.OperationActionRequest(
                operation_id=created["operation_id"],
                request_id=request.request_id,
                session_id=request.session_id,
                conversation_id=request.conversation_id,
                user_id=request.user_id,
                payload_digest=created["payload_digest"],
                state_revision=request.state_revision,
            )
        )
    )
    assert cancelled["cancelled"] is True


def test_legacy_operation_bodies_parse_without_422_but_actions_fail_closed(monkeypatch):
    service = OperationSafetyService()
    monkeypatch.setattr(
        "runtime.services.operation_safety_service.get_operation_safety_service",
        lambda: service,
    )
    legacy_create = internal_agent.OperationCreateRequest(
        conversation_id="conv-legacy",
        user_id="doctor-legacy",
        operation_type="delete",
        target="candidate-legacy",
    )
    created = asyncio.run(internal_agent.create_operation(legacy_create))
    scope = created["operation_scope"]
    assert scope["request_id"].startswith("legacy-request-")
    assert scope["session_id"].startswith("legacy-session-")
    assert scope["payload_digest"] == created["payload_digest"]

    legacy_action = internal_agent.OperationActionRequest(
        operation_id=created["operation_id"],
        user_id="doctor-legacy",
    )
    with pytest.raises(HTTPException) as rejected:
        asyncio.run(internal_agent.confirm_operation(legacy_action))
    assert rejected.value.status_code == 409
    assert rejected.value.detail == "operation_scope_or_state_invalid"
    assert service.get_operation(created["operation_id"]).status == "pending"


def test_legacy_operation_wire_contract_returns_200_then_stable_409(monkeypatch):
    service = OperationSafetyService()
    monkeypatch.setattr(
        "runtime.services.operation_safety_service.get_operation_safety_service",
        lambda: service,
    )
    app = FastAPI()
    app.include_router(internal_agent.router)
    app.dependency_overrides[internal_agent._validate_internal_token] = lambda: None
    client = TestClient(app)

    created = client.post(
        "/internal/agent/v1/operation/create",
        json={
            "conversation_id": "conv-wire-legacy",
            "user_id": "doctor-wire-legacy",
            "operation_type": "delete",
            "target": "candidate-wire-legacy",
        },
    )
    assert created.status_code == 200
    operation_id = created.json()["operation_id"]
    assert created.json()["operation_scope"]["payload_digest"] == created.json()["payload_digest"]

    rejected = client.post(
        "/internal/agent/v1/operation/confirm",
        json={"operation_id": operation_id, "user_id": "doctor-wire-legacy"},
    )
    assert rejected.status_code == 409
    assert rejected.json() == {"detail": "operation_scope_or_state_invalid"}
    assert service.get_operation(operation_id).status == "pending"


def test_operation_action_contract_rejects_invalid_provided_scope():
    complete = {
        "operation_id": "op_abc",
        "request_id": "req-1",
        "session_id": "session-1",
        "conversation_id": "conv-1",
        "user_id": "doctor-1",
        "payload_digest": "a" * 64,
    }
    with pytest.raises(ValidationError):
        internal_agent.OperationActionRequest(**{**complete, "user_id": "   "})
    with pytest.raises(ValidationError):
        internal_agent.OperationActionRequest(**{**complete, "payload_digest": "not-a-digest"})
    with pytest.raises(ValidationError):
        internal_agent.OperationActionRequest(**{**complete, "state_revision": "   "})
    with pytest.raises(ValidationError):
        internal_agent.OperationCreateRequest(
            request_id="   ",
            conversation_id="conv-1",
            user_id="doctor-1",
            operation_type="delete",
            target="candidate-1",
        )


def test_logging_and_operation_audit_do_not_expose_raw_scope_or_payload(caplog):
    service = OperationSafetyService()
    secret_values = (
        "req-secret",
        "session-secret",
        "conv-patient-123",
        "doctor-secret",
        "patient-jane-doe.edf",
        "api-key-secret",
        "prior-secret",
    )
    with caplog.at_level(logging.INFO):
        operation = service.create_pending_operation(
            request_id=secret_values[0],
            session_id=secret_values[1],
            conversation_id=secret_values[2],
            user_id=secret_values[3],
            operation_type="config_change",
            target=secret_values[4],
            params={"api_key": secret_values[5]},
            description="Sensitive payload",
            previous_state={"token": secret_values[6]},
            state_revision="secret-revision",
        )
        service.confirm_operation(
            operation.operation_id,
            **_scope(operation, user_id="wrong-secret-actor"),
        )

    rendered_logs = "\n".join(record.getMessage() for record in caplog.records)
    for secret in (*secret_values, "wrong-secret-actor", "secret-revision"):
        assert secret not in rendered_logs

    audit_entry = service.get_operation_log(secret_values[2])[0]
    assert "params" not in audit_entry
    assert "target" not in audit_entry
    assert "description" not in audit_entry
    assert "previous_state" not in audit_entry
    assert "user_id" not in audit_entry
    assert audit_entry["actor_user_id_sha256"] != secret_values[3]
