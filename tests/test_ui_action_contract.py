from __future__ import annotations

import json
import threading
import urllib.error
import urllib.request
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

import ui_mcp.broker as broker_module
from runtime.agent_runtime.action_receipts import (
    canonical_action_receipt,
)
from ui_mcp.broker import FAILURE_STATUSES, UiBus, build_server, load_catalog


ROOT = Path(__file__).resolve().parents[1]
CATALOG_PATH = ROOT / "contracts" / "ui-command-catalog.json"
SCHEMA_DIR = ROOT / "contracts" / "agent" / "schemas"
RECEIPT_SCHEMA_PATH = SCHEMA_DIR / "action-receipt-v1.schema.json"
REQUIRED_EFFECTIVE_FIELDS = {
    "owner",
    "effect",
    "research_impact",
    "idempotency",
    "retry",
    "timeout_seconds",
    "approval_role",
    "affected_resources",
    "postcondition",
    "terminal_statuses",
    "failure_statuses",
    "terminal_proof",
    "data_sensitivity",
    "provenance_required",
}


def _receipt_validator() -> Draft202012Validator:
    schemas = [json.loads(path.read_text(encoding="utf-8")) for path in SCHEMA_DIR.glob("*.schema.json")]
    registry = Registry()
    for schema in schemas:
        registry = registry.with_resource(schema["$id"], Resource.from_contents(schema))
    receipt_schema = next(schema for schema in schemas if schema["$id"].endswith("action-receipt-v1.schema.json"))
    return Draft202012Validator(receipt_schema, registry=registry, format_checker=FormatChecker())


RECEIPT_VALIDATOR = _receipt_validator()


def _validate_receipt(receipt: dict) -> None:
    RECEIPT_VALIDATOR.validate(receipt)


def _scope(
    revision: str,
    *,
    conversation_id: str = "desktop-copilot-1",
    request_id: str = "request-review-1",
    message_id: str = "message-review-1",
    recording_fingerprint: str = "a" * 64,
    actor_id: str = "clinician-1",
    session_id: str = "workspace-session-1",
) -> dict:
    return {
        "conversation_id": conversation_id,
        "request_id": request_id,
        "message_id": message_id,
        "recording_fingerprint": recording_fingerprint,
        "state_revision": revision,
        "approval_actor": {
            "role": "clinician",
            "actor_id": actor_id,
            "session_id": session_id,
            "source": "desktop_renderer",
        },
    }


def _issuance_scope(
    revision: str,
    *,
    conversation_id: str = "desktop-copilot-1",
    request_id: str = "request-review-1",
    message_id: str = "message-review-1",
    recording_fingerprint: str = "a" * 64,
    session_id: str = "workspace-session-1",
) -> dict:
    return {
        "conversation_id": conversation_id,
        "request_id": request_id,
        "message_id": message_id,
        "session_id": session_id,
        "state_revision": revision,
        "recording_fingerprint": recording_fingerprint,
        "resource_scope": {
            "recording_sha256": recording_fingerprint,
            "state_revision": revision,
        },
    }


def _scoped_bus(
    revision: str,
    *,
    recording_fingerprint: str = "a" * 64,
    receipt_store: Path | None = None,
) -> UiBus:
    bus = UiBus(receipt_store=receipt_store)
    bus.set_state({
        "session_id": "workspace-session-1",
        "state_revision": revision,
        "resource_scope": {
            "state_revision": revision,
            "recording_sha256": recording_fingerprint,
        },
    })
    return bus


def _annotation_terminal_proof(*, label: str = "uncertain") -> dict:
    return {
        "source": "backend_readback",
        "event_id": "event-1",
        "run_id": "qc-run-1",
        "backend_status": "complete",
        "requested_annotation_label": label,
        "expected_annotation_label": label,
        "observed_annotation_label": label,
        "annotation_present": True,
        "annotation_cleared": False,
    }


def _detection_terminal_proof(*, recording_fingerprint: str = "a" * 64) -> dict:
    return {
        "source": "backend_readback",
        "backend_status": "complete",
        "recording_fingerprint": recording_fingerprint,
        "run_id": "run-clinical-001",
        "biomarker": "HFO",
        "detector": "STE",
        "parameters_sha256": "b" * 64,
        "result_sha256": "c" * 64,
        "artifacts_sha256": "d" * 64,
        "output_dir_sha256": "e" * 64,
        "num_events": 0,
        "num_channels": 0,
    }


def _prepare_terminal_proof(*, recording_fingerprint: str = "a" * 64) -> dict:
    return {
        "source": "backend_readback",
        "backend_status": "complete",
        "recording_fingerprint": recording_fingerprint,
        "input_recording_fingerprint": recording_fingerprint,
        "output_recording_fingerprint": "d" * 64,
        "parameters_sha256": "b" * 64,
        "result_sha256": "c" * 64,
        "output_path_sha256": "e" * 64,
    }


def _artifact_terminal_proof() -> dict:
    return {
        "source": "backend_readback",
        "backend_status": "complete",
        "artifact_exists": True,
        "artifact_sha256": "d" * 64,
        "result_sha256": "c" * 64,
    }


def test_packaged_pyhfo_ui_catalog_matches_canonical_catalog():
    packaged = ROOT / "pyhfo" / "src" / "pyhfo" / "resources" / "ui-command-catalog.json"
    assert json.loads(packaged.read_text(encoding="utf-8")) == json.loads(CATALOG_PATH.read_text(encoding="utf-8"))


def test_catalog_resolves_a_complete_machine_checked_contract_for_every_unique_command():
    raw = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    raw_types = [entry["type"] for entry in raw["commands"]]
    assert len(raw_types) == len(set(raw_types))
    assert raw["contract_profile_binding"] == "risk"

    catalog = load_catalog(CATALOG_PATH, strict=True)
    assert set(catalog) == set(raw_types)
    for command_type, spec in catalog.items():
        assert REQUIRED_EFFECTIVE_FIELDS <= set(spec), command_type
        assert spec["contract_profile"] == spec["risk"]
        assert spec["owner"].startswith("desktop.")
        assert spec["effect"] == command_type
        assert spec["effect_class"]
        assert spec["research_impact"]
        assert spec["idempotency"]["mode"] in {"idempotent", "deduplicate_by_key", "non_idempotent"}
        assert spec["retry"]["mode"] in {"safe", "same_key_only", "never"}
        assert spec["timeout_seconds"] > 0
        assert spec["affected_resources"]
        assert set(spec["failure_statuses"]) == FAILURE_STATUSES
        if spec["risk"] in {"compute", "artifact_write", "review_write", "destructive"}:
            assert spec["requires_confirmation"] is True
            assert spec["approval_role"] == "clinician"

    assert "applied" not in catalog["detection.run"]["terminal_statuses"]
    assert "applied" not in catalog["events.stage_annotation"]["terminal_statuses"]
    assert "complete" in catalog["events.stage_annotation"]["terminal_statuses"]


def test_catalog_duplicate_command_types_fail_closed(tmp_path: Path):
    raw = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    raw["commands"].append(dict(raw["commands"][0]))
    duplicate_catalog = tmp_path / "duplicate-catalog.json"
    duplicate_catalog.write_text(json.dumps(raw), encoding="utf-8")

    assert load_catalog(duplicate_catalog) == {}
    with pytest.raises(ValueError, match="duplicate ui command type"):
        load_catalog(duplicate_catalog, strict=True)


def test_actual_queued_and_terminal_receipts_validate_against_xlp_schema():
    bus = UiBus()
    command, error = bus.emit("workspace.open_panel", {"panel": "Review"}, "open review")
    assert error is None and command is not None

    queued = bus.get_ack(command["command_id"])
    _validate_receipt(queued)
    assert queued["status"] == "queued"
    assert "success" not in queued

    terminal, error = bus.record_ack(command["command_id"], {
        "status": "applied",
        "command_type": "workspace.open_panel",
        "conversation_id": "desktop-copilot-1",
        "state_revision": "desktop-state-2",
        "diff_state": "review-panel-open",
    })
    assert error is None and terminal is not None
    _validate_receipt(terminal)
    assert terminal["terminal"] is True
    assert terminal["result"]["observed"]
    assert terminal["postcondition"]["verified"] is True


def test_durable_receipt_survives_restart_and_hashes_privacy_sensitive_identifiers(tmp_path: Path):
    store = tmp_path / "receipts" / "ui-actions.json"
    payload = {"biomarker": "HFO", "detector": "STE", "event_id": "event-clinical-001"}
    bus = _scoped_bus("desktop-state-1", receipt_store=store)

    command, error = bus.emit(
        "detection.run",
        payload,
        "patient PAT-001 selected",
        "retry-key-001",
        _issuance_scope("desktop-state-1"),
    )
    assert error is None and command is not None
    command_id = command["command_id"]
    _validate_receipt(bus.get_ack(command_id))
    assert store.stat().st_mode & 0o777 == 0o600

    applied, error = bus.record_ack(command_id, {
        "status": "applied",
        "command_type": "detection.run",
        **_scope("desktop-state-1", actor_id="doctor@example.org"),
        "before": {"selected_event_id": "event-clinical-001", "running": False},
        "after": {"selected_event_id": "event-clinical-001", "running": True},
        "provenance": {"subject_id": "PAT-001", "protocol": "hfo-v2"},
    })
    assert error is None and applied is not None
    _validate_receipt(applied)
    assert applied["actor"]["role"] == "clinician"
    assert len(applied["actor"]["actor_id_sha256"]) == 64
    assert len(applied["actor"]["session_id_sha256"]) == 64

    running, error = bus.record_ack(command_id, {
        "status": "running",
        "command_type": "detection.run",
        **_scope("desktop-state-1", actor_id="doctor@example.org"),
    })
    assert error is None and running is not None
    _validate_receipt(running)

    restarted = UiBus(receipt_store=store)
    restored = restarted.get_ack(command_id)
    _validate_receipt(restored)
    assert restored["status"] == "running"

    complete, error = restarted.record_ack(command_id, {
        "status": "complete",
        "command_type": "detection.run",
        **_scope("desktop-state-1", actor_id="doctor@example.org"),
        "terminal_proof": _detection_terminal_proof(),
    })
    assert error is None and complete is not None
    _validate_receipt(complete)
    assert complete["status"] == "complete"
    assert complete["postcondition"]["evidence"]

    restored_again = UiBus(receipt_store=store).get_ack(command_id)
    _validate_receipt(restored_again)
    durable_text = store.read_text(encoding="utf-8")
    for raw_identifier in (
        "event-clinical-001",
        "run-clinical-001",
        "PAT-001",
        "doctor@example.org",
        "workspace-session-1",
        "patient PAT-001 selected",
    ):
        assert raw_identifier not in durable_text


def test_write_issuance_scope_is_required_validated_and_frozen_in_command_and_receipt():
    bus = UiBus()
    missing, error = bus.emit(
        "detection.run", {"biomarker": "HFO", "detector": "STE"}, "run",
    )
    assert missing is None
    assert "authority_scope is missing" in str(error)

    bus.set_state({
        "session_id": "workspace-session-1",
        "state_revision": "desktop-state-1",
        "resource_scope": {
            "state_revision": "desktop-state-1",
            "recording_sha256": "a" * 64,
        },
    })
    scope = _issuance_scope("desktop-state-1")
    scope.pop("session_id")  # broker binds the trusted renderer session when the runtime omits it
    command, error = bus.emit(
        "detection.run",
        {"biomarker": "HFO", "detector": "STE"},
        "run",
        authority_scope=scope,
    )
    assert error is None and command is not None
    assert command["request_id"] == "request-review-1"
    assert command["message_id"] == "message-review-1"
    assert command["conversation_id"] == "desktop-copilot-1"
    assert command["session_id"] == "workspace-session-1"
    assert command["state_revision"] == "desktop-state-1"
    assert command["resource_scope"] == {
        "recording_sha256": "a" * 64,
        "state_revision": "desktop-state-1",
    }
    queued = bus.get_ack(command["command_id"])
    assert queued["request_id"] == command["request_id"]
    assert queued["message_id"] == command["message_id"]
    assert queued["conversation_id"] == command["conversation_id"]
    assert queued["state_revision"] == command["state_revision"]
    assert queued["recording_fingerprint"] == "a" * 64
    assert queued["issuance_session_sha256"]
    assert queued["issuance_resource_scope_sha256"]
    assert queued["transitions"][0]["session_id_sha256"]
    _validate_receipt(queued)

    conflicting, error = bus.emit(
        "detection.run",
        {"biomarker": "HFO", "detector": "STE"},
        "run",
        authority_scope=_issuance_scope("desktop-state-other"),
    )
    assert conflicting is None
    assert "state_revision does not match current UI state" in str(error)

    conflicting_fingerprint, error = bus.emit(
        "detection.run",
        {"biomarker": "HFO", "detector": "STE"},
        "run",
        authority_scope=_issuance_scope(
            "desktop-state-1", recording_fingerprint="e" * 64,
        ),
    )
    assert conflicting_fingerprint is None
    assert "recording fingerprint does not match current UI state" in str(error)

    corrupt_state = UiBus()
    corrupt_state.set_state({
        "session_id": "workspace-session-1",
        "state_revision": "desktop-state-1",
        "resource_scope": {
            "state_revision": "desktop-state-other",
            "recording_sha256": "a" * 64,
        },
    })
    rejected, error = corrupt_state.emit(
        "detection.run",
        {"biomarker": "HFO", "detector": "STE"},
        "run",
        authority_scope=_issuance_scope("desktop-state-1"),
    )
    assert rejected is None
    assert error == "current UI state_revision conflicts with resource_scope"


@pytest.mark.parametrize(
    ("command_type", "payload"),
    [
        ("analysis.prepare_recording", {}),
        ("detection.run", {"biomarker": "HFO", "detector": "STE"}),
        ("classification.run", {}),
        ("severity.run", {}),
    ],
)
def test_recording_bound_confirmed_writes_require_issuance_fingerprint(
    command_type: str,
    payload: dict,
):
    scope = _issuance_scope("desktop-state-1")
    scope.pop("recording_fingerprint")
    scope["resource_scope"].pop("recording_sha256")
    command, error = UiBus().emit(
        command_type,
        payload,
        "run",
        authority_scope=scope,
    )
    assert command is None
    assert error == f"{command_type} authority_scope requires recording_fingerprint"


def test_recording_bound_write_requires_current_ui_recording_fingerprint():
    bus = UiBus()
    bus.set_state({
        "session_id": "workspace-session-1",
        "state_revision": "desktop-state-1",
        "resource_scope": {"state_revision": "desktop-state-1"},
    })
    command, error = bus.emit(
        "detection.run",
        {"biomarker": "HFO", "detector": "STE"},
        "run",
        authority_scope=_issuance_scope("desktop-state-1"),
    )
    assert command is None
    assert error == "current UI recording fingerprint is missing; refresh the workspace scope"


def test_write_idempotency_key_is_bound_to_issuance_scope_across_restart(tmp_path: Path):
    store = tmp_path / "scoped-receipts.json"
    scope = _issuance_scope("desktop-state-1")
    first = _scoped_bus("desktop-state-1", receipt_store=store)
    command, error = first.emit(
        "detection.run",
        {"biomarker": "HFO", "detector": "STE"},
        "run",
        "runtime-ui-v1-stable",
        scope,
    )
    assert error is None and command is not None

    restarted = _scoped_bus("desktop-state-1", receipt_store=store)
    recovered, error = restarted.emit(
        "detection.run",
        {"biomarker": "HFO", "detector": "STE"},
        "retry",
        "runtime-ui-v1-stable",
        scope,
    )
    assert error is None and recovered is not None
    assert recovered["command_id"] == command["command_id"]
    assert recovered["deduplicated"] is True

    rebound_scope = _issuance_scope("desktop-state-1", request_id="request-review-other")
    rebound, error = restarted.emit(
        "detection.run",
        {"biomarker": "HFO", "detector": "STE"},
        "retry from another turn",
        "runtime-ui-v1-stable",
        rebound_scope,
    )
    assert rebound is None
    assert "different command authority scope" in str(error)


def test_write_idempotency_key_freezes_full_resource_scope_across_restart(tmp_path: Path):
    store = tmp_path / "resource-scoped-receipts.json"
    scope = _issuance_scope("desktop-state-1")
    scope["resource_scope"]["project_id"] = "project-a"
    first = _scoped_bus("desktop-state-1", receipt_store=store)
    command, error = first.emit(
        "detection.run",
        {"biomarker": "HFO", "detector": "STE"},
        "run",
        "runtime-ui-v1-resource-stable",
        scope,
    )
    assert error is None and command is not None

    rebound_scope = _issuance_scope("desktop-state-1")
    rebound_scope["resource_scope"]["project_id"] = "project-b"
    rebound, error = _scoped_bus("desktop-state-1", receipt_store=store).emit(
        "detection.run",
        {"biomarker": "HFO", "detector": "STE"},
        "retry",
        "runtime-ui-v1-resource-stable",
        rebound_scope,
    )
    assert rebound is None
    assert "different command authority scope" in str(error)


def test_issuance_scope_survives_transition_history_trimming_and_restart(tmp_path: Path):
    store = tmp_path / "trimmed-scope-receipts.json"
    scope = _issuance_scope("desktop-state-trimmed")
    scope["resource_scope"]["project_id"] = "project-a"
    bus = _scoped_bus("desktop-state-trimmed", receipt_store=store)
    command, error = bus.emit(
        "detection.run",
        {"biomarker": "HFO", "detector": "STE"},
        "run",
        "runtime-ui-v1-trimmed-scope",
        scope,
    )
    assert error is None and command is not None
    for _ in range(70):
        receipt, error = bus.record_ack(command["command_id"], {
            "status": "staged",
            "command_type": "detection.run",
        })
        assert error is None and receipt is not None
    assert len(receipt["transitions"]) == 64
    assert receipt["transitions"][0]["source"] == "renderer_ack"
    assert receipt["issuance_session_sha256"]
    assert receipt["issuance_resource_scope_sha256"]
    _validate_receipt(receipt)

    restarted = _scoped_bus("desktop-state-trimmed", receipt_store=store)
    recovered, error = restarted.emit(
        "detection.run",
        {"biomarker": "HFO", "detector": "STE"},
        "retry",
        "runtime-ui-v1-trimmed-scope",
        scope,
    )
    assert error is None and recovered is not None
    assert recovered["command_id"] == command["command_id"]

    applied, error = restarted.record_ack(command["command_id"], {
        "status": "applied",
        "command_type": "detection.run",
        **_scope("desktop-state-trimmed"),
    })
    assert error is None and applied is not None


def test_severity_terminal_proof_uses_durable_issuance_fingerprint_after_restart(tmp_path: Path):
    store = tmp_path / "severity-receipts.json"
    fingerprint = "a" * 64
    bus = _scoped_bus(
        "desktop-state-severity",
        recording_fingerprint=fingerprint,
        receipt_store=store,
    )
    command, error = bus.emit(
        "severity.run",
        {},
        "score severity",
        "runtime-ui-v1-severity",
        _issuance_scope("desktop-state-severity", recording_fingerprint=fingerprint),
    )
    assert error is None and command is not None

    restarted = UiBus(receipt_store=store)
    outcome = {
        "status": "complete",
        "command_type": "severity.run",
        **_scope("desktop-state-severity", recording_fingerprint=fingerprint),
        "terminal_proof": {
            "source": "backend_readback",
            "backend_status": "complete",
            "recording_fingerprint": fingerprint,
            "model_name": "BASED",
            "model_version": "1.0.0",
            "model_sha256": "b" * 64,
            "parameters_sha256": "c" * 64,
            "result_sha256": "d" * 64,
            "severity_summary": {
                "eeg_type": "scalp",
                "num_segments": 2,
                "num_clean_segments": 2,
                "mean_score": 1.5,
                "peak_score": 2.0,
                "peak_time_sec": 15.0,
                "clean_mean_score": 1.5,
                "clean_peak_score": 2.0,
                "clean_peak_time_sec": 15.0,
                "artifact_quality": {
                    "status": "assessed",
                    "method": "tueg19_peak_amplitude",
                    "threshold_uv": 500.0,
                    "assessed_segments": 2,
                    "total_segments": 2,
                    "channel_count": 19,
                },
            },
        },
    }
    receipt, error = restarted.record_ack(command["command_id"], outcome)
    assert error is None and receipt is not None
    assert receipt["recording_fingerprint"] == fingerprint
    _validate_receipt(receipt)

    other_bus = _scoped_bus(
        "desktop-state-severity",
        recording_fingerprint=fingerprint,
        receipt_store=tmp_path / "severity-mismatch.json",
    )
    other_command, error = other_bus.emit(
        "severity.run",
        {},
        "score severity",
        authority_scope=_issuance_scope(
            "desktop-state-severity", recording_fingerprint=fingerprint,
        ),
    )
    assert error is None and other_command is not None
    mismatched = {**outcome, "recording_fingerprint": "e" * 64}
    mismatched["terminal_proof"] = {
        **outcome["terminal_proof"], "recording_fingerprint": "e" * 64,
    }
    receipt, error = UiBus(receipt_store=tmp_path / "severity-mismatch.json").record_ack(
        other_command["command_id"], mismatched,
    )
    assert receipt is None
    assert "recording_fingerprint does not match" in str(error)


def test_receipt_state_machine_binds_actor_session_conversation_and_requires_observed_proof():
    bus = _scoped_bus("desktop-state-1")
    command, error = bus.emit(
        "detection.run",
        {"biomarker": "HFO", "detector": "STE"},
        "run",
        authority_scope=_issuance_scope("desktop-state-1"),
    )
    assert error is None and command is not None
    command_id = command["command_id"]

    queued, error = bus.record_ack(command_id, {"status": "staged", "command_type": "detection.run"})
    assert error is None and queued is not None
    assert queued["status"] == "queued"
    assert "reported_status" not in queued
    _validate_receipt(queued)

    receipt, error = bus.record_ack(command_id, {
        "status": "applied",
        "command_type": "detection.run",
        "conversation_id": "desktop-copilot-1",
        "state_revision": "desktop-state-1",
    })
    assert receipt is None and "approval_actor is required" in str(error)

    receipt, error = bus.record_ack(command_id, {
        "status": "applied",
        "command_type": "detection.run",
        **_scope("desktop-state-1"),
    })
    assert error is None and receipt is not None

    for changed_scope, expected in (
        (_scope("desktop-state-1", actor_id="clinician-2"), "actor/session binding"),
        (_scope("desktop-state-1", session_id="workspace-session-2"), "actor/session binding"),
        (_scope("desktop-state-1", conversation_id="desktop-copilot-2"), "conversation_id"),
    ):
        rejected, error = bus.record_ack(command_id, {
            "status": "running",
            "command_type": "detection.run",
            **changed_scope,
        })
        assert rejected is None and expected in str(error)

    running, error = bus.record_ack(command_id, {
        "status": "running",
        "command_type": "detection.run",
        **_scope("desktop-state-1"),
    })
    assert error is None and running is not None
    assert running["state_revision"] == "desktop-state-1"

    missing_proof, error = bus.record_ack(command_id, {
        "status": "complete",
        "command_type": "detection.run",
        **_scope("desktop-state-1"),
    })
    assert missing_proof is None
    assert error == "terminal detection.run success requires backend result and provenance"

    weak_lifecycle_proof, error = bus.record_ack(command_id, {
        "status": "complete",
        "command_type": "detection.run",
        **_scope("desktop-state-1"),
        "operation_id": "operation-123",
        "finished_at": "2026-08-25T00:00:00Z",
        "detail": "renderer callback finished",
    })
    assert weak_lifecycle_proof is None
    assert error == "terminal detection.run success requires backend result and provenance"

    complete, error = bus.record_ack(command_id, {
        "status": "complete",
        "command_type": "detection.run",
        **_scope("desktop-state-1"),
        "terminal_proof": _detection_terminal_proof(),
    })
    assert error is None and complete is not None
    _validate_receipt(complete)

    replacement, error = bus.record_ack(command_id, {"status": "failed", "command_type": "detection.run"})
    assert replacement is None
    assert error == "invalid command receipt transition: complete -> failed"
    assert bus.get_ack(command_id)["status"] == "complete"


def test_prepare_terminal_success_requires_input_output_and_provenance_digests():
    bus = _scoped_bus("desktop-state-prepare")
    command, error = bus.emit(
        "analysis.prepare_recording",
        {},
        "prepare",
        authority_scope=_issuance_scope("desktop-state-prepare"),
    )
    assert error is None and command is not None

    weak, error = bus.record_ack(command["command_id"], {
        "status": "complete",
        "command_type": "analysis.prepare_recording",
        **_scope("desktop-state-prepare"),
        "terminal_proof": {
            "source": "backend_readback",
            "backend_status": "complete",
            "recording_fingerprint": "a" * 64,
            "result_sha256": "c" * 64,
        },
    })
    assert weak is None
    assert error == (
        "terminal analysis.prepare_recording success requires backend result and provenance"
    )

    complete, error = bus.record_ack(command["command_id"], {
        "status": "complete",
        "command_type": "analysis.prepare_recording",
        **_scope("desktop-state-prepare"),
        "terminal_proof": _prepare_terminal_proof(),
    })
    assert error is None and complete is not None
    _validate_receipt(complete)


def test_detection_terminal_success_rejects_invalid_counts_and_fingerprint():
    for proof in (
        {**_detection_terminal_proof(), "num_events": -1},
        {**_detection_terminal_proof(), "num_channels": -1},
        {**_detection_terminal_proof(), "recording_fingerprint": "e" * 64},
    ):
        bus = _scoped_bus("desktop-state-detect")
        command, error = bus.emit(
            "detection.run",
            {"biomarker": "HFO", "detector": "STE"},
            "run",
            authority_scope=_issuance_scope("desktop-state-detect"),
        )
        assert error is None and command is not None
        receipt, error = bus.record_ack(command["command_id"], {
            "status": "complete",
            "command_type": "detection.run",
            **_scope("desktop-state-detect"),
            "terminal_proof": proof,
        })
        assert receipt is None
        assert error == "terminal detection.run success requires backend result and provenance"


def test_artifact_write_terminal_success_requires_existence_readback_and_digests():
    issuance_scope = _issuance_scope("desktop-state-export")
    issuance_scope.pop("recording_fingerprint")
    issuance_scope["resource_scope"].pop("recording_sha256")
    ack_scope = _scope("desktop-state-export")
    ack_scope.pop("recording_fingerprint")
    bus = UiBus()
    command, error = bus.emit(
        "export.report",
        {},
        "export",
        authority_scope=issuance_scope,
    )
    assert error is None and command is not None

    weak, error = bus.record_ack(command["command_id"], {
        "status": "complete",
        "command_type": "export.report",
        **ack_scope,
        "finished_at": "2026-08-25T00:00:00Z",
        "detail": "renderer callback finished",
    })
    assert weak is None
    assert error == (
        "terminal export.report success requires artifact existence readback and digests"
    )

    complete, error = bus.record_ack(command["command_id"], {
        "status": "complete",
        "command_type": "export.report",
        **ack_scope,
        "terminal_proof": _artifact_terminal_proof(),
    })
    assert error is None and complete is not None
    _validate_receipt(complete)


@pytest.mark.parametrize(
    ("reported", "canonical"),
    [("noop", "noop"), ("rejected", "rejected"), ("dismissed", "rejected"), ("error", "failed")],
)
def test_noop_rejected_and_error_are_terminal_failures(reported: str, canonical: str):
    bus = UiBus()
    command, error = bus.emit("workspace.reset_waveform_view", {}, "reset")
    assert error is None and command is not None

    receipt, error = bus.record_ack(command["command_id"], {
        "status": reported,
        "command_type": "workspace.reset_waveform_view",
        "detail": "renderer reported failure",
    })
    assert error is None and receipt is not None
    _validate_receipt(receipt)
    assert receipt["status"] == canonical
    assert receipt["terminal"] is True
    assert receipt["success"] is False
    assert receipt["reason"]
    if canonical == "failed":
        assert receipt["error"]["code"] == "execution_failed"


def test_review_write_requires_complete_command_bound_backend_proof():
    bus = UiBus()
    command, error = bus.emit(
        "events.stage_annotation",
        {"event_id": "event-1", "label": "uncertain"},
        "stage review label",
        authority_scope=_issuance_scope("desktop-state-2"),
    )
    assert error is None and command is not None

    queued, error = bus.record_ack(command["command_id"], {
        "status": "staged",
        "command_type": "events.stage_annotation",
    })
    assert error is None and queued is not None
    assert queued["status"] == "queued"
    assert queued["terminal"] is False
    assert "actor" not in queued

    running, error = bus.record_ack(command["command_id"], {
        "status": "running",
        "command_type": "events.stage_annotation",
        **_scope("desktop-state-2"),
    })
    assert error is None and running is not None
    assert running["terminal"] is False
    assert running["actor"]["role"] == "clinician"
    assert "success" not in running

    receipt, error = bus.record_ack(command["command_id"], {
        "status": "complete",
        "command_type": "events.stage_annotation",
        **_scope("desktop-state-2"),
        "terminal_proof": _annotation_terminal_proof(),
    })
    assert error is None and receipt is not None
    _validate_receipt(receipt)
    assert receipt["terminal"] is True
    assert receipt["actor"]["role"] == "clinician"
    assert canonical_action_receipt(
        receipt,
        terminal_only=True,
        expected_conversation_id="desktop-copilot-1",
        expected_request_id="request-review-1",
        expected_message_id="message-review-1",
        expected_state_revision="desktop-state-2",
        expected_recording_fingerprint="a" * 64,
    ) == receipt


@pytest.mark.parametrize(
    ("field", "conflicting_value", "error_fragment"),
    [
        ("request_id", "request-review-2", "request_id"),
        ("message_id", "message-review-2", "message_id"),
        ("conversation_id", "desktop-copilot-2", "conversation_id"),
        ("state_revision", "desktop-state-3", "state_revision"),
        ("recording_fingerprint", "b" * 64, "recording_fingerprint"),
    ],
)
def test_review_write_rejects_scope_rebinding_between_callbacks(
    field: str,
    conflicting_value: str,
    error_fragment: str,
):
    bus = UiBus()
    command, error = bus.emit(
        "events.stage_annotation",
        {"event_id": "event-1", "label": "uncertain"},
        "stage review label",
        authority_scope=_issuance_scope("desktop-state-2"),
    )
    assert error is None and command is not None
    running, error = bus.record_ack(
        command["command_id"],
        {
            "status": "running",
            "command_type": "events.stage_annotation",
            **_scope("desktop-state-2"),
        },
    )
    assert error is None and running is not None

    rebound_scope = _scope("desktop-state-2")
    rebound_scope[field] = conflicting_value
    rejected, error = bus.record_ack(
        command["command_id"],
        {
            "status": "running",
            "command_type": "events.stage_annotation",
            **rebound_scope,
        },
    )
    assert rejected is None
    assert error_fragment in str(error)


def test_terminal_review_receipt_missing_or_mutated_scope_fails_canonical_validation():
    bus = UiBus()
    command, error = bus.emit(
        "events.stage_annotation",
        {"event_id": "event-1", "label": "uncertain"},
        "stage review label",
        authority_scope=_issuance_scope("desktop-state-2"),
    )
    assert error is None and command is not None
    receipt, error = bus.record_ack(
        command["command_id"],
        {
            "status": "complete",
            "command_type": "events.stage_annotation",
            **_scope("desktop-state-2"),
            "terminal_proof": _annotation_terminal_proof(),
        },
    )
    assert error is None and receipt is not None
    assert canonical_action_receipt(receipt, terminal_only=True) == receipt

    for field in (
        "recording_fingerprint",
        "request_id",
        "message_id",
        "conversation_id",
        "state_revision",
        "scope_sha256",
    ):
        missing = dict(receipt)
        missing.pop(field)
        assert canonical_action_receipt(missing, terminal_only=True) is None, field

    mutations = {
        "recording_fingerprint": "b" * 64,
        "request_id": "request-review-2",
        "message_id": "message-review-2",
        "conversation_id": "desktop-copilot-2",
        "state_revision": "desktop-state-3",
        "scope_sha256": "b" * 64,
    }
    for field, changed_value in mutations.items():
        mutated = {**receipt, field: changed_value}
        assert canonical_action_receipt(mutated, terminal_only=True) is None, field


@pytest.mark.parametrize("status", ["failed", "rejected", "noop"])
def test_terminal_review_failure_receipts_also_require_exact_scope(status: str):
    bus = UiBus()
    command, error = bus.emit(
        "events.stage_annotation",
        {"event_id": "event-1", "label": "uncertain"},
        "stage review label",
        authority_scope=_issuance_scope("desktop-state-2"),
    )
    assert error is None and command is not None
    receipt, error = bus.record_ack(
        command["command_id"],
        {
            "status": status,
            "command_type": "events.stage_annotation",
            **_scope("desktop-state-2"),
            "detail": "safe failure detail",
        },
    )
    assert error is None and receipt is not None
    _validate_receipt(receipt)
    assert canonical_action_receipt(receipt, terminal_only=True) == receipt

    missing_scope = dict(receipt)
    missing_scope.pop("message_id")
    assert canonical_action_receipt(missing_scope, terminal_only=True) is None


def test_issuance_bound_terminal_review_ack_is_canonical_and_survives_restart(
    tmp_path: Path,
):
    store = tmp_path / "review-transport-receipts.json"
    bus = UiBus(receipt_store=store)
    command, error = bus.emit(
        "events.stage_annotation",
        {"event_id": "event-1", "label": "uncertain"},
        "stage review label",
        authority_scope=_issuance_scope("desktop-state-2"),
    )
    assert error is None and command is not None
    receipt, error = bus.record_ack(
        command["command_id"],
        {
            "status": "complete",
            "command_type": "events.stage_annotation",
            "conversation_id": "desktop-copilot-1",
            "state_revision": "desktop-state-2",
            "approval_actor": _scope("desktop-state-2")["approval_actor"],
            "terminal_proof": _annotation_terminal_proof(),
        },
    )
    assert error is None and receipt is not None
    assert receipt["contract_version"] == "ieeg-agent.v1"
    assert receipt["scope_sha256"]
    assert canonical_action_receipt(receipt, terminal_only=True) == receipt

    restarted = UiBus(receipt_store=store)
    assert restarted.get_ack(command["command_id"]) == receipt


def test_review_write_rejects_unbound_or_wrong_target_terminal_proof():
    bus = UiBus()
    command, error = bus.emit(
        "events.stage_annotation",
        {"event_id": "event-1", "label": "HFO"},
        "stage review label",
        authority_scope=_issuance_scope("desktop-state-proof"),
    )
    assert error is None and command is not None

    for proof in (
        None,
        {
            "source": "backend_readback",
            "event_id": "event-999",
            "run_id": "qc-run-1",
            "backend_status": "complete",
            "requested_annotation_label": "HFO",
            "expected_annotation_label": "HFO",
            "observed_annotation_label": "HFO",
            "annotation_present": True,
            "annotation_cleared": False,
        },
    ):
        outcome = {
            "status": "complete",
            "command_type": "events.stage_annotation",
            **_scope("desktop-state-proof"),
        }
        if proof is not None:
            outcome["terminal_proof"] = proof
        receipt, error = bus.record_ack(command["command_id"], outcome)
        assert receipt is None
        assert error == "terminal review success requires command-bound observed postcondition evidence"
        assert bus.get_ack(command["command_id"])["status"] == "queued"


def test_unknown_command_ack_is_rejected_without_creating_a_receipt():
    bus = UiBus()
    receipt, error = bus.record_ack("mcp-never-issued", {"status": "complete", "operation_id": "x"})
    assert receipt is None
    assert error == "unknown command_id; ACK rejected"
    assert bus.get_ack("mcp-never-issued") == {}


def test_broker_health_is_public_but_all_ui_routes_fail_closed_without_a_token(monkeypatch):
    monkeypatch.delenv("IEEG_UI_BROKER_TOKEN", raising=False)
    server = build_server("127.0.0.1", 0, bus=UiBus(), token=None)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        with urllib.request.urlopen(f"{base_url}/health", timeout=2) as response:
            assert response.status == 200
        with pytest.raises(urllib.error.HTTPError) as unauthorized:
            urllib.request.urlopen(f"{base_url}/ui/state", timeout=2)
        assert unauthorized.value.code == 401
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_broker_accepts_the_exact_shared_bearer_token():
    server = build_server("127.0.0.1", 0, bus=UiBus(), token="desktop-secret")
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        request = urllib.request.Request(
            f"{base_url}/ui/state",
            headers={"authorization": "Bearer desktop-secret"},
        )
        with urllib.request.urlopen(request, timeout=2) as response:
            assert response.status == 200
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_receipt_persistence_failure_rolls_back_emit_and_ack(monkeypatch, tmp_path: Path):
    ack_bus = UiBus(receipt_store=tmp_path / "ack-receipts.json")
    command, error = ack_bus.emit("workspace.reset_waveform_view", {}, "reset")
    assert error is None and command is not None

    def fail_replace(_source, _target):
        raise OSError("disk unavailable")

    monkeypatch.setattr(broker_module.os, "replace", fail_replace)
    receipt, error = ack_bus.record_ack(command["command_id"], {"status": "noop"})
    assert receipt is None and "receipt persistence failed" in str(error)
    assert ack_bus.get_ack(command["command_id"])["status"] == "queued"

    emit_bus = UiBus(receipt_store=tmp_path / "emit-receipts.json")
    emitted, error = emit_bus.emit("workspace.reset_waveform_view", {}, "reset")
    assert emitted is None and "receipt persistence failed" in str(error)
    assert emit_bus.pending == []
    assert emit_bus.get_ack() == {}


def test_transition_ledger_is_append_only_with_bounded_retention():
    bus = UiBus()
    command, error = bus.emit("workspace.reset_waveform_view", {}, "reset")
    assert error is None and command is not None

    receipt = bus.get_ack(command["command_id"])
    for _ in range(70):
        receipt, error = bus.record_ack(command["command_id"], {"status": "queued"})
        assert error is None and receipt is not None

    _validate_receipt(receipt)
    assert receipt["transition_count"] == 71
    assert len(receipt["transitions"]) == bus._TRANSITIONS_MAX
    sequences = [transition["sequence"] for transition in receipt["transitions"]]
    assert sequences == list(range(7, 71))


def test_idempotent_retry_reuses_command_id_and_recovers_queued_command_after_restart(tmp_path: Path):
    store = tmp_path / "receipts.json"
    first = UiBus(receipt_store=store)
    command, error = first.emit("analysis.run_qc", {}, "qc", "qc-retry-key")
    assert error is None and command is not None
    command_id = command["command_id"]
    assert len(first.drain()) == 1

    restarted = UiBus(receipt_store=store)
    recovered, error = restarted.emit("analysis.run_qc", {}, "qc retry", "qc-retry-key")
    assert error is None and recovered is not None
    assert recovered["command_id"] == command_id
    assert recovered["deduplicated"] is True
    assert recovered["recovered_after_restart"] is True
    assert [entry["command_id"] for entry in restarted.drain()] == [command_id]

    duplicate, error = restarted.emit("analysis.run_qc", {}, "same process retry", "qc-retry-key")
    assert error is None and duplicate is not None
    assert duplicate["command_id"] == command_id
    assert restarted.drain() == []

    mismatch, error = restarted.emit("analysis.run_qc", {"scope": "different"}, "bad retry", "qc-retry-key")
    assert mismatch is None
    assert error == "idempotency key was already used for a different command effect"

    new_command, error = restarted.emit("analysis.run_qc", {}, "new invocation")
    assert error is None and new_command is not None
    assert new_command["command_id"] != command_id
