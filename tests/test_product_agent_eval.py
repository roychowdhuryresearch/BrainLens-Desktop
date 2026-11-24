from __future__ import annotations

import json

import pytest

from evals import run_product_eval
from evals.blackbox import agent_mcp_server
from evals.product_agent_eval import evaluate_fixture_scenarios, evaluate_trace, load_product_scenarios


def _scenario(data: dict, scenario_id: str) -> dict:
    return next(scenario for scenario in data["scenarios"] if scenario["id"] == scenario_id)


def test_product_agent_scenario_matrix_has_unique_fixture_covered_cases():
    data = load_product_scenarios()
    scenarios = data["scenarios"]

    assert len(scenarios) >= 10
    assert len({scenario["id"] for scenario in scenarios}) == len(scenarios)
    assert {"desktop_copilot", "headless_backend", "tool_boundary"} <= {scenario["surface"] for scenario in scenarios}
    for scenario in scenarios:
        assert scenario["user"]
        assert isinstance(scenario.get("expect"), dict)
        assert isinstance(scenario.get("fixture_trace"), dict)


def test_product_agent_fixture_traces_pass_their_contracts():
    data = load_product_scenarios()
    results = evaluate_fixture_scenarios(data)

    failures = [result.as_dict() for result in results if not result.passed]
    assert failures == []


def test_product_agent_eval_catches_missing_callback_wait():
    data = load_product_scenarios()
    scenario = _scenario(data, "desktop-confirmed-detection-waits-for-staged-callback")
    trace = dict(scenario["fixture_trace"])
    trace["tool_calls"] = [call for call in trace["tool_calls"] if call["name"] != "wait_for_ui_command"]

    result = evaluate_trace(scenario, trace)

    assert result.passed is False
    assert any("wait_for_ui_command" in failure for failure in result.failures)


def test_product_agent_eval_catches_forbidden_detection_run_for_ambiguous_request():
    data = load_product_scenarios()
    scenario = _scenario(data, "desktop-ambiguous-hfo-asks")
    trace = {
        "tool_calls": [
            {
                "name": "emit_ui_command",
                "args": {"type": "detection.run", "payload": {"biomarker": "HFO", "detector": "STE"}},
            }
        ],
        "tool_events": [],
        "final_answer": "I staged the run.",
    }

    result = evaluate_trace(scenario, trace)

    assert result.passed is False
    assert any("forbidden UI command 'detection.run'" in failure for failure in result.failures)


def test_product_agent_eval_catches_bad_payload_value():
    data = load_product_scenarios()
    scenario = _scenario(data, "desktop-confirmed-detection-waits-for-staged-callback")
    trace = json.loads(json.dumps(scenario["fixture_trace"]))
    trace["tool_calls"][0]["args"]["payload"]["detector"] = "MNI"

    result = evaluate_trace(scenario, trace)

    assert result.passed is False
    assert any("payload assertion failed" in failure and "detector" in failure for failure in result.failures)


def test_run_product_eval_fixture_mode_reports_all_passed():
    data = load_product_scenarios()
    rows = run_product_eval.run_fixture(data, "")
    summary = run_product_eval._summary(rows)

    assert summary["failed"] == 0
    assert summary["passed"] == len(data["scenarios"])


def test_agent_mcp_server_product_eval_passes_ui_state_and_allowed_mcps(monkeypatch):
    captured = {}

    def fake_stream(path, body, timeout):
        captured["path"] = path
        captured["body"] = body
        captured["timeout"] = timeout
        yield "content", {"text": "ok"}
        yield "done", {"message_id": "done-1"}

    monkeypatch.setattr(agent_mcp_server, "_sse_stream", fake_stream)

    result = json.loads(agent_mcp_server.tool_agent_run_task({
        "message": "show top HFO channel",
        "recording_path": "/tmp/case.edf",
        "ui_state": {"recording": {"loaded": True}},
        "allowed_mcps": [{"name": "ieeg-ui", "server_id": "ieeg_ui", "capabilities": ["tools"]}],
        "timeout_seconds": 12,
    }))

    assert result["ok"] is True
    assert captured["path"] == "/chat/stream"
    assert captured["body"]["recording_path"] == "/tmp/case.edf"
    assert captured["body"]["ui_state"]["recording"]["loaded"] is True
    assert captured["body"]["allowed_mcps"][0]["server_id"] == "ieeg_ui"


def test_agent_mcp_server_requires_service_token(monkeypatch):
    monkeypatch.setattr(agent_mcp_server, "TOKEN", "")
    with pytest.raises(ValueError, match="IEEG_AGENT_SERVICE_TOKEN"):
        agent_mcp_server._headers()


def test_agent_mcp_server_binds_contract_header_and_unwraps_canonical_sse(monkeypatch):
    monkeypatch.setattr(agent_mcp_server, "TOKEN", "fixture-token")
    assert agent_mcp_server._headers()["authorization"] == "Bearer fixture-token"
    assert agent_mcp_server._headers()["X-Contract-Version"] == "ieeg-agent.v1"

    event, data = agent_mcp_server._unwrap_sse_event(
        "content",
        {
            "contract_version": "ieeg-agent.v1",
            "request_id": "req-1",
            "conversation_id": "conv-1",
            "sequence": 0,
            "event": "content",
            "visibility": "public",
            "data": {"text": "canonical answer", "response_language": "en-US"},
        },
    )
    assert event == "content"
    assert data["text"] == "canonical answer"

    legacy_event, legacy_data = agent_mcp_server._unwrap_sse_event(
        "content",
        {"contract_version": "legacy-metadata", "text": "legacy answer"},
    )
    assert legacy_event == "content"
    assert legacy_data == {"contract_version": "legacy-metadata", "text": "legacy answer"}
