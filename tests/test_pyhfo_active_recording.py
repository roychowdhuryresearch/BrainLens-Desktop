"""BUG 1 regression: the agent must operate on the recording the desktop has loaded.

The desktop sends ``recording_path`` (the loaded EDF) on every chat request. The agent
runtime must use it as the DEFAULT ``input_path`` for pyhfo_* tools when the model omits it,
and must preserve explicitly-provided existing paths. If the model copies the loaded path
with punctuation normalized into a non-existent path, the runtime should recover to the
actually-loaded path. We mock the PyHFO subprocess so no real detection runs.
"""
from __future__ import annotations

import hashlib
import json
import subprocess

import pytest

from runtime.agent_runtime import pyhfo_tools, ui_command_context


LOADED = "/data/sub-synthetic01_task-ictal_ieeg.edf"
OTHER = "/data/sub-synthetic02_ses-01_task-sleep_ieeg.edf"


@pytest.fixture
def fake_pyhfo_app(monkeypatch, tmp_path):
    """Make pyhfo_tools believe a CLI app exists and capture the subprocess command."""
    (tmp_path / "src" / "pyhfo").mkdir(parents=True)
    (tmp_path / "src" / "pyhfo" / "agent_cli.py").write_text("# cli", encoding="utf-8")
    monkeypatch.setenv("PYHFO_AGENT_APP_ROOT", str(tmp_path))
    monkeypatch.setenv("PYHFO_AGENT_PYTHON", "/usr/bin/python-test")

    captured = {}

    def fake_run(command, **kwargs):
        captured["command"] = command
        return subprocess.CompletedProcess(command, 0, stdout=json.dumps({"ok": True}), stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)
    return captured


@pytest.fixture(autouse=True)
def _clear_active_recording():
    pyhfo_tools.end_active_recording()
    pyhfo_tools._clear_recording_lineage_for_tests()
    ui_command_context.end_ui_turn()
    yield
    pyhfo_tools.end_active_recording()
    pyhfo_tools._clear_recording_lineage_for_tests()
    ui_command_context.end_ui_turn()


def _input_arg(command):
    return command[command.index("--input") + 1]


def test_active_recording_fills_missing_input_path(fake_pyhfo_app):
    """A QC call with NO input_path must run against the loaded recording, not a stale one."""
    pyhfo_tools.begin_active_recording(LOADED)

    result = pyhfo_tools.execute_sync("pyhfo_compute_channel_qc", {})

    assert result["success"] is True
    assert _input_arg(fake_pyhfo_app["command"]) == LOADED


def test_explicit_input_path_is_not_overridden(fake_pyhfo_app):
    """An explicitly-provided existing-looking input_path wins over the active recording."""
    pyhfo_tools.begin_active_recording(LOADED)

    result = pyhfo_tools.execute_sync("pyhfo_compute_channel_qc", {"input_path": OTHER})

    assert result["success"] is True
    assert _input_arg(fake_pyhfo_app["command"]) == OTHER


def test_unproven_alternate_input_is_attested_as_its_own_source_not_active_recording(
    fake_pyhfo_app,
    tmp_path,
):
    raw = tmp_path / "source.edf"
    prepared = tmp_path / "prepared.fif"
    raw.write_bytes(b"raw-ieeg-recording")
    prepared.write_bytes(b"prepared-derived-recording")
    pyhfo_tools.begin_active_recording(str(raw))

    result = pyhfo_tools.execute_sync(
        "pyhfo_compute_channel_qc",
        {"input_path": str(prepared)},
    )

    assert result["success"] is True
    provenance = result["execution_provenance"]
    raw_digest = hashlib.sha256(raw.read_bytes()).hexdigest()
    prepared_digest = hashlib.sha256(prepared.read_bytes()).hexdigest()
    assert provenance["recording_fingerprint"] == prepared_digest
    assert provenance["source_recording_fingerprint"] == prepared_digest
    assert provenance["input_recording_fingerprint"] == prepared_digest
    assert "derived_input_fingerprint" not in provenance
    assert provenance["recording_metadata"]["sha256"] == prepared_digest
    assert provenance["state_revision"] == f"recording-{prepared_digest[:24]}"
    assert raw_digest not in json.dumps(provenance)


def test_successful_prepare_registers_adapter_owned_source_to_derived_lineage(
    fake_pyhfo_app,
    monkeypatch,
    tmp_path,
):
    raw = tmp_path / "source.edf"
    prepared = tmp_path / "prepared.fif"
    raw.write_bytes(b"raw-ieeg-recording")
    pyhfo_tools.begin_active_recording(str(raw))
    monkeypatch.setenv("PYHFO_AGENT_EXECUTION_PROFILE", "authorized_headless")

    def prepare_then_qc(command, **kwargs):
        del kwargs
        if "prepare" in command:
            prepared.write_bytes(b"prepared-derived-recording")
            payload = {"status": "complete", "output_path": str(prepared)}
        else:
            payload = {"status": "complete", "flat_channels": []}
        return subprocess.CompletedProcess(command, 0, stdout=json.dumps(payload), stderr="")

    monkeypatch.setattr(subprocess, "run", prepare_then_qc)
    prepared_result = pyhfo_tools.execute_sync(
        "pyhfo_prepare_recording",
        {"input_path": str(raw), "output_path": str(prepared)},
    )
    assert prepared_result["success"] is True

    qc_result = pyhfo_tools.execute_sync(
        "pyhfo_compute_channel_qc",
        {"input_path": str(prepared)},
    )
    provenance = qc_result["execution_provenance"]
    raw_digest = hashlib.sha256(raw.read_bytes()).hexdigest()
    prepared_digest = hashlib.sha256(prepared.read_bytes()).hexdigest()
    assert provenance["recording_fingerprint"] == raw_digest
    assert provenance["source_recording_fingerprint"] == raw_digest
    assert provenance["input_recording_fingerprint"] == prepared_digest
    assert provenance["derived_input_fingerprint"] == prepared_digest
    assert provenance["recording_metadata"]["sha256"] == raw_digest
    assert provenance["state_revision"] == f"recording-{raw_digest[:24]}"


def test_prepare_result_cannot_register_lineage_for_a_different_output(
    fake_pyhfo_app,
    monkeypatch,
    tmp_path,
):
    raw = tmp_path / "source.edf"
    requested = tmp_path / "requested.fif"
    substituted = tmp_path / "substituted.fif"
    raw.write_bytes(b"raw-ieeg-recording")
    requested.write_bytes(b"requested-unproven-by-result")
    substituted.write_bytes(b"substituted-output")
    pyhfo_tools.begin_active_recording(str(raw))
    monkeypatch.setenv("PYHFO_AGENT_EXECUTION_PROFILE", "authorized_headless")

    def mismatched_prepare(command, **kwargs):
        del kwargs
        payload = {"status": "complete", "output_path": str(substituted)}
        return subprocess.CompletedProcess(command, 0, stdout=json.dumps(payload), stderr="")

    monkeypatch.setattr(subprocess, "run", mismatched_prepare)
    result = pyhfo_tools.execute_sync(
        "pyhfo_prepare_recording",
        {"input_path": str(raw), "output_path": str(requested)},
    )
    assert result["success"] is True

    qc = pyhfo_tools.execute_sync(
        "pyhfo_compute_channel_qc",
        {"input_path": str(requested)},
    )
    requested_digest = hashlib.sha256(requested.read_bytes()).hexdigest()
    assert qc["execution_provenance"]["recording_fingerprint"] == requested_digest
    assert "derived_input_fingerprint" not in qc["execution_provenance"]


def test_execution_rejects_result_when_recording_bytes_change_mid_run(
    fake_pyhfo_app,
    monkeypatch,
    tmp_path,
):
    recording = tmp_path / "mutable.edf"
    recording.write_bytes(b"AAAA")
    pyhfo_tools.begin_active_recording(str(recording))

    def mutate_during_run(command, **kwargs):
        del kwargs
        recording.write_bytes(b"BBBB")
        return subprocess.CompletedProcess(
            command,
            0,
            stdout=json.dumps({"flat_channels": ["A1"]}),
            stderr="",
        )

    monkeypatch.setattr(subprocess, "run", mutate_during_run)
    result = pyhfo_tools.execute_sync(
        "pyhfo_compute_channel_qc",
        {"input_path": str(recording)},
    )

    assert result["success"] is False
    assert result["error_code"] == "recording_changed_during_execution"
    assert "execution_provenance" not in result


def test_missing_copy_of_loaded_path_recovers_to_active_recording(fake_pyhfo_app, tmp_path):
    """Models may turn smart apostrophes in the loaded local path into ASCII quotes."""
    loaded_dir = tmp_path / "Researcher’s recordings"
    loaded_dir.mkdir()
    loaded = loaded_dir / "synthetic.edf"
    loaded.write_text("edf", encoding="utf-8")
    copied_but_wrong = str(tmp_path / "Researcher's recordings" / "synthetic.edf")
    pyhfo_tools.begin_active_recording(str(loaded))

    result = pyhfo_tools.execute_sync("pyhfo_compute_channel_qc", {"input_path": copied_but_wrong})

    assert result["success"] is True
    assert _input_arg(fake_pyhfo_app["command"]) == str(loaded)


def test_blank_input_path_falls_back_to_active_recording(fake_pyhfo_app):
    """A whitespace/empty input_path is treated as absent and filled from the active recording."""
    pyhfo_tools.begin_active_recording(LOADED)

    result = pyhfo_tools.execute_sync("pyhfo_get_recording_info", {"input_path": "   "})

    assert result["success"] is True
    assert _input_arg(fake_pyhfo_app["command"]) == LOADED


def test_no_active_recording_leaves_input_path_empty(fake_pyhfo_app):
    """Without an active recording the call is unchanged (no silent wrong file)."""
    result = pyhfo_tools.execute_sync("pyhfo_get_recording_info", {})

    assert result["success"] is True
    assert _input_arg(fake_pyhfo_app["command"]) == ""


def test_directory_and_metadata_tools_are_not_anchored(fake_pyhfo_app):
    """Tools that don't take a single-recording --input must be left alone."""
    pyhfo_tools.begin_active_recording(LOADED)

    pyhfo_tools.execute_sync("pyhfo_get_capability_manifest", {})

    assert "--input" not in fake_pyhfo_app["command"]


def test_recording_info_runs_against_active_recording_when_sidecar_is_sparse(fake_pyhfo_app):
    """Metadata reads must operate on the desktop-bound recording after the desktop bound one."""
    pyhfo_tools.begin_active_recording(LOADED)

    result = pyhfo_tools.execute_sync("pyhfo_get_recording_info", {})

    assert result["success"] is True
    assert _input_arg(fake_pyhfo_app["command"]) == LOADED


def test_recording_info_binds_only_explicit_active_recording(fake_pyhfo_app):
    """Live desktop review state must come from MCP get_ui_state, not runtime context."""
    pyhfo_tools.begin_active_recording(LOADED)

    result = pyhfo_tools.execute_sync("pyhfo_get_recording_info", {})

    assert result["success"] is True
    assert _input_arg(fake_pyhfo_app["command"]) == LOADED


def test_desktop_context_stages_detection_instead_of_running_headless(fake_pyhfo_app):
    """Compute writes in the desktop co-pilot should become visible staged UI commands."""
    commands = []
    pyhfo_tools.begin_active_recording(LOADED)
    ui_command_context.begin_ui_turn(commands)

    result = pyhfo_tools.execute_sync("pyhfo_detect_events", {
        "biomarker": "HFO",
        "detector": "MNI",
        "filter": {"fp": 80, "fs": 250},
        "detector_params": {"thrd_perc": 99.9},
        "all_channels": True,
        "n_jobs": 1,
    })

    assert result["success"] is False
    assert result["mcp_tool"] == "emit_ui_command"
    assert result["mcp_arguments"]["type"] == "detection.run"
    assert result["mcp_arguments"]["payload"]["detector"] == "MNI"
    assert result["mcp_arguments"]["payload"]["filter"] == {"fp": 80, "fs": 250}
    assert result["mcp_arguments"]["payload"]["detector_params"] == {"thrd_perc": 99.9}
    assert result["mcp_arguments"]["payload"]["all_channels"] is True
    assert commands == []
    assert "command" not in fake_pyhfo_app


def test_desktop_context_requires_detector_before_staging_detection(fake_pyhfo_app):
    """A detector/protocol-missing desktop detection request must ask instead of choosing defaults."""
    pyhfo_tools.begin_active_recording(LOADED)

    result = pyhfo_tools.execute_sync("pyhfo_detect_events", {
        "biomarker": "HFO",
        "filter": {"fp": 80, "fs": 500},
        "n_jobs": 1,
    })

    assert result["success"] is False
    assert result["clarification_required"] is True
    assert "Which HFO detector/protocol and result-shaping settings" in result["question"]
    assert "filter band" in result["question"]
    assert "mcp_arguments" not in result
    assert "command" not in fake_pyhfo_app


def test_desktop_context_requires_parameters_before_staging_detection(fake_pyhfo_app):
    """A detector-only desktop detection request must not invent thresholds or defaults."""
    pyhfo_tools.begin_active_recording(LOADED)

    result = pyhfo_tools.execute_sync("pyhfo_detect_events", {
        "biomarker": "HFO",
        "detector": "STE",
        "n_jobs": 1,
    })

    assert result["success"] is False
    assert result["clarification_required"] is True
    assert "parameters, a preset, or confirmed defaults" in result["error"]
    assert "filter band" in result["question"]
    assert "mcp_arguments" not in result
    assert "command" not in fake_pyhfo_app


def test_desktop_context_requires_scope_before_staging_detection(fake_pyhfo_app):
    """A detector run must not infer all-channel scope when the user omitted scope."""
    pyhfo_tools.begin_active_recording(LOADED)

    result = pyhfo_tools.execute_sync("pyhfo_detect_events", {
        "biomarker": "HFO",
        "detector": "MNI",
        "filter": {"fp": 80, "fs": 250},
        "detector_params": {"thrd_perc": 99.9},
        "n_jobs": 1,
    })

    assert result["success"] is False
    assert result["clarification_required"] is True
    assert "channel scope" in result["error"]
    assert "mcp_arguments" not in result
    assert "command" not in fake_pyhfo_app


def test_desktop_context_allows_explicitly_confirmed_defaults(fake_pyhfo_app):
    """The user or protocol may explicitly authorize defaults instead of listing every value."""
    pyhfo_tools.begin_active_recording(LOADED)

    result = pyhfo_tools.execute_sync("pyhfo_detect_events", {
        "biomarker": "HFO",
        "detector": "STE",
        "confirmed_defaults": True,
        "n_jobs": 1,
    })

    assert result["success"] is False
    assert result["mcp_tool"] == "emit_ui_command"
    assert result["mcp_arguments"]["type"] == "detection.run"
    assert result["mcp_arguments"]["payload"]["detector"] == "STE"
    assert "command" not in fake_pyhfo_app


def test_desktop_context_requires_clarification_for_invalid_ste_spindle_payload(fake_pyhfo_app):
    """A broad HFO+spindle request must not dispatch or silently repair Spindle+STE."""
    pyhfo_tools.begin_active_recording(LOADED)

    result = pyhfo_tools.execute_sync("pyhfo_detect_events", {
        "biomarker": "spindles",
        "detector": "STE",
        "filter": {"fp": 11, "fs": 16},
        "exports": ["csv", "session", "summary_json"],
        "n_jobs": 1,
    })

    assert result["success"] is False
    assert result["clarification_required"] is True
    assert "not a supported Spindle detector" in result["error"]
    assert "Which spindle detector/protocol and result-shaping settings" in result["question"]
    assert "mcp_arguments" not in result
    assert "command" not in fake_pyhfo_app


def test_async_execute_uses_active_recording_via_contextvar(fake_pyhfo_app):
    """ContextVar must survive the asyncio.to_thread hop used by the async execute()."""
    import asyncio

    async def _run():
        pyhfo_tools.begin_active_recording(LOADED)
        return await pyhfo_tools.execute("pyhfo_infer_brain_signal_roi", {})

    result = asyncio.run(_run())

    assert result["success"] is True
    assert _input_arg(fake_pyhfo_app["command"]) == LOADED


def test_orchestrator_seam_binds_request_recording_path(fake_pyhfo_app):
    """End-to-end seam: the inbound request field -> begin_active_recording -> tool input_path.

    This mirrors what orchestrator.stream does (pyhfo_tools.begin_active_recording(request.recording_path))
    and what internal_agent._resolve_recording_path produces, without spinning up the full LLM turn.
    """
    from runtime.api.internal_agent import (
        InternalAgentChatRequest,
        InternalUserContext,
        _resolve_recording_path,
    )

    req = InternalAgentChatRequest(
        request_id="r1",
        message="do QC",
        skill_environment="prod",
        user_context=InternalUserContext(user_id="u1", username="doc", role="user"),
        recording_path=LOADED,
    )
    resolved = _resolve_recording_path(req)
    assert resolved == LOADED

    # The orchestrator binds exactly this value at turn start.
    pyhfo_tools.begin_active_recording(resolved)
    pyhfo_tools.execute_sync("pyhfo_compute_channel_qc", {})
    assert _input_arg(fake_pyhfo_app["command"]) == LOADED


def test_resolve_recording_path_ignores_legacy_ui_state():
    """UI state is read through MCP; recording_path must be explicit."""
    from runtime.api.internal_agent import (
        InternalAgentChatRequest,
        InternalUserContext,
        _resolve_recording_path,
    )

    req = InternalAgentChatRequest(
        request_id="r1",
        message="do QC",
        skill_environment="prod",
        user_context=InternalUserContext(user_id="u1", username="doc", role="user"),
        ui_state={"recording_path": OTHER},
    )
    assert _resolve_recording_path(req) is None


def test_resolve_recording_path_prefers_explicit_over_ui_state():
    from runtime.api.internal_agent import (
        InternalAgentChatRequest,
        InternalUserContext,
        _resolve_recording_path,
    )

    req = InternalAgentChatRequest(
        request_id="r1",
        message="do QC",
        skill_environment="prod",
        user_context=InternalUserContext(user_id="u1", username="doc", role="user"),
        recording_path=LOADED,
        ui_state={"recording_path": OTHER},
    )
    assert _resolve_recording_path(req) == LOADED


def test_missing_bundled_engine_does_not_select_a_sibling_checkout(tmp_path, monkeypatch):
    repo = tmp_path / "project"
    monkeypatch.setattr(pyhfo_tools, "_repo_root", lambda: repo)
    monkeypatch.delenv("PYHFO_AGENT_APP_ROOT", raising=False)
    monkeypatch.delenv("PYHFO_ROOT", raising=False)
    assert pyhfo_tools.get_pyhfo_app_root() == repo / "pyhfo"
