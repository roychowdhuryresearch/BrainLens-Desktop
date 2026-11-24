from __future__ import annotations

import asyncio
import hashlib
import json
import subprocess
import threading
from types import SimpleNamespace

import pytest

from runtime.agent_runtime import pyhfo_tools
from runtime.agent_runtime import ui_command_context
from runtime.agent_runtime.infra_adapter import RuntimeInfraAdapter
from ui_mcp.broker import UiBus, build_server


WRITE_CASES = (
    (
        "pyhfo_detect_events",
        {
            "input_path": "case.edf",
            "output_dir": "runs/case",
            "biomarker": "HFO",
            "detector": "STE",
            "confirmed_defaults": True,
            "all_channels": True,
        },
        "detection.run",
    ),
    (
        "pyhfo_prepare_recording",
        {
            "input_path": "case.edf",
            "output_path": "prepared/case.fif",
            "line_noise_notch_hz": 60,
        },
        "analysis.prepare_recording",
    ),
    (
        "pyhfo_run_severity_scoring",
        {"input_path": "case.edf"},
        "severity.run",
    ),
    (
        "pyhfo_batch_create",
        {"input_dir": "cohort", "output_dir": "runs", "recursive": True},
        "batch.create",
    ),
    (
        "pyhfo_batch_run",
        {
            "manifest_path": "runs/batch_project.json",
            "detection": {"biomarker": "HFO", "detector": "STE", "n_jobs": 1},
        },
        "batch.run",
    ),
)


@pytest.fixture(autouse=True)
def _closed_execution_profile(monkeypatch):
    monkeypatch.delenv("PYHFO_AGENT_EXECUTION_PROFILE", raising=False)
    monkeypatch.delenv("PYHFO_AGENT_FORCE_HEADLESS_DETECTION", raising=False)
    monkeypatch.delenv("PYHFO_SESSION_URL", raising=False)
    monkeypatch.delenv("PYHFO_SESSION_TOKEN", raising=False)
    monkeypatch.delenv("IEEG_UI_BROKER_URL", raising=False)
    monkeypatch.delenv("IEEG_UI_BROKER_TOKEN", raising=False)
    pyhfo_tools.end_active_recording()
    pyhfo_tools.begin_desktop_session(None, None)
    yield
    pyhfo_tools.end_active_recording()
    pyhfo_tools.begin_desktop_session(None, None)


@pytest.fixture
def fake_pyhfo_runtime(monkeypatch, tmp_path):
    (tmp_path / "src" / "pyhfo").mkdir(parents=True)
    (tmp_path / "src" / "pyhfo" / "agent_cli.py").write_text("# cli", encoding="utf-8")
    monkeypatch.setenv("PYHFO_AGENT_APP_ROOT", str(tmp_path))
    calls = []

    def fake_run(command, **kwargs):
        calls.append(command)
        return subprocess.CompletedProcess(command, 0, stdout=json.dumps({"status": "complete"}), stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)
    return calls


@pytest.mark.parametrize(("tool_name", "parameters", "command_type"), WRITE_CASES)
def test_write_capable_builtins_fail_closed_and_return_ui_route(
    fake_pyhfo_runtime,
    tool_name,
    parameters,
    command_type,
):
    result = pyhfo_tools.execute_sync(tool_name, parameters)

    assert result["success"] is False
    assert result["status"] == "authorization_required"
    assert result["error_code"] == "direct_execution_not_authorized"
    assert result["authority"]["direct_execution"] is False
    assert result["authority"]["required_profile"] == "authorized_headless"
    assert result["route"]["mcp_server"] == "ieeg_ui"
    assert any(
        step.get("arguments", {}).get("type") == command_type
        for step in result["route"]["steps"]
        if step.get("tool") == "emit_ui_command"
    )
    assert result["route"]["terminal_receipt_required"] is True
    assert fake_pyhfo_runtime == []


def test_legacy_force_detection_environment_variable_is_not_authority(fake_pyhfo_runtime, monkeypatch):
    monkeypatch.setenv("PYHFO_AGENT_FORCE_HEADLESS_DETECTION", "1")

    result = pyhfo_tools.execute_sync(
        "pyhfo_detect_events",
        {
            "input_path": "case.edf",
            "output_dir": "runs/case",
            "biomarker": "HFO",
            "detector": "STE",
            "confirmed_defaults": True,
            "all_channels": True,
        },
    )

    assert result["error_code"] == "direct_execution_not_authorized"
    assert fake_pyhfo_runtime == []


def test_tool_arguments_cannot_elevate_the_process_profile(fake_pyhfo_runtime):
    result = pyhfo_tools.execute_sync(
        "pyhfo_batch_create",
        {
            "input_dir": "cohort",
            "output_dir": "runs",
            "execution_profile": "authorized_headless",
        },
    )

    assert result["error_code"] == "direct_execution_not_authorized"
    assert fake_pyhfo_runtime == []


def test_attached_desktop_handoff_precedes_denial_and_cli_default_materialization(monkeypatch):
    handed_off = []

    def fail_if_called(*_args, **_kwargs):
        raise AssertionError("headless authority/default logic ran before desktop handoff")

    def capture_handoff(tool_name, command, parameters):
        handed_off.append((tool_name, command, parameters))
        return {"success": True, "status": "staged", "command_type": command}

    pyhfo_tools.begin_active_recording("/data/loaded-case.edf")
    pyhfo_tools.begin_desktop_session("http://127.0.0.1:8765", "session-token")
    monkeypatch.setattr(pyhfo_tools, "get_direct_execution_denial", fail_if_called)
    monkeypatch.setattr(pyhfo_tools, "_materialize_effective_parameters", fail_if_called)
    monkeypatch.setattr(pyhfo_tools, "_hand_to_desktop", capture_handoff)

    result = pyhfo_tools.execute_sync("pyhfo_run_severity_scoring", {})

    assert result["success"] is True
    assert result["result"]["status"] == "staged"
    assert handed_off == [
        (
            "pyhfo_run_severity_scoring",
            "severity.run",
            {"input_path": "/data/loaded-case.edf"},
        )
    ]


def test_attached_desktop_handoff_rejects_a_different_input_recording(monkeypatch):
    pyhfo_tools.begin_active_recording("/data/loaded-case.edf")
    pyhfo_tools.begin_desktop_session("http://127.0.0.1:8765", "session-token")
    monkeypatch.setattr(
        pyhfo_tools,
        "_hand_to_desktop",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("scope-conflicting command was emitted")),
    )

    result = pyhfo_tools.execute_sync(
        "pyhfo_run_severity_scoring",
        {"input_path": "/data/different-case.edf"},
    )

    assert result["success"] is False
    assert result["error_code"] == "desktop_recording_scope_conflict"
    assert result["staged"] is False


def test_attached_desktop_prepare_handoff_maps_only_executable_parameters(monkeypatch, tmp_path):
    recording = tmp_path / "loaded-case.edf"
    recording.write_bytes(b"recording-bytes")
    output = tmp_path / "prepared" / "loaded-case.fif"
    handed_off = []
    pyhfo_tools.begin_active_recording(str(recording))
    pyhfo_tools.begin_desktop_session("http://127.0.0.1:8765", "session-token")

    def capture_handoff(tool_name, command, parameters):
        handed_off.append((tool_name, command, parameters))
        return {"success": True, "status": "staged", "command_type": command}

    monkeypatch.setattr(pyhfo_tools, "_hand_to_desktop", capture_handoff)
    result = pyhfo_tools.execute_sync(
        "pyhfo_prepare_recording",
        {
            "input_path": str(recording),
            "output_path": str(output),
            "bandpass": {"l_freq": 1, "h_freq": 80},
            "line_noise_notch_hz": 60,
            "n_jobs": 2,
        },
    )

    assert result["success"] is True
    assert handed_off == [
        (
            "pyhfo_prepare_recording",
            "analysis.prepare_recording",
            {
                "input_path": str(recording),
                "recording_fingerprint": hashlib.sha256(b"recording-bytes").hexdigest(),
                "filter": {"fp": 1, "fs": 80},
                "line_noise_notch_hz": 60,
                "n_jobs": 2,
                "output_path": str(output),
            },
        )
    ]


def test_attached_desktop_prepare_handoff_rejects_headless_only_parameters(monkeypatch, tmp_path):
    recording = tmp_path / "loaded-case.edf"
    recording.write_bytes(b"recording-bytes")
    pyhfo_tools.begin_active_recording(str(recording))
    pyhfo_tools.begin_desktop_session("http://127.0.0.1:8765", "session-token")
    monkeypatch.setattr(
        pyhfo_tools,
        "_hand_to_desktop",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("unmappable command was emitted")),
    )

    result = pyhfo_tools.execute_sync(
        "pyhfo_prepare_recording",
        {
            "input_path": str(recording),
            "output_path": str(tmp_path / "prepared.fif"),
            "bipolar_montage": "pairs",
            "bipolar_pairs": [{"anode": "A1", "cathode": "A2"}],
        },
    )

    assert result["success"] is False
    assert result["error_code"] == "desktop_parameter_mapping_unavailable"
    assert result["unmapped_parameters"] == ["bipolar_montage", "bipolar_pairs"]


def test_attached_desktop_handoff_is_broker_issued_and_mirrored(monkeypatch):
    bus = UiBus()
    fingerprint = "a" * 64
    bus.set_state({
        "session_id": "session-1",
        "state_revision": "rev-1",
        "resource_scope": {
            "state_revision": "rev-1",
            "recording_sha256": fingerprint,
        },
    })
    server = build_server("127.0.0.1", 0, bus=bus, token="desktop-broker-secret")
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    broker_url = f"http://127.0.0.1:{server.server_address[1]}"
    monkeypatch.setenv("IEEG_UI_BROKER_URL", broker_url)
    monkeypatch.setenv("IEEG_UI_BROKER_TOKEN", "desktop-broker-secret")
    commands = []
    ui_command_context.begin_ui_turn(
        commands,
        authority_scope={
            "request_id": "req-1",
            "message_id": "msg-1",
            "conversation_id": "conv-1",
            "state_revision": "rev-1",
            "recording_fingerprint": fingerprint,
        },
    )
    try:
        result = pyhfo_tools._hand_to_desktop(
            "pyhfo_run_severity_scoring",
            "severity.run",
            {"input_path": "/data/loaded-case.edf", "recording_fingerprint": fingerprint},
        )
    finally:
        ui_command_context.end_ui_turn()
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)

    assert result["success"] is True
    assert result["status"] == "staged"
    assert result["staged"] is True
    assert result["command_id"].startswith("mcp-")
    assert commands == [bus.pending[0]]
    assert commands[0]["payload"] == {
        "input_path": "/data/loaded-case.edf",
        "recording_fingerprint": fingerprint,
    }
    assert commands[0]["request_id"] == "req-1"
    assert commands[0]["message_id"] == "msg-1"
    assert commands[0]["conversation_id"] == "conv-1"
    assert commands[0]["state_revision"] == "rev-1"
    assert commands[0]["resource_scope"] == {
        "state_revision": "rev-1",
        "recording_sha256": fingerprint,
    }
    receipt = bus.get_ack(result["command_id"])
    assert receipt["status"] == "queued"
    assert receipt["requires_confirmation"] is True
    assert receipt["recording_fingerprint"] == fingerprint
    assert receipt["idempotency"]["key_supplied"] is True


def test_attached_desktop_handoff_fails_closed_without_turn_scope(monkeypatch):
    monkeypatch.setenv("IEEG_UI_BROKER_URL", "http://127.0.0.1:8770")
    monkeypatch.setenv("IEEG_UI_BROKER_TOKEN", "desktop-broker-secret")

    result = pyhfo_tools._hand_to_desktop(
        "pyhfo_run_severity_scoring",
        "severity.run",
        {"input_path": "/data/loaded-case.edf"},
    )

    assert result["success"] is False
    assert result["error_code"] == "ui_command_scope_unavailable"
    assert result["staged"] is False


def test_attached_desktop_handoff_fails_closed_without_broker_token(monkeypatch):
    monkeypatch.setenv("IEEG_UI_BROKER_URL", "http://127.0.0.1:8770")
    monkeypatch.delenv("IEEG_UI_BROKER_TOKEN", raising=False)
    recorded = []
    ui_command_context.begin_ui_turn(recorded)
    try:
        result = pyhfo_tools._hand_to_desktop(
            "pyhfo_run_severity_scoring",
            "severity.run",
            {},
        )
    finally:
        ui_command_context.end_ui_turn()

    assert result["success"] is False
    assert result["error_code"] == "ui_broker_unavailable"
    assert result["staged"] is False
    assert recorded == []


def test_attached_desktop_handoff_rejects_a_noncanonical_broker_response(monkeypatch):
    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        @staticmethod
        def read():
            return b"[]"

    monkeypatch.setenv("IEEG_UI_BROKER_URL", "http://127.0.0.1:8770")
    monkeypatch.setenv("IEEG_UI_BROKER_TOKEN", "desktop-broker-secret")
    monkeypatch.setattr(pyhfo_tools.urllib.request, "urlopen", lambda *_args, **_kwargs: FakeResponse())
    ui_command_context.begin_ui_turn(
        [],
        authority_scope={
            "request_id": "req-1",
            "message_id": "msg-1",
            "conversation_id": "conv-1",
            "state_revision": "rev-1",
            "recording_fingerprint": "a" * 64,
        },
    )
    try:
        result = pyhfo_tools._hand_to_desktop(
            "pyhfo_run_severity_scoring",
            "severity.run",
            {},
        )
    finally:
        ui_command_context.end_ui_turn()

    assert result["success"] is False
    assert result["error_code"] == "ui_broker_rejected"
    assert result["staged"] is False


@pytest.mark.parametrize(("tool_name", "parameters", "_command_type"), WRITE_CASES)
def test_explicit_authorized_headless_profile_allows_direct_execution(
    fake_pyhfo_runtime,
    monkeypatch,
    tool_name,
    parameters,
    _command_type,
):
    monkeypatch.setenv("PYHFO_AGENT_EXECUTION_PROFILE", "authorized_headless")

    result = pyhfo_tools.execute_sync(tool_name, parameters)

    assert result["success"] is True
    assert result["tool"] == tool_name
    assert len(fake_pyhfo_runtime) == 1


@pytest.mark.parametrize("tool_name", ["pyhfo_get_recording_info", "pyhfo_compute_channel_qc"])
def test_read_only_metadata_and_qc_remain_available_by_default(fake_pyhfo_runtime, tool_name):
    result = pyhfo_tools.execute_sync(tool_name, {"input_path": "case.edf"})

    assert result["success"] is True
    assert len(fake_pyhfo_runtime) == 1


def test_successful_tool_result_binds_provenance_to_actual_recording_bytes(
    fake_pyhfo_runtime,
    tmp_path,
):
    recording = tmp_path / "case.edf"
    recording_bytes = b"synthetic-ieeg-recording"
    recording.write_bytes(recording_bytes)

    result = pyhfo_tools.execute_sync(
        "pyhfo_compute_channel_qc",
        {"input_path": str(recording)},
    )

    fingerprint = hashlib.sha256(recording_bytes).hexdigest()
    provenance = result["execution_provenance"]
    assert provenance["tool_name"] == "pyhfo_compute_channel_qc"
    assert provenance["recording_fingerprint"] == fingerprint
    assert provenance["state_revision"] == f"recording-{fingerprint[:24]}"
    assert provenance["run_ids"] == [f"run_{provenance['result_sha256'][:24]}"]
    assert str(recording) not in json.dumps(provenance)


def test_timeout_environment_override_remains_bounded(monkeypatch):
    monkeypatch.setenv("PYHFO_AGENT_TIMEOUT_SECONDS", "17")
    assert pyhfo_tools._timeout_seconds() == 17

    monkeypatch.setenv("PYHFO_AGENT_TIMEOUT_SECONDS", "0")
    assert pyhfo_tools._timeout_seconds() == 1

    monkeypatch.setenv("PYHFO_AGENT_TIMEOUT_SECONDS", "not-an-integer")
    assert pyhfo_tools._timeout_seconds() == pyhfo_tools.DEFAULT_TIMEOUT_SECONDS


@pytest.mark.parametrize(
    ("tool_name", "defaults"),
    [
        (
            "pyhfo_compute_channel_qc",
            {
                "exclude_channels": [],
                "outlier_z_threshold": 8.0,
                "max_duration_seconds": 60.0,
            },
        ),
        (
            "pyhfo_compute_spectral_profile",
            {
                "exclude_channels": [],
                "max_channels": 32,
                "max_duration_seconds": 60.0,
            },
        ),
        (
            "pyhfo_detect_line_noise",
            {
                "exclude_channels": [],
                "site_line_freq_hz": None,
                "candidate_frequencies_hz": [50.0, 60.0],
                "max_channels": 32,
                "max_harmonics": 4,
                "bandwidth_hz": 1.0,
                "shoulder_width_hz": 5.0,
                "ratio_threshold": 5.0,
                "max_duration_seconds": 60.0,
            },
        ),
    ],
)
def test_cli_defaults_are_materialized_before_command_and_attestation(
    fake_pyhfo_runtime,
    tmp_path,
    tool_name,
    defaults,
):
    recording = tmp_path / "case.edf"
    recording.write_bytes(b"stable-recording")

    omitted = pyhfo_tools.execute_sync(tool_name, {"input_path": str(recording)})
    omitted_command = list(fake_pyhfo_runtime[-1])
    explicit = pyhfo_tools.execute_sync(
        tool_name,
        {"input_path": str(recording), **defaults},
    )
    explicit_command = list(fake_pyhfo_runtime[-1])

    omitted_provenance = omitted["execution_provenance"]
    explicit_provenance = explicit["execution_provenance"]
    assert omitted_command == explicit_command
    assert omitted_provenance["effective_parameters"] == defaults
    assert omitted_provenance["effective_parameters"] == explicit_provenance["effective_parameters"]
    assert omitted_provenance["parameters_sha256"] == explicit_provenance["parameters_sha256"]
    assert omitted_provenance["parameters_sha256"] == pyhfo_tools.canonical_json_sha256(defaults)


def test_write_tool_defaults_materialize_to_complete_effective_maps():
    assert pyhfo_tools._materialize_effective_parameters(
        "pyhfo_detect_events",
        {"input_path": "case.edf", "output_dir": "runs"},
    ) == {
        "input_path": "case.edf",
        "output_dir": "runs",
        "biomarker": "HFO",
        "detector": None,
        "n_jobs": 1,
        "filter": {},
        "detector_params": {},
        "classifier": {},
        "exports": ["summary-json"],
        "include_channels": [],
        "exclude_channels": [],
    }
    assert pyhfo_tools._materialize_effective_parameters(
        "pyhfo_prepare_recording",
        {"input_path": "case.edf", "output_path": "prepared.fif"},
    ) == {
        "input_path": "case.edf",
        "output_path": "prepared.fif",
        "line_noise_notch_hz": None,
        "bandpass": {},
        "resample_sfreq": None,
        "bipolar_montage": "none",
        "bipolar_pairs": [],
        "drop_original_after_bipolar": False,
        "extra_bad_channels": [],
        "drop_bad_channels": True,
        "drop_flat_channels": True,
        "mark_outlier_channels": True,
        "drop_outlier_channels": False,
        "outlier_z_threshold": 8.0,
        "notch_freqs": [],
    }


def test_rank_csv_lineage_and_defaults_are_content_bound(fake_pyhfo_runtime, tmp_path):
    events_csv = tmp_path / "events.csv"
    events_csv.write_bytes(b"channel,start,end\nA1,1.0,1.1\n")
    expected_digest = hashlib.sha256(events_csv.read_bytes()).hexdigest()
    base = {
        "runs": [{"biomarker": "HFO", "events_csv": str(events_csv)}],
    }

    omitted = pyhfo_tools.execute_sync("pyhfo_rank_candidate_channels", base)
    omitted_command = list(fake_pyhfo_runtime[-1])
    explicit = pyhfo_tools.execute_sync(
        "pyhfo_rank_candidate_channels",
        {**base, "duration_seconds": 0.0, "exclude_channels": [], "top_n": 20},
    )
    explicit_command = list(fake_pyhfo_runtime[-1])

    provenance = omitted["execution_provenance"]
    assert omitted_command == explicit_command
    assert provenance["effective_parameters"] == {
        "duration_seconds": 0.0,
        "exclude_channels": [],
        "top_n": 20,
        "runs": [{"biomarker": "HFO"}],
    }
    assert provenance["parameters_sha256"] == explicit["execution_provenance"]["parameters_sha256"]
    assert provenance["input_lineage"] == [
        {
            "artifact_id": f"input-{expected_digest[:24]}",
            "kind": "detector_events_csv",
            "source_index": 0,
            "sha256": expected_digest,
            "uri": f"artifact://sha256/{expected_digest}",
        }
    ]
    assert provenance["input_lineage_sha256"] == pyhfo_tools.canonical_json_sha256(
        provenance["input_lineage"]
    )
    assert str(events_csv) not in json.dumps(provenance)


def test_batch_manifest_lineage_and_nested_defaults_are_content_bound(
    fake_pyhfo_runtime,
    monkeypatch,
    tmp_path,
):
    monkeypatch.setenv("PYHFO_AGENT_EXECUTION_PROFILE", "authorized_headless")
    manifest = tmp_path / "batch_project.json"
    manifest.write_bytes(b'{"cases":["case-1"]}')
    expected_digest = hashlib.sha256(manifest.read_bytes()).hexdigest()
    detection_defaults = {
        "biomarker": "HFO",
        "detector": None,
        "n_jobs": 1,
        "filter": {},
        "detector_params": {},
        "classifier": {},
        "exports": ["summary-json"],
        "include_channels": [],
        "exclude_channels": [],
    }

    omitted = pyhfo_tools.execute_sync(
        "pyhfo_batch_run",
        {"manifest_path": str(manifest)},
    )
    omitted_command = list(fake_pyhfo_runtime[-1])
    explicit = pyhfo_tools.execute_sync(
        "pyhfo_batch_run",
        {
            "manifest_path": str(manifest),
            "recursive": True,
            "retry_failed": False,
            "fail_fast": False,
            "detection": detection_defaults,
        },
    )
    explicit_command = list(fake_pyhfo_runtime[-1])

    provenance = omitted["execution_provenance"]
    assert omitted_command == explicit_command
    assert provenance["effective_parameters"] == {
        "recursive": True,
        "retry_failed": False,
        "fail_fast": False,
        "detection": detection_defaults,
    }
    assert provenance["parameters_sha256"] == explicit["execution_provenance"]["parameters_sha256"]
    assert provenance["input_lineage"][0]["kind"] == "batch_manifest"
    assert provenance["input_lineage"][0]["sha256"] == expected_digest
    assert provenance["input_lineage_sha256"] == pyhfo_tools.canonical_json_sha256(
        provenance["input_lineage"]
    )
    assert str(manifest) not in json.dumps(provenance)


def test_rank_result_is_rejected_if_csv_bytes_change_during_execution(
    fake_pyhfo_runtime,
    monkeypatch,
    tmp_path,
):
    events_csv = tmp_path / "events.csv"
    events_csv.write_bytes(b"before")

    def mutate_input(command, **kwargs):
        del kwargs
        events_csv.write_bytes(b"after!")
        return subprocess.CompletedProcess(
            command,
            0,
            stdout=json.dumps({"status": "complete"}),
            stderr="",
        )

    monkeypatch.setattr(subprocess, "run", mutate_input)
    result = pyhfo_tools.execute_sync(
        "pyhfo_rank_candidate_channels",
        {"runs": [{"biomarker": "HFO", "events_csv": str(events_csv)}]},
    )

    assert result["success"] is False
    assert result["error_code"] == "input_artifact_changed_during_execution"
    assert "execution_provenance" not in result


def test_batch_run_without_manifest_routes_through_create_then_terminal_receipt(fake_pyhfo_runtime):
    result = pyhfo_tools.execute_sync(
        "pyhfo_batch_run",
        {
            "input_dir": "cohort",
            "output_dir": "runs",
            "detection": {"biomarker": "HFO", "detector": "STE"},
        },
    )

    command_types = [
        step.get("arguments", {}).get("type")
        for step in result["route"]["steps"]
        if step.get("tool") == "emit_ui_command"
    ]
    assert command_types == ["batch.create", "batch.run"]
    assert result["route"]["steps"][1]["tool"] == "wait_for_ui_command"
    assert result["route"]["steps"][2]["arguments"]["payload"]["manifest_path"] == "<manifest_path_from_terminal_receipt>"
    assert fake_pyhfo_runtime == []


def test_unmappable_prepare_parameters_stop_before_prepare_command(fake_pyhfo_runtime):
    result = pyhfo_tools.execute_sync(
        "pyhfo_prepare_recording",
        {
            "input_path": "case.edf",
            "output_path": "prepared/case.fif",
            "bipolar_montage": "pairs",
            "bipolar_pairs": [{"anode": "A1", "cathode": "A2"}],
        },
    )

    assert result["route"]["ready_to_stage"] is False
    assert result["route"]["unmapped_parameters"] == ["bipolar_montage", "bipolar_pairs"]
    assert not any(
        step.get("arguments", {}).get("type") == "analysis.prepare_recording"
        for step in result["route"]["steps"]
    )
    assert fake_pyhfo_runtime == []


def test_unmappable_batch_detector_parameters_stop_before_batch_run(fake_pyhfo_runtime):
    result = pyhfo_tools.execute_sync(
        "pyhfo_batch_run",
        {
            "manifest_path": "runs/batch_project.json",
            "detection": {
                "biomarker": "HFO",
                "detector": "STE",
                "detector_params": {"min_osc": 6},
            },
        },
    )

    assert result["route"]["ready_to_stage"] is False
    assert result["route"]["unmapped_parameters"] == ["detector_params"]
    assert not any(
        step.get("arguments", {}).get("type") == "batch.run"
        for step in result["route"]["steps"]
    )
    assert fake_pyhfo_runtime == []


class _UiMCPManager:
    def get_all_tools(self):
        return [
            {
                "name": "emit_ui_command",
                "original_name": "emit_ui_command",
                "mcp_server": "ieeg_ui",
                "tool_prefix": "",
            }
        ]

    def get_tool_by_name(self, name):
        if name == "emit_ui_command":
            return self.get_all_tools()[0]
        return None


class _Service:
    def __init__(self, *, ui_available: bool):
        self.mcp_manager = _UiMCPManager() if ui_available else None
        self.config = SimpleNamespace(guarded_tool_policies=[])


def test_infra_adapter_enforces_authority_before_dispatch(monkeypatch):
    dispatched = []

    async def fake_execute(*args, **kwargs):
        dispatched.append((args, kwargs))
        return {"success": True}

    monkeypatch.setattr(pyhfo_tools, "execute", fake_execute)
    adapter = RuntimeInfraAdapter(_Service(ui_available=True))

    result = asyncio.run(
        adapter.execute_mcp_tool(
            "pyhfo_prepare_recording",
            {"input_path": "case.edf", "output_path": "prepared/case.fif"},
        )
    )

    assert result["error_code"] == "direct_execution_not_authorized"
    assert result["route"]["available"] is True
    assert dispatched == []


def test_infra_adapter_dispatches_attached_desktop_before_headless_preflight(monkeypatch):
    dispatched = []

    async def fake_execute(*args, **kwargs):
        dispatched.append((args, kwargs))
        return {"success": True, "result": {"status": "requested"}}

    def fail_if_called(*_args, **_kwargs):
        raise AssertionError("headless authority preflight ran for an attached desktop")

    pyhfo_tools.begin_active_recording("/data/loaded-case.edf")
    pyhfo_tools.begin_desktop_session("http://127.0.0.1:8765", "session-token")
    monkeypatch.setattr(pyhfo_tools, "get_direct_execution_denial", fail_if_called)
    monkeypatch.setattr(pyhfo_tools, "execute", fake_execute)
    adapter = RuntimeInfraAdapter(_Service(ui_available=True))

    result = asyncio.run(
        adapter.execute_mcp_tool(
            "pyhfo_run_severity_scoring",
            {"input_path": "/data/loaded-case.edf"},
            conversation_id="conv-1",
        )
    )

    assert result == {"success": True, "result": {"status": "requested"}}
    assert dispatched == [
        (
            ("pyhfo_run_severity_scoring", {"input_path": "/data/loaded-case.edf"}),
            {"conversation_id": "conv-1"},
        )
    ]


def test_infra_adapter_marks_ui_route_unavailable_without_mcp(monkeypatch):
    monkeypatch.setattr(pyhfo_tools, "is_available", lambda: True)
    adapter = RuntimeInfraAdapter(_Service(ui_available=False))

    result = asyncio.run(
        adapter.execute_mcp_tool(
            "pyhfo_batch_create",
            {"input_dir": "cohort", "output_dir": "runs"},
        )
    )

    assert result["error_code"] == "direct_execution_not_authorized"
    assert result["route"]["available"] is False


def test_authorized_headless_failure_does_not_leak_raw_exception(fake_pyhfo_runtime, monkeypatch):
    monkeypatch.setenv("PYHFO_AGENT_EXECUTION_PROFILE", "authorized_headless")
    secret = "patient-example/private/path"

    def explode(*_args, **_kwargs):
        raise RuntimeError(secret)

    monkeypatch.setattr(subprocess, "run", explode)

    result = pyhfo_tools.execute_sync(
        "pyhfo_prepare_recording",
        {"input_path": "case.edf", "output_path": "prepared/case.fif"},
    )

    assert result["success"] is False
    assert result["error_code"] == "pyhfo_execution_failed"
    assert secret not in json.dumps(result)


def test_authorized_headless_nonzero_exit_does_not_leak_stderr(fake_pyhfo_runtime, monkeypatch):
    monkeypatch.setenv("PYHFO_AGENT_EXECUTION_PROFILE", "authorized_headless")
    secret = "patient-example/private/path"

    def fail(command, **_kwargs):
        return subprocess.CompletedProcess(command, 2, stdout="", stderr=secret)

    monkeypatch.setattr(subprocess, "run", fail)

    result = pyhfo_tools.execute_sync(
        "pyhfo_batch_create",
        {"input_dir": "cohort", "output_dir": "runs"},
    )

    assert result["success"] is False
    assert result["error_code"] == "pyhfo_command_failed"
    assert secret not in json.dumps(result)
