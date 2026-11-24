from __future__ import annotations

import hashlib
import os

from runtime.agent_runtime.clinical_evidence import recording_fingerprint_for_path
from runtime.agent_runtime.execution_attestation import (
    EXECUTION_ATTESTATION_VERSION,
    build_execution_attestation,
    canonical_json_sha256,
)


def test_attestation_binds_exact_tool_result_and_adapter_owned_evidence_kind():
    result = {"run_id": "run-1", "flat_channels": ["A1"]}
    attestation = build_execution_attestation(
        tool_name="pyhfo_compute_channel_qc",
        call_parameters={"max_duration_seconds": 60},
        result_payload=result,
        source_recording_fingerprint="a" * 64,
        input_recording_fingerprint="a" * 64,
        state_revision="desktop-state-1",
        allowed_parameter_names={"max_duration_seconds"},
    )

    assert attestation["attestation_version"] == EXECUTION_ATTESTATION_VERSION
    assert attestation["tool_name"] == "pyhfo_compute_channel_qc"
    assert attestation["result_sha256"] == canonical_json_sha256(result)
    assert attestation["result_sha256"] != canonical_json_sha256(
        {"run_id": "run-1", "flat_channels": ["B9"]}
    )
    assert attestation["run_ids"] == ["run-1"]
    assert attestation["evidence_kinds"] == ["quality_control"]
    assert attestation["state_revision"] == "desktop-state-1"


def test_attestation_drops_paths_secrets_and_undeclared_model_arguments():
    attestation = build_execution_attestation(
        tool_name="pyhfo_compute_channel_qc",
        call_parameters={
            "input_path": "/private/Patient A/case.edf",
            "max_duration_seconds": 60,
            "client_secret": "secret-value",
            "model_claimed_run_id": "forged-run",
        },
        result_payload={"flat_channels": ["A1"]},
        source_recording_fingerprint="a" * 64,
        input_recording_fingerprint="b" * 64,
        allowed_parameter_names={
            "input_path",
            "max_duration_seconds",
            "client_secret",
        },
    )

    assert attestation["effective_parameters"] == {"max_duration_seconds": 60}
    assert attestation["parameters_sha256"] == canonical_json_sha256(
        {"max_duration_seconds": 60}
    )
    assert "forged-run" not in str(attestation)
    assert "/private/Patient A" not in str(attestation)
    assert "secret-value" not in str(attestation)
    assert attestation["source_recording_fingerprint"] == "a" * 64
    assert attestation["input_recording_fingerprint"] == "b" * 64
    assert attestation["derived_input_fingerprint"] == "b" * 64


def test_attestation_hashes_real_artifacts_without_exposing_local_paths(tmp_path):
    report = tmp_path / "private-patient-report.pdf"
    report.write_bytes(b"verified report bytes")
    digest = hashlib.sha256(report.read_bytes()).hexdigest()
    result = {"run_id": "run-1", "report_path": str(report)}

    attestation = build_execution_attestation(
        tool_name="pyhfo_batch_run",
        call_parameters={},
        result_payload=result,
        source_recording_fingerprint="a" * 64,
    )

    assert len(attestation["artifacts"]) == 1
    artifact = attestation["artifacts"][0]
    assert artifact["sha256"] == digest
    assert artifact["uri"] == f"artifact://sha256/{digest}"
    assert artifact["run_id"] == "run-1"
    assert str(tmp_path) not in str(artifact)


def test_recording_fingerprint_cache_invalidates_when_bytes_change_with_same_size_and_mtime(
    tmp_path,
):
    recording = tmp_path / "recording.edf"
    recording.write_bytes(b"AAAA")
    original_stat = recording.stat()
    first = recording_fingerprint_for_path(recording)

    recording.write_bytes(b"BBBB")
    os.utime(
        recording,
        ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns),
    )
    second = recording_fingerprint_for_path(recording)

    assert first == hashlib.sha256(b"AAAA").hexdigest()
    assert second == hashlib.sha256(b"BBBB").hexdigest()
    assert second != first
