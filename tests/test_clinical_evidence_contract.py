from __future__ import annotations

import asyncio
import copy
import hashlib
import json
from pathlib import Path

import pytest

from runtime.agent_runtime.clinical_evidence import (
    ResearchOutputContractError,
    _severity_score_contract_error,
    evidence_codes,
    find_research_output,
    requires_research_output,
    validate_research_output,
)
from runtime.agent_runtime.action_receipts import review_receipt_scope_sha256
from runtime.agent_runtime.final_output import RuntimeFinalOutputCoordinator
from runtime.agent_runtime.execution_attestation import (
    EXECUTION_ATTESTATION_VERSION,
    TRUSTED_EVIDENCE_KINDS_BY_TOOL,
    canonical_json_sha256,
)
from runtime.skills.models import ExecutionPlan, ExecutionState, ExecutionStep, StepResult
from ui_mcp.broker import UiBus


SCHEMA_PATH = (
    Path(__file__).resolve().parents[1]
    / "contracts"
    / "agent"
    / "schemas"
    / "research-output-v1.schema.json"
)


def test_severity_evidence_requires_scalp_based_identity_digests_and_real_scores():
    valid = {
        "eeg_type": "scalp",
        "model_name": "BASED",
        "model_version": "based-severity-deadbeefcafe",
        "model_sha256": "a" * 64,
        "parameters_sha256": "b" * 64,
        "result_sha256": "c" * 64,
        "num_segments": 8,
        "num_clean_segments": 7,
        "mean_score": 1.2,
        "peak_score": 3.4,
        "peak_time_sec": 45.0,
        "clean_mean_score": 1.0,
        "clean_peak_score": 3.0,
        "clean_peak_time_sec": 45.0,
    }
    assert _severity_score_contract_error(valid) is None
    for invalid in (
        {**valid, "eeg_type": "ieeg"},
        {**valid, "model_name": "untrusted"},
        {**valid, "num_segments": 0, "num_clean_segments": 0},
        {**valid, "mean_score": "bogus"},
        {**valid, "clean_peak_time_sec": -1},
    ):
        assert _severity_score_contract_error(invalid) is not None


def _base_payload():
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    return copy.deepcopy(schema["x-ieeg-examples"][0]["value"])


def _execution_evidence(payload):
    """Build the adapter-owned ledger shape from the fixture's observed values."""

    grouped = {}
    for item in payload.get("evidence", []):
        source = item.get("source")
        if not source:
            continue
        record = grouped.setdefault(
            source,
            {
                "tool_name": source,
                "result": {
                    "observations": [],
                    "event_ids": [],
                    "run_ids": list(payload["run_ids"]),
                },
            },
        )
        record["result"]["observations"].append(copy.deepcopy(item.get("value")))
        if item.get("event_id"):
            record["result"]["event_ids"].append(item["event_id"])
    algorithm = payload.get("provenance", {}).get("algorithm")
    if algorithm and algorithm not in grouped:
        grouped[algorithm] = {
            "tool_name": algorithm,
            "result": {"observations": [], "event_ids": [], "run_ids": list(payload["run_ids"])},
        }
    recording = copy.deepcopy(payload.get("provenance", {}).get("recording") or {})
    artifacts = copy.deepcopy(payload.get("artifacts") or [])
    for source, record in grouped.items():
        result = record["result"]
        parameters = (
            copy.deepcopy(payload["provenance"]["parameters"])
            if source == algorithm
            else {}
        )
        attestation = {
            "attestation_version": EXECUTION_ATTESTATION_VERSION,
            "tool_name": source,
            "result_sha256": canonical_json_sha256(result),
            "recording_fingerprint": payload["recording_fingerprint"],
            "source_recording_fingerprint": payload["recording_fingerprint"],
            "input_recording_fingerprint": payload["recording_fingerprint"],
            "state_revision": payload["state_revision"],
            "run_ids": list(payload["run_ids"]),
            "event_ids": list(result["event_ids"]),
            "evidence_kinds": sorted(TRUSTED_EVIDENCE_KINDS_BY_TOOL.get(source, ())),
            "software_version": payload["provenance"]["software_version"],
            "algorithm": source,
            "algorithm_version": payload["provenance"]["algorithm_version"],
            "effective_parameters": parameters,
            "parameters_sha256": canonical_json_sha256(parameters),
            "software_components": copy.deepcopy(payload["provenance"]["software_components"]),
            "recording_metadata": recording,
            "artifacts": artifacts,
        }
        record["execution_provenance"] = attestation
    return list(grouped.values())


def _validate_bound(payload, *, receipts=None, **kwargs):
    return validate_research_output(
        payload,
        receipts=receipts,
        execution_evidence=_execution_evidence(payload),
        **kwargs,
    )


def _review_receipt_scope(state_revision: str = "desktop-state-contract") -> dict:
    return {
        "request_id": "req-20260715-001",
        "message_id": "msg-17",
        "conversation_id": "conv-42",
        "state_revision": state_revision,
        "recording_fingerprint": "a" * 64,
    }


def _review_issuance_scope(state_revision: str = "desktop-state-contract") -> dict:
    receipt_scope = _review_receipt_scope(state_revision)
    return {
        **receipt_scope,
        "session_id": "workspace-session-1",
        "resource_scope": {
            "recording_sha256": receipt_scope["recording_fingerprint"],
            "state_revision": state_revision,
        },
    }


def _terminal_review_receipt(
    *,
    run_id: str = "qc-run-1",
    state_revision: str = "desktop-state-contract",
    label: str = "HFO",
    proof_label: str | None = None,
    notes: str | None = None,
):
    bus = UiBus(receipt_store=None)
    command_payload = {"event_id": "event-1", "label": label}
    if notes is not None:
        command_payload["notes"] = notes
    command, error = bus.emit(
        "events.stage_annotation",
        command_payload,
        "record reviewed label",
        authority_scope=_review_issuance_scope(state_revision),
    )
    assert error is None and command is not None
    readback_label = proof_label if proof_label is not None else label
    cleared = readback_label.strip().lower() == "clear"
    receipt, error = bus.record_ack(
        command["command_id"],
        {
            "status": "complete",
            "command_type": "events.stage_annotation",
            **_review_receipt_scope(state_revision),
            "approval_actor": {
                "role": "clinician",
                "actor_id": "clinician-1",
                "session_id": "workspace-session-1",
                "source": "desktop_renderer",
            },
            "terminal_proof": {
                "source": "backend_readback",
                "event_id": "event-1",
                "run_id": run_id,
                "backend_status": "complete",
                "requested_annotation_label": readback_label,
                "expected_annotation_label": readback_label,
                "observed_annotation_label": None if cleared else readback_label,
                "annotation_present": not cleared,
                "annotation_cleared": cleared,
            },
        },
    )
    assert error is None and receipt is not None
    return receipt


def _reviewed_candidate_payload(
    receipt,
    *,
    label: str = "HFO",
    assertion: str = "Candidate 1 was reviewed as HFO.",
    notes: str | None = None,
):
    payload = _base_payload()
    review_payload = {"event_id": "event-1", "label": label}
    if notes is not None:
        review_payload["notes"] = notes
    payload["claims"] = [
        {
            "claim_id": "candidate-1",
            "kind": "candidate",
            "assertion": assertion,
            "epistemic_status": "confirmed",
            "run_ids": ["qc-run-1"],
            "evidence_refs": ["candidate-evidence-1"],
            "review_receipt_id": receipt["receipt_id"],
            "review_actor": {
                "actor_id": "clinician-1",
                "role": "clinician",
                "session_id_sha256": hashlib.sha256(b"workspace-session-1").hexdigest(),
            },
            "review_command_payload": review_payload,
        }
    ]
    payload["evidence"] = [
        {
            "evidence_id": "candidate-evidence-1",
            "kind": "detector_candidate",
            "source": "pyhfo_detect_events",
            "recording_id": "recording-aaaaaaaaaaaaaaaaaaaaaaaa",
            "run_id": "qc-run-1",
            "event_id": "event-1",
            "value": {"candidate": True},
        }
    ]
    payload["summary"] = assertion
    return payload


def _state_with(payload):
    step = ExecutionStep(
        step_id="s1",
        skill_name="final_synthesizer",
        goal="produce research output",
        instructions="produce structured output",
        step_type="synthesis",
        is_final_step=True,
    )
    state = ExecutionState(
        conversation_id="conv-42",
        current_turn_id="turn-1",
        request_id="req-20260715-001",
        message_id=payload["message_id"],
        state_revision=payload["state_revision"],
        plan=ExecutionPlan(
            user_goal="review recording",
            routing_reason="fast path test",
            routing_method="fast_path",
            steps=[step],
            planner_metrics={"fast_path": True},
        ),
    )
    state.research_evidence_ledger = _execution_evidence(payload)
    state.step_results[step.step_id] = StepResult(
        step_id=step.step_id,
        skill_name=step.skill_name,
        success=True,
        summary="structured output ready",
        output={"structured_output": payload},
        raw_text="Evidence ready.",
    )
    return state


def test_canonical_schema_example_is_accepted_by_runtime_validator():
    payload = _base_payload()
    assert _validate_bound(payload) == ()
    assert {
        "unbound_recording_fingerprint",
        "unbound_state_revision",
        "unbound_run_ids",
        "unbound_evidence_item",
    } <= evidence_codes(validate_research_output(payload))


def test_candidate_cannot_be_confirmed_without_bound_terminal_clinician_receipt():
    receipt = _terminal_review_receipt()
    payload = _reviewed_candidate_payload(receipt)

    assert "review_without_receipt" in evidence_codes(validate_research_output(payload))
    assert _validate_bound(payload, receipts=[receipt]) == ()

    wrong_actor = copy.deepcopy(receipt)
    wrong_actor["actor"]["actor_id_sha256"] = hashlib.sha256(b"someone-else").hexdigest()
    wrong_actor["scope_sha256"] = review_receipt_scope_sha256(wrong_actor)
    assert "review_actor_mismatch" in evidence_codes(
        validate_research_output(payload, receipts=[wrong_actor])
    )

    wrong_event = copy.deepcopy(payload)
    wrong_event["evidence"][0]["event_id"] = "event-999"
    assert "review_event_mismatch" in evidence_codes(
        validate_research_output(wrong_event, receipts=[receipt])
    )

    wrong_payload = copy.deepcopy(payload)
    wrong_payload["claims"][0]["review_command_payload"]["event_id"] = "event-999"
    wrong_payload["evidence"][0]["event_id"] = "event-999"
    assert "review_payload_digest_mismatch" in evidence_codes(
        validate_research_output(wrong_payload, receipts=[receipt])
    )

    wrong_run_receipt = _terminal_review_receipt(run_id="wrong-run")
    wrong_run_claim = copy.deepcopy(payload)
    wrong_run_claim["claims"][0]["review_receipt_id"] = wrong_run_receipt["receipt_id"]
    assert "review_run_mismatch" in evidence_codes(
        validate_research_output(wrong_run_claim, receipts=[wrong_run_receipt])
    )

    multi_event = copy.deepcopy(payload)
    multi_event["claims"][0]["evidence_refs"].append("candidate-evidence-2")
    multi_event["evidence"].append(
        {
            **copy.deepcopy(multi_event["evidence"][0]),
            "evidence_id": "candidate-evidence-2",
            "event_id": "event-2",
        }
    )
    assert "review_scope_not_exhaustive" in evidence_codes(
        _validate_bound(multi_event, receipts=[receipt])
    )


@pytest.mark.parametrize("label", ["artifact", "rejected", "uncertain"])
def test_review_label_cannot_be_quoted_with_opposite_hfo_polarity(label):
    receipt = _terminal_review_receipt(label=label)
    payload = _reviewed_candidate_payload(
        receipt,
        label=label,
        assertion="Candidate 1 was reviewed as HFO.",
    )

    assert "review_semantic_mismatch" in evidence_codes(
        _validate_bound(payload, receipts=[receipt])
    )


def test_review_terminal_readback_and_optional_notes_are_exactly_bound():
    bus = UiBus(receipt_store=None)
    command, error = bus.emit(
        "events.stage_annotation",
        {"event_id": "event-1", "label": "HFO"},
        "record reviewed label",
        authority_scope=_review_issuance_scope(),
    )
    assert error is None and command is not None
    receipt, error = bus.record_ack(
        command["command_id"],
        {
            "status": "complete",
            "command_type": "events.stage_annotation",
            **_review_receipt_scope(),
            "approval_actor": {
                "role": "clinician",
                "actor_id": "clinician-1",
                "session_id": "workspace-session-1",
                "source": "desktop_renderer",
            },
            "terminal_proof": {
                "source": "backend_readback",
                "event_id": "event-1",
                "run_id": "qc-run-1",
                "backend_status": "complete",
                "requested_annotation_label": "artifact",
                "expected_annotation_label": "artifact",
                "observed_annotation_label": "artifact",
                "annotation_present": True,
                "annotation_cleared": False,
            },
        },
    )
    assert receipt is None
    assert "command-bound observed postcondition" in str(error)

    receipt_with_notes = _terminal_review_receipt(
        label="HFO",
        notes="Reviewed against the event waveform.",
    )
    payload_with_notes = _reviewed_candidate_payload(
        receipt_with_notes,
        notes="Reviewed against the event waveform.",
    )
    assert _validate_bound(payload_with_notes, receipts=[receipt_with_notes]) == ()


def test_cleared_annotation_receipt_cannot_confirm_a_candidate():
    bus = UiBus(receipt_store=None)
    command, error = bus.emit(
        "events.clear_staged_annotation",
        {"event_id": "event-1"},
        "clear reviewed label",
        authority_scope=_review_issuance_scope(),
    )
    assert error is None and command is not None
    receipt, error = bus.record_ack(
        command["command_id"],
        {
            "status": "complete",
            "command_type": "events.clear_staged_annotation",
            **_review_receipt_scope(),
            "approval_actor": {
                "role": "clinician",
                "actor_id": "clinician-1",
                "session_id": "workspace-session-1",
                "source": "desktop_renderer",
            },
            "terminal_proof": {
                "source": "backend_readback",
                "event_id": "event-1",
                "run_id": "qc-run-1",
                "backend_status": "complete",
                "observed_annotation_label": None,
                "annotation_present": False,
                "annotation_cleared": True,
            },
        },
    )
    assert error is None and receipt is not None
    payload = _reviewed_candidate_payload(receipt, label="clear", assertion="Candidate 1 is a confirmed HFO.")
    assert {"invalid_review_receipt", "review_payload_digest_mismatch"} <= evidence_codes(
        _validate_bound(payload, receipts=[receipt])
    )


def test_confirmation_wording_cannot_hide_behind_model_selected_observed_status():
    receipt = _terminal_review_receipt()
    payload = _reviewed_candidate_payload(
        receipt,
        assertion="Candidate 1 is a confirmed HFO.",
    )
    claim = payload["claims"][0]
    claim["epistemic_status"] = "observed"
    for field in ("review_receipt_id", "review_actor", "review_command_payload"):
        claim.pop(field, None)

    codes = evidence_codes(_validate_bound(payload))
    assert {"review_language_status_mismatch", "candidate_confirmation_without_receipt"} <= codes


def test_model_authored_evidence_metadata_cannot_self_attest_claim_semantics():
    payload = _base_payload()
    payload["evidence"][0]["channel"] = "ZZ99"
    payload["claims"][0]["assertion"] = "ZZ99 is flat in the evaluated interval."
    payload["summary"] = "ZZ99 is flat in the evaluated interval."

    codes = evidence_codes(_validate_bound(payload))
    assert {"unbound_evidence_item", "claim_references_unbound_evidence"} <= codes

    for field, value in (("unit", "Hz"), ("source_uri", "urn:invented:evidence")):
        forged = _base_payload()
        forged["evidence"][0][field] = value
        assert "unbound_evidence_item" in evidence_codes(_validate_bound(forged))


def test_summary_and_limitations_cannot_launder_unbound_case_findings():
    summary = _base_payload()
    summary["summary"] = "A9 shows HFO activity."
    assert "unbound_summary_semantics" in evidence_codes(_validate_bound(summary))

    limitation = _base_payload()
    limitation["limitations"] = ["Channel ZZ99 demonstrates candidate activity."]
    assert "unbound_limitation_semantics" in evidence_codes(_validate_bound(limitation))

    claim_limitation = _base_payload()
    claim_limitation["claims"][0]["limitations"] = [
        "Channel ZZ99 demonstrates candidate activity."
    ]
    assert "unbound_claim_limitation" in evidence_codes(_validate_bound(claim_limitation))


def test_review_receipt_is_bound_to_exact_state_and_exposed_event_scope():
    valid_receipt = _terminal_review_receipt()
    forged_partial_receipt = {
        "receipt_id": valid_receipt["receipt_id"],
        "status": "complete",
        "terminal": True,
        "success": True,
        "effect": "review_write",
        "state_revision": "desktop-state-contract",
    }
    forged_payload = _reviewed_candidate_payload(valid_receipt)
    assert "review_without_receipt" in evidence_codes(
        _validate_bound(forged_payload, receipts=[forged_partial_receipt])
    )

    stale_receipt = _terminal_review_receipt(state_revision="desktop-state-stale")
    stale_payload = _reviewed_candidate_payload(stale_receipt)
    assert "review_state_revision_mismatch" in evidence_codes(
        _validate_bound(stale_payload, receipts=[stale_receipt])
    )

    receipt = _terminal_review_receipt()
    hidden_scope = _reviewed_candidate_payload(receipt)
    hidden_scope["evidence"][0]["value"]["event_ids"] = ["event-1", "event-2"]
    codes = evidence_codes(_validate_bound(hidden_scope, receipts=[receipt]))
    assert {"evidence_scope_mismatch", "review_scope_not_exhaustive"} <= codes


def test_hfo_annotation_receipt_cannot_establish_soz():
    receipt = _terminal_review_receipt()
    payload = _reviewed_candidate_payload(receipt)
    payload["claims"][0].update(
        {
            "kind": "soz",
            "assertion": "A1 is the SOZ.",
        }
    )
    payload["evidence"][0].update(
        {
            "kind": "annotation",
            "source": "events.stage_annotation",
            "channel": "A1",
            "value": {"channel": "A1", "label": "HFO"},
        }
    )

    codes = evidence_codes(_validate_bound(payload, receipts=[receipt]))
    assert {"review_semantic_mismatch", "unsupported_soz_claim"} <= codes


def test_run_review_receipt_binds_to_the_claim_run():
    bus = UiBus(receipt_store=None)
    command, error = bus.emit(
        "review.accept_run",
        {"run_id": "qc-run-1"},
        "accept reviewed run",
        authority_scope=_review_issuance_scope(),
    )
    assert error is None and command is not None
    receipt, error = bus.record_ack(
        command["command_id"],
        {
            "status": "complete",
            "command_type": "review.accept_run",
            **_review_receipt_scope(),
            "approval_actor": {
                "role": "clinician",
                "actor_id": "clinician-1",
                "session_id": "workspace-session-1",
                "source": "desktop_renderer",
            },
            "terminal_proof": {
                "source": "renderer_state_transition",
                "accepted_run_id": "qc-run-1",
                "accepted_flag": True,
            },
        },
    )
    assert error is None and receipt is not None

    payload = _base_payload()
    claim = payload["claims"][0]
    claim.update(
        {
            "epistemic_status": "reviewed",
            "review_receipt_id": receipt["receipt_id"],
            "review_actor": {
                "actor_id": "clinician-1",
                "role": "clinician",
                "session_id_sha256": hashlib.sha256(b"workspace-session-1").hexdigest(),
            },
            "review_command_payload": {"run_id": "qc-run-1"},
        }
    )
    assert _validate_bound(payload, receipts=[receipt]) == ()

    wrong_run = copy.deepcopy(payload)
    wrong_run["claims"][0]["review_command_payload"] = {"run_id": "other-run"}
    assert "review_run_mismatch" in evidence_codes(
        validate_research_output(wrong_run, receipts=[receipt])
    )

    multi_run = copy.deepcopy(payload)
    multi_run["run_ids"] = ["qc-run-1", "qc-run-2"]
    multi_run["provenance"]["run_scope"] = {
        "mode": "explicit_multi_run",
        "run_ids": ["qc-run-1", "qc-run-2"],
        "aggregation_method": "side-by-side",
    }
    multi_run["guardrails"]["aggregation_scope"] = "explicit_multi_run"
    multi_run["claims"][0]["run_ids"] = ["qc-run-1", "qc-run-2"]
    assert "review_scope_not_exhaustive" in evidence_codes(
        _validate_bound(multi_run, receipts=[receipt])
    )


def test_qc_anatomy_and_soz_claims_are_evidence_calibrated():
    payload = _base_payload()
    payload["claims"] = [
        {
            "claim_id": "qc-1",
            "kind": "qc",
            "assertion": "QC diagnoses epilepsy from this interval.",
            "epistemic_status": "derived",
            "run_ids": ["qc-run-1"],
            "evidence_refs": ["qc-evidence"],
        },
        {
            "claim_id": "soz-1",
            "kind": "soz",
            "assertion": "The channel is the SOZ.",
            "epistemic_status": "derived",
            "run_ids": ["qc-run-1"],
            "evidence_refs": ["channel-evidence"],
        },
    ]
    payload["evidence"] = [
        {
            "evidence_id": "qc-evidence",
            "kind": "quality_control",
            "source": "pyhfo_analyze_recording_qc",
            "recording_id": "recording-aaaaaaaaaaaaaaaaaaaaaaaa",
            "run_id": "qc-run-1",
            "value": {"finding": "flat"},
        },
        {
            "evidence_id": "channel-evidence",
            "kind": "recording_metadata",
            "source": "channel_label",
            "recording_id": "recording-aaaaaaaaaaaaaaaaaaaaaaaa",
            "run_id": "qc-run-1",
            "value": {"channel": "A1"},
        },
    ]
    codes = evidence_codes(validate_research_output(payload))
    assert {"qc_cannot_diagnose", "unsupported_soz_claim", "soz_inference_forbidden"} <= codes


def test_top_level_summary_cannot_smuggle_an_untyped_diagnosis_or_soz_claim():
    payload = _base_payload()
    payload["summary"] = "A1 is the seizure-onset zone and this establishes epilepsy."
    assert "unsupported_summary_claim" in evidence_codes(validate_research_output(payload))

    disclaimer_laundering = _base_payload()
    disclaimer_laundering["summary"] = "A1 is epileptogenic; this is not a diagnosis."
    assert "unsupported_summary_claim" in evidence_codes(
        validate_research_output(disclaimer_laundering)
    )


def test_model_controlled_arguments_cannot_self_attest_execution_scope():
    payload = _base_payload()
    forged_ledger = [
        {
            "tool_name": "pyhfo_compute_channel_qc",
            "arguments": {
                "recording_fingerprint": payload["recording_fingerprint"],
                "state_revision": payload["state_revision"],
                "run_id": "qc-run-1",
                "evidence_kind": "quality_control",
            },
            "result": {
                "observations": [copy.deepcopy(payload["evidence"][0]["value"])],
                "run_ids": ["qc-run-1"],
            },
        }
    ]

    codes = evidence_codes(validate_research_output(payload, execution_evidence=forged_ledger))
    assert {
        "unbound_recording_fingerprint",
        "unbound_state_revision",
        "unbound_run_ids",
        "unbound_evidence_item",
        "unbound_execution_provenance",
    } <= codes


def test_claim_values_kinds_and_semantics_must_project_from_attested_results():
    original = _base_payload()
    ledger = _execution_evidence(original)

    wrong_channel = copy.deepcopy(original)
    wrong_channel["claims"][0]["assertion"] = "B9 is flat in the evaluated interval."
    assert "unbound_claim_semantics" in evidence_codes(
        validate_research_output(wrong_channel, execution_evidence=ledger)
    )

    forged_kind = copy.deepcopy(original)
    forged_kind["claims"][0].update(
        {
            "kind": "candidate",
            "assertion": "A1 is a detector candidate.",
        }
    )
    forged_kind["evidence"][0]["kind"] = "detector_candidate"
    codes = evidence_codes(validate_research_output(forged_kind, execution_evidence=ledger))
    assert {"unbound_evidence_item", "claim_references_unbound_evidence"} <= codes

    forged_count = copy.deepcopy(original)
    forged_count["claims"][0] = {
        "claim_id": "claim-count-1",
        "kind": "numeric",
        "assertion": "There are 999 HFO candidates.",
        "epistemic_status": "derived",
        "evidence_refs": ["evidence-qc-1"],
        "run_ids": ["qc-run-1"],
        "value": 999,
        "units": "candidates",
        "denominator": "evaluated interval",
        "scope": {
            "level": "run",
            "recording_id": "recording-aaaaaaaaaaaaaaaaaaaaaaaa",
            "run_id": "qc-run-1",
        },
        "partial_failure_status": "none",
    }
    assert "unbound_numeric_value" in evidence_codes(
        validate_research_output(forged_count, execution_evidence=ledger)
    )

    scalar_collision = copy.deepcopy(forged_count)
    scalar_collision["claims"][0].update(
        {
            "assertion": "There are 2000 HFO candidates.",
            "value": 2000,
        }
    )
    scalar_collision["evidence"][0]["value"] = {"sampling_frequency_hz": 2000}
    assert "unbound_numeric_value" in evidence_codes(
        validate_research_output(
            scalar_collision,
            execution_evidence=_execution_evidence(scalar_collision),
        )
    )


def test_public_provenance_recording_metadata_and_artifacts_require_attestation():
    original = _base_payload()
    ledger = _execution_evidence(original)

    forged_provenance = copy.deepcopy(original)
    forged_provenance["provenance"]["software_version"] = "invented-runtime@9.9.9"
    forged_provenance["provenance"]["algorithm_version"] = "invented-adapter.v9"
    forged_provenance["provenance"]["parameters"] = {"max_duration_seconds": 999}
    forged_provenance["provenance"]["parameters_sha256"] = canonical_json_sha256(
        forged_provenance["provenance"]["parameters"]
    )
    forged_provenance["provenance"]["recording"]["sampling_frequency_hz"] = 9999
    codes = evidence_codes(
        validate_research_output(forged_provenance, execution_evidence=ledger)
    )
    assert {"unbound_execution_provenance", "unbound_recording_metadata"} <= codes

    artifact = {
        "artifact_id": "artifact-invented",
        "kind": "report",
        "uri": f"artifact://sha256/{'f' * 64}",
        "sha256": "f" * 64,
        "created_by": "ieeg-agent",
        "created_at": "2026-07-15T18:00:00Z",
        "run_id": "qc-run-1",
    }
    attested_artifact = copy.deepcopy(original)
    attested_artifact["artifacts"] = [artifact]
    assert _validate_bound(attested_artifact) == ()

    fabricated_artifact = copy.deepcopy(original)
    fabricated_artifact["artifacts"] = [artifact]
    assert "unbound_artifact" in evidence_codes(
        validate_research_output(fabricated_artifact, execution_evidence=ledger)
    )


def test_empty_or_mistyped_claims_cannot_smuggle_case_results():
    empty = _base_payload()
    empty["summary"] = "Detected 12 HFO candidates in this recording."
    empty["claims"] = []
    empty["evidence"] = []
    assert {"missing_claims", "missing_evidence", "unsupported_summary_claim"} <= evidence_codes(
        validate_research_output(empty)
    )

    mistyped = _base_payload()
    mistyped["claims"][0].update(
        {
            "kind": "summary",
            "assertion": "A1 is the SOZ.",
        }
    )
    assert {"unsupported_summary_claim", "claim_kind_mismatch"} <= evidence_codes(
        _validate_bound(mistyped)
    )

    diagnostic = _base_payload()
    diagnostic["claims"][0].update(
        {"kind": "candidate", "assertion": "A1 appears epileptogenic."}
    )
    assert "unsupported_diagnostic_claim" in evidence_codes(_validate_bound(diagnostic))


def test_ranking_and_numeric_claims_require_explicit_run_and_scope():
    payload = _base_payload()
    payload["run_ids"] = ["run-1", "run-2"]
    payload["provenance"]["run_scope"] = {
        "mode": "explicit_multi_run",
        "run_ids": ["run-1", "run-2"],
        "aggregation_method": "side-by-side",
    }
    payload["guardrails"]["aggregation_scope"] = "explicit_multi_run"
    payload["claims"] = [
        {
            "claim_id": "rank-1",
            "kind": "ranking",
            "assertion": "G23 ranks first.",
            "epistemic_status": "derived",
            "run_ids": ["run-1", "run-2"],
            "evidence_refs": ["ranking-evidence"],
        },
        {
            "claim_id": "num-1",
            "kind": "numeric",
            "assertion": "There were 12 candidates.",
            "epistemic_status": "observed",
            "run_ids": ["run-1"],
            "evidence_refs": ["numeric-evidence"],
        },
    ]
    payload["evidence"] = [
        {
            "evidence_id": "ranking-evidence",
            "kind": "channel_ranking",
            "source": "ranking",
            "recording_id": "recording-aaaaaaaaaaaaaaaaaaaaaaaa",
            "run_id": "run-1",
            "value": {"channel": "G23", "rank": 1},
        },
        {
            "evidence_id": "numeric-evidence",
            "kind": "detector_candidate",
            "source": "events",
            "recording_id": "recording-aaaaaaaaaaaaaaaaaaaaaaaa",
            "run_id": "run-1",
            "value": {"count": 12},
        },
    ]
    codes = evidence_codes(validate_research_output(payload))
    assert {
        "ranking_requires_single_run",
        "missing_value",
        "missing_units",
        "missing_denominator",
        "missing_scope",
    } <= codes


def test_effective_parameter_digest_and_unknown_fields_fail_closed():
    payload = _base_payload()
    payload["provenance"]["parameters"]["max_duration_seconds"] = 61
    payload["patient_name"] = "must-not-cross-contract"
    codes = evidence_codes(validate_research_output(payload))
    assert {"parameters_digest_mismatch", "unknown_field"} <= codes


def test_public_research_output_rejects_clinical_ids_secrets_and_local_paths():
    payload = _base_payload()
    payload["summary"] = "MRN: 12345 was loaded from /Users/doctor/Patient A/session.edf"
    payload["artifacts"] = [
        {
            "artifact_id": "artifact-1",
            "kind": "report",
            "uri": "file:///Users/doctor/Patient A/report.pdf",
            "sha256": "f" * 64,
            "created_by": "ieeg-agent",
            "created_at": "2026-07-15T18:00:00Z",
            "run_id": "qc-run-1",
        }
    ]
    codes = evidence_codes(validate_research_output(payload))
    assert {"sensitive_summary", "unsafe_artifact_uri"} <= codes


@pytest.mark.parametrize(
    "summary",
    [
        "Contact jane.doe@example.org for details.",
        "Call +1-415-555-1212 for the case.",
        "Case accession ACC-12345 was reviewed.",
        "Address: 123 Main Street",
        "/Users/Jane Doe/private/session",
        r"C:\Users\Jane Doe\private\session",
    ],
)
def test_public_research_output_rejects_common_phi_signatures_and_spaced_paths(summary):
    payload = _base_payload()
    payload["summary"] = summary
    assert "sensitive_summary" in evidence_codes(_validate_bound(payload))


@pytest.mark.parametrize(
    ("target", "value"),
    [
        (("provenance", "parameters"), {"MRN": "123456"}),
        (("provenance", "algorithm_details", "parameters"), {"token": "sk-secret-value"}),
        (("evidence", 0, "value"), {"source_file": "/Users/doctor/Patient A/a.edf"}),
        (("evidence", 0, "value"), {"nested": {"patient_identifier": "subject-123"}}),
        (("evidence", 0, "value"), {"nested": {"medical_record_number": "123456"}}),
        (("evidence", 0, "value"), {"nested": {"participant_name": "Patient Alice"}}),
        (("evidence", 0, "value"), {"nested": {"client_secret": "secret-value"}}),
        (("evidence", 0, "value"), {"nested": {"private_key": "-----BEGIN PRIVATE KEY-----"}}),
        (("evidence", 0, "value"), {"nested": {"file": "Patient A/session.edf"}}),
        (("evidence", 0, "value"), {"nested": {"patient_id_value": "PAT-123"}}),
        (("evidence", 0, "value"), {"nested": {"subject_identifier_raw": "SUBJECT-9"}}),
        (("evidence", 0, "value"), {"nested": {"access_token_value": "secret-token"}}),
        (("evidence", 0, "value"), {"nested": {"api_key_material": "secret-key"}}),
        (("evidence", 0, "source"), "token=sk-secret-value"),
    ],
)
def test_nested_public_research_values_are_redaction_safe(target, value):
    payload = _base_payload()
    if target[:2] == ("provenance", "algorithm_details"):
        payload["provenance"]["algorithm_details"] = {
            "name": "QC",
            "version": "1.0",
            "parameters": {},
            "parameters_sha256": hashlib.sha256(b"{}").hexdigest(),
        }
    cursor = payload
    for part in target[:-1]:
        cursor = cursor[part]
    cursor[target[-1]] = value
    if target[:2] == ("provenance", "parameters"):
        payload["provenance"]["parameters_sha256"] = hashlib.sha256(
            json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
    if target[:3] == ("provenance", "algorithm_details", "parameters"):
        payload["provenance"]["algorithm_details"]["parameters_sha256"] = hashlib.sha256(
            json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
    assert "unsafe_public_payload" in evidence_codes(validate_research_output(payload))


def test_final_output_coordinator_validates_before_accepting_terminal_success():
    coordinator = object.__new__(RuntimeFinalOutputCoordinator)
    valid = _base_payload()
    valid_state = _state_with(valid)

    result = asyncio.run(
        coordinator.evaluate_runtime_final_answer(
            conversation_id="conv-42",
            user_question="review recording",
            final_content="Evidence ready.",
            sources=[],
            state=valid_state,
        )
    )
    assert result.final_content.startswith(valid["summary"])
    assert "Evidence-linked findings" in result.final_content
    assert "Research use only" in result.final_content
    assert "Evidence ready." not in result.final_content
    assert valid_state.research_output == valid

    invalid = _base_payload()
    invalid["provenance"]["parameters_sha256"] = "0" * 64
    with pytest.raises(ResearchOutputContractError) as error:
        asyncio.run(
            coordinator.evaluate_runtime_final_answer(
                conversation_id="conv-42",
                user_question="review recording",
                final_content="Evidence ready.",
                sources=[],
                state=_state_with(invalid),
            )
        )
    assert "parameters_digest_mismatch" in evidence_codes(error.value.issues)


def test_case_specific_clinical_success_requires_structured_research_output():
    coordinator = object.__new__(RuntimeFinalOutputCoordinator)
    state = _state_with(_base_payload())
    state.step_results["s1"].output = {}
    state.step_results["s1"].raw_text = "QC proves epilepsy and channel A1 is SOZ."

    with pytest.raises(ResearchOutputContractError) as error:
        asyncio.run(
            coordinator.evaluate_runtime_final_answer(
                conversation_id="conv-42",
                user_question="Review this recording.",
                final_content="QC proves epilepsy and channel A1 is SOZ.",
                sources=[],
                state=state,
            )
        )
    assert evidence_codes(error.value.issues) == {"missing_research_output"}

    state.step_results["s1"].raw_text = "A1 appears epileptogenic."
    with pytest.raises(ResearchOutputContractError) as paraphrase_error:
        asyncio.run(
            coordinator.evaluate_runtime_final_answer(
                conversation_id="conv-42",
                user_question="Review this recording.",
                final_content="A1 appears epileptogenic.",
                sources=[],
                state=state,
            )
        )
    assert evidence_codes(paraphrase_error.value.issues) == {"missing_research_output"}


def test_generic_clinical_education_does_not_require_case_output():
    coordinator = object.__new__(RuntimeFinalOutputCoordinator)
    state = _state_with(_base_payload())
    state.plan.user_goal = "Explain a term"
    state.step_results["s1"].output = {}
    state.step_results["s1"].raw_text = "HFOs are brief high-frequency oscillations."

    result = asyncio.run(
        coordinator.evaluate_runtime_final_answer(
            conversation_id="conv-42",
            user_question="What are HFOs?",
            final_content="HFOs are brief high-frequency oscillations.",
            sources=[],
            state=state,
        )
    )
    assert result.final_content == "HFOs are brief high-frequency oscillations."

    state.recording_path = "/private/case.edf"
    result_with_loaded_recording = asyncio.run(
        coordinator.evaluate_runtime_final_answer(
            conversation_id="conv-42",
            user_question="What are HFOs?",
            final_content="HFOs are brief high-frequency oscillations.",
            sources=[],
            state=state,
        )
    )
    assert result_with_loaded_recording.final_content == "HFOs are brief high-frequency oscillations."


@pytest.mark.parametrize(
    ("question", "answer"),
    [
        ("Which contact is SOZ?", "LAH1-2 is the SOZ."),
        ("Which electrode is epileptogenic?", "LAH1-2 appears epileptogenic."),
        ("What is the likely seizure focus?", "The mesial temporal contact is the seizure focus."),
    ],
)
def test_common_case_diagnostic_phrasings_require_structured_output(question, answer):
    state = _state_with(_base_payload())
    state.step_results["s1"].output = {}
    state.recording_path = None
    state.skills_executed = []
    state.ui_commands = []
    assert requires_research_output(
        user_question=question,
        final_content=answer,
        state=state,
    )


@pytest.mark.parametrize(
    ("question", "answer"),
    [
        ("Which lead starts seizures?", "LAH1 is where seizures begin."),
        ("What is the ictal onset site?", "LAH1 is the ictal onset site."),
        ("How many HFO candidates are present?", "There are 12 HFO candidates."),
        ("Count the HFOs in this recording.", "The detector yielded twelve HFOs."),
    ],
)
def test_common_localization_and_count_paraphrases_cannot_bypass_structure(question, answer):
    state = _state_with(_base_payload())
    state.step_results["s1"].output = {}
    state.recording_path = None
    state.skills_executed = []
    state.ui_commands = []
    assert requires_research_output(
        user_question=question,
        final_content=answer,
        state=state,
    )


@pytest.mark.parametrize(
    ("question", "answer"),
    [
        ("Which lead starts seizures?", "The available evidence is insufficient to determine that."),
        ("How many HFO candidates are present?", "I cannot determine a count without a recording."),
        ("Localize the ictal onset site.", "No evidence supports an ictal-onset localization."),
    ],
)
def test_safe_negative_case_answers_do_not_falsely_require_structured_output(question, answer):
    state = _state_with(_base_payload())
    state.step_results["s1"].output = {}
    state.recording_path = None
    state.skills_executed = []
    state.ui_commands = []
    assert not requires_research_output(
        user_question=question,
        final_content=answer,
        state=state,
    )


def test_view_only_detection_parameter_command_does_not_force_research_output():
    state = _state_with(_base_payload())
    state.step_results["s1"].output = {}
    state.plan.user_goal = "Adjust the detector controls"
    state.recording_path = None
    state.skills_executed = []
    state.ui_commands = [{"type": "detection.set_parameters", "risk": "view"}]
    assert not requires_research_output(
        user_question="Set the detector controls to STE.",
        final_content="The detector controls are now set to STE.",
        state=state,
    )


def test_research_output_scope_must_match_the_active_turn():
    payload = _base_payload()
    codes = evidence_codes(
        validate_research_output(
            payload,
            expected_request_id="req-other",
            expected_conversation_id="conv-other",
            expected_message_id="msg-other",
            expected_state_revision="desktop-state-other",
            expected_response_language="zh-CN",
        )
    )
    assert {
        "request_scope_mismatch",
        "conversation_scope_mismatch",
        "message_scope_mismatch",
        "state_revision_mismatch",
        "response_language_mismatch",
    } <= codes


def test_structured_research_output_requires_runtime_request_scope():
    coordinator = object.__new__(RuntimeFinalOutputCoordinator)
    state = _state_with(_base_payload())
    state.request_id = None
    with pytest.raises(ResearchOutputContractError) as error:
        asyncio.run(
            coordinator.evaluate_runtime_final_answer(
                conversation_id="conv-42",
                user_question="Review this recording.",
                final_content="Evidence ready.",
                sources=[],
                state=state,
            )
        )
    assert evidence_codes(error.value.issues) == {"missing_runtime_request_scope"}


def test_unsupported_research_output_version_cannot_bypass_as_generic_structure():
    payload = _base_payload()
    payload["schema_version"] = "research-output.v2"
    state = _state_with(payload)
    with pytest.raises(ResearchOutputContractError) as error:
        find_research_output(state.step_results)
    assert evidence_codes(error.value.issues) == {"unsupported_schema_version"}
