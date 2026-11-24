from __future__ import annotations

import os

import json
import subprocess

import pytest

from runtime.agent_runtime import pyhfo_tools


def test_pyhfo_tool_definitions_include_research_tools(monkeypatch):
    listed = pyhfo_tools.get_tool_definitions()
    names = {tool["function"]["name"] for tool in listed}

    assert "pyhfo_get_recording_info" in names
    assert "pyhfo_detect_events" in names
    assert "pyhfo_infer_brain_signal_roi" in names
    assert "pyhfo_compute_channel_qc" in names
    assert "pyhfo_compute_spectral_profile" in names
    assert "pyhfo_detect_line_noise" in names
    assert "pyhfo_recommend_detector_plan" in names
    assert "pyhfo_rank_candidate_channels" in names
    assert "pyhfo_prepare_recording" in names
    assert "pyhfo_get_capability_manifest" in names
    assert "pyhfo_get_app_state" not in names
    assert "pyhfo_dispatch_action" not in names
    detect = next(tool for tool in listed if tool["function"]["name"] == "pyhfo_detect_events")
    assert detect["function"]["parameters"]["required"] == ["input_path", "output_dir"]
    prepare = next(tool for tool in listed if tool["function"]["name"] == "pyhfo_prepare_recording")
    assert prepare["function"]["parameters"]["required"] == ["input_path", "output_path"]
    prepare_props = prepare["function"]["parameters"]["properties"]
    assert "extra_bad_channels" in prepare_props
    assert "bipolar_montage" in prepare_props
    assert prepare_props["bipolar_montage"]["enum"] == ["none", "auto_adjacent", "pairs"]
    assert "line_noise_notch_hz" in prepare_props
    line_noise = next(tool for tool in listed if tool["function"]["name"] == "pyhfo_detect_line_noise")
    assert line_noise["function"]["parameters"]["required"] == ["input_path"]
    assert line_noise["function"]["parameters"]["properties"]["candidate_frequencies_hz"]["default"] == [50.0, 60.0]


def test_pyhfo_detect_builds_agent_cli_command(monkeypatch, tmp_path):
    monkeypatch.setenv("PYHFO_AGENT_APP_ROOT", str(tmp_path))
    monkeypatch.setenv("PYHFO_AGENT_PYTHON", "/usr/bin/python-test")

    command = pyhfo_tools._build_command(
        "pyhfo_detect_events",
        {
            "input_path": "case.edf",
            "output_dir": "out/case",
            "biomarker": "HFO",
            "detector": "STE",
            "n_jobs": 2,
            "filter": {"fp": 80, "fs": 500},
            "detector_params": {"min_osc": 6},
            "exports": ["summary-json", "excel"],
        },
    )

    assert command[:4] == ["/usr/bin/python-test", "-m", "pyhfo.agent_cli", "detect"]
    assert command[command.index("--input") + 1] == "case.edf"
    assert command[command.index("--output") + 1] == "out/case"
    assert "--filter" in command
    assert "fp=80" in command
    assert "min_osc=6" in command
    assert command.count("--export") == 2


def test_pyhfo_prepare_builds_cleaning_command(monkeypatch, tmp_path):
    monkeypatch.setenv("PYHFO_AGENT_APP_ROOT", str(tmp_path))
    monkeypatch.setenv("PYHFO_AGENT_PYTHON", "/usr/bin/python-test")

    command = pyhfo_tools._build_command(
        "pyhfo_prepare_recording",
        {
            "input_path": "case.edf",
            "output_path": "prepared/case_clean.fif",
            "extra_bad_channels": ["A1"],
            "drop_flat_channels": True,
            "bipolar_montage": "pairs",
            "bipolar_pairs": [{"anode": "A1", "cathode": "A2", "name": "A1-A2"}],
            "line_noise_notch_hz": 60,
        },
    )

    assert command[:4] == ["/usr/bin/python-test", "-m", "pyhfo.agent_cli", "prepare"]
    assert command[command.index("--input") + 1] == "case.edf"
    assert command[command.index("--output") + 1] == "prepared/case_clean.fif"
    assert command[command.index("--extra-bad-channel") + 1] == "A1"
    assert command[command.index("--bipolar-montage") + 1] == "pairs"
    assert json.loads(command[command.index("--bipolar-pairs-json") + 1]) == [
        {"anode": "A1", "cathode": "A2", "name": "A1-A2"}
    ]
    assert command[command.index("--line-noise-notch-hz") + 1] == "60"


def test_pyhfo_sidecar_commands_build_from_manifest(monkeypatch, tmp_path):
    monkeypatch.setenv("PYHFO_AGENT_APP_ROOT", str(tmp_path))
    monkeypatch.setenv("PYHFO_AGENT_PYTHON", "/usr/bin/python-test")

    manifest = pyhfo_tools._build_command("pyhfo_get_capability_manifest", {"include_missing": False})

    assert manifest == ["/usr/bin/python-test", "-m", "pyhfo.agent_cli", "manifest", "--callable-only"]


def test_pyhfo_removed_app_state_and_dispatch_tools_are_unknown(monkeypatch, tmp_path):
    monkeypatch.setenv("PYHFO_AGENT_APP_ROOT", str(tmp_path))
    monkeypatch.setenv("PYHFO_AGENT_PYTHON", "/usr/bin/python-test")

    for name in ("pyhfo_get_app_state", "pyhfo_dispatch_action"):
        with pytest.raises(ValueError, match="unknown PyHFO tool"):
            pyhfo_tools._build_command(name, {})

        result = pyhfo_tools.execute_sync(name, {})
        assert result["success"] is False
        assert result["error"] == f"unknown PyHFO tool: {name}"


def test_pyhfo_parses_json_after_progress_text():
    parsed = pyhfo_tools._parse_json_payload('loading...\\n{"status":"complete","num_events":3}\\n')

    assert parsed == {"status": "complete", "num_events": 3}


def test_pyhfo_execute_sync_returns_parsed_json(monkeypatch, tmp_path):
    (tmp_path / "src" / "pyhfo").mkdir(parents=True)
    (tmp_path / "src" / "pyhfo" / "agent_cli.py").write_text("# cli", encoding="utf-8")
    monkeypatch.setenv("PYHFO_AGENT_APP_ROOT", str(tmp_path))
    captured = {}

    def fake_run(command, **kwargs):
        captured["command"] = command
        captured["cwd"] = kwargs["cwd"]
        captured["env"] = kwargs["env"]
        return subprocess.CompletedProcess(
            command,
            0,
            stdout=json.dumps({"input_path": "case.edf", "sample_freq": 200.0}),
            stderr="",
        )

    monkeypatch.setattr(subprocess, "run", fake_run)

    result = pyhfo_tools.execute_sync("pyhfo_get_recording_info", {"input_path": "case.edf"})

    assert result["success"] is True
    assert result["result"]["sample_freq"] == 200.0
    assert captured["cwd"] == str(tmp_path)
    assert captured["env"]["PYTHONPATH"].split(os.pathsep)[0] == str(tmp_path / "src")
    assert captured["command"][2:4] == ["pyhfo.agent_cli", "info"]


def test_pyhfo_execute_sync_reports_missing_app(monkeypatch, tmp_path):
    monkeypatch.setenv("PYHFO_AGENT_APP_ROOT", str(tmp_path / "missing"))

    result = pyhfo_tools.execute_sync("pyhfo_get_recording_info", {"input_path": "case.edf"})

    assert result["success"] is False
    assert "PYHFO_AGENT_APP_ROOT" in result["hint"]


def _definition_by_name(name):
    return next(tool for tool in pyhfo_tools.get_tool_definitions() if tool["function"]["name"] == name)


def test_pyhfo_tool_schemas_include_llm_operational_guidance():
    info = _definition_by_name("pyhfo_get_recording_info")
    detect = _definition_by_name("pyhfo_detect_events")
    prepare = _definition_by_name("pyhfo_prepare_recording")
    batch_create = _definition_by_name("pyhfo_batch_create")
    batch_run = _definition_by_name("pyhfo_batch_run")

    assert "Read-only first-step" in info["function"]["description"]
    assert "does not detect flat channels" in info["function"]["description"]

    detect_description = detect["function"]["description"]
    assert "Do not call for metadata-only requests" in detect_description
    assert "pyhfo_prepare_recording first" in detect_description
    assert "parameter preset/default confirmation, filter band, or channel scope is underspecified" in detect_description
    assert "n_jobs=1" in detect_description
    assert "0.95*Nyquist" in detect_description
    detect_props = detect["function"]["parameters"]["properties"]
    assert detect_props["biomarker"]["enum"] == ["HFO", "Spindle", "Spike"]
    assert detect_props["filter"]["examples"] == [{"fp": 80, "fs": 450}]
    assert "detector_availability" in detect_props["detector"]["description"]
    assert "MOLLE/A7" in detect_props["detector"]["description"]
    assert "do not silently default" in detect_props["detector"]["description"]
    assert "protocol" in detect_props
    assert "scope" in detect_props
    assert "all_channels" in detect_props
    assert "confirmed_defaults" in detect_props
    assert "default" not in detect_props["detector"]
    assert "For Spindle smoke tests" in detect_description

    prepare_description = prepare["function"]["description"]
    assert "Safe default policy" in prepare_description
    assert "do not drop outliers" in prepare_description
    assert "bipolar re-referencing" in prepare_description
    assert "line_freq is missing" in prepare_description

    assert "does not run event detection" in batch_create["function"]["description"]
    assert "Do not use batch_run" in batch_run["function"]["description"]
    assert "detection.n_jobs=1" in batch_run["function"]["description"]


def test_pyhfo_execute_sync_returns_llm_result_guidance(monkeypatch, tmp_path):
    (tmp_path / "src" / "pyhfo").mkdir(parents=True)
    (tmp_path / "src" / "pyhfo" / "agent_cli.py").write_text("# cli", encoding="utf-8")
    monkeypatch.setenv("PYHFO_AGENT_APP_ROOT", str(tmp_path))

    def fake_run(command, **kwargs):
        return subprocess.CompletedProcess(
            command,
            0,
            stdout=json.dumps({"channel_names": ["A1-A2"], "sample_freq": 1000.0, "duration": 70.0}),
            stderr="",
        )

    monkeypatch.setattr(subprocess, "run", fake_run)

    result = pyhfo_tools.execute_sync("pyhfo_get_recording_info", {"input_path": "case.edf"})

    assert result["success"] is True
    assert "llm_guidance" in result
    guidance = result["llm_guidance"]
    assert "result.sample_freq/result.sfreq" in guidance["read_these_fields"]
    assert any("Nyquist" in item for item in guidance["interpretation_policy"])
    assert any("pyhfo_prepare_recording" in item for item in guidance["next_safe_actions"])


def test_pyhfo_failure_returns_llm_result_guidance(monkeypatch, tmp_path):
    monkeypatch.setenv("PYHFO_AGENT_APP_ROOT", str(tmp_path / "missing"))

    result = pyhfo_tools.execute_sync("pyhfo_detect_events", {"input_path": "case.edf", "output_dir": "out"})

    assert result["success"] is False
    assert "llm_guidance" in result
    assert any("event counts" in item for item in result["llm_guidance"]["interpretation_policy"])


def test_pyhfo_prepare_guidance_mentions_bipolar_and_notch():
    guidance = pyhfo_tools._llm_result_guidance("pyhfo_prepare_recording", success=True)

    assert "result.bipolar_montage.added_channels/result.bipolar_montage.warnings" in guidance["read_these_fields"]
    assert "result.notch_freqs/result.line_noise_notch_hz" in guidance["read_these_fields"]
    assert any("bipolar montage" in item for item in guidance["interpretation_policy"])


def test_signal_understanding_tools_build_cli_commands(monkeypatch, tmp_path):
    monkeypatch.setenv("PYHFO_AGENT_APP_ROOT", str(tmp_path))
    monkeypatch.setenv("PYHFO_AGENT_PYTHON", "/usr/bin/python-test")

    roi = pyhfo_tools._build_command("pyhfo_infer_brain_signal_roi", {"input_path": "case.edf"})
    qc = pyhfo_tools._build_command(
        "pyhfo_compute_channel_qc",
        {"input_path": "case.edf", "exclude_channels": ["EKG1-EKG2"], "outlier_z_threshold": 7},
    )
    spectral = pyhfo_tools._build_command(
        "pyhfo_compute_spectral_profile",
        {"input_path": "case.edf", "exclude_channels": ["X1-X2"], "max_channels": 8},
    )
    line_noise = pyhfo_tools._build_command(
        "pyhfo_detect_line_noise",
        {
            "input_path": "case.edf",
            "exclude_channels": ["EKG1-EKG2"],
            "candidate_frequencies_hz": [60],
            "site_line_freq_hz": 60,
            "ratio_threshold": 4,
        },
    )
    plan = pyhfo_tools._build_command("pyhfo_recommend_detector_plan", {"input_path": "case.edf"})
    rank = pyhfo_tools._build_command(
        "pyhfo_rank_candidate_channels",
        {
            "runs": [{"biomarker": "HFO", "events_csv": "/tmp/hfo.csv"}],
            "duration_seconds": 300,
            "exclude_channels": ["EKG1-EKG2"],
            "top_n": 5,
        },
    )

    assert roi == ["/usr/bin/python-test", "-m", "pyhfo.agent_cli", "roi", "--input", "case.edf"]
    assert qc[:6] == ["/usr/bin/python-test", "-m", "pyhfo.agent_cli", "qc", "--input", "case.edf"]
    assert "--exclude-channel" in qc and "EKG1-EKG2" in qc
    assert "--outlier-z-threshold" in qc and "7" in qc
    assert spectral[:6] == ["/usr/bin/python-test", "-m", "pyhfo.agent_cli", "spectral", "--input", "case.edf"]
    assert "--max-channels" in spectral and "8" in spectral
    assert line_noise[:6] == ["/usr/bin/python-test", "-m", "pyhfo.agent_cli", "line-noise", "--input", "case.edf"]
    assert "--candidate-frequency" in line_noise and "60" in line_noise
    assert "--site-line-freq-hz" in line_noise and "60" in line_noise
    assert "--ratio-threshold" in line_noise and "4" in line_noise
    assert plan == ["/usr/bin/python-test", "-m", "pyhfo.agent_cli", "detector-plan", "--input", "case.edf"]
    assert rank[:4] == ["/usr/bin/python-test", "-m", "pyhfo.agent_cli", "rank-candidates"]
    assert "HFO=/tmp/hfo.csv" in rank
    assert "--duration-seconds" in rank and "300" in rank


def test_signal_understanding_guidance_is_available():
    assert "result.default_detection_exclusions" in pyhfo_tools._llm_result_guidance("pyhfo_infer_brain_signal_roi", True)["read_these_fields"]
    assert any("heuristic" in item for item in pyhfo_tools._llm_result_guidance("pyhfo_compute_channel_qc", True)["interpretation_policy"])
    assert any("Nyquist" in item for item in pyhfo_tools._llm_result_guidance("pyhfo_compute_spectral_profile", True)["interpretation_policy"])
    assert "result.decision" in pyhfo_tools._llm_result_guidance("pyhfo_detect_line_noise", True)["read_these_fields"]
    assert "result.recommended_runs" in pyhfo_tools._llm_result_guidance("pyhfo_recommend_detector_plan", True)["read_these_fields"]
    assert any("not clinical pathological labels" in item for item in pyhfo_tools._llm_result_guidance("pyhfo_rank_candidate_channels", True)["interpretation_policy"])
