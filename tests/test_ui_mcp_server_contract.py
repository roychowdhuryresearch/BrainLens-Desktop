from __future__ import annotations

import json
from pathlib import Path

from ui_mcp.broker import UiBus
from ui_mcp import mcp_server


CATALOG = Path(__file__).resolve().parents[1] / "contracts" / "ui-command-catalog.json"


def test_ui_mcp_tool_defs_cover_catalog_and_common_workflows():
    data = json.loads(CATALOG.read_text(encoding="utf-8"))
    catalog_types = {command["type"] for command in data["commands"]}

    defs = {tool["name"]: tool for tool in mcp_server._tool_defs()}

    assert {"get_ui_state", "emit_ui_command", "wait_for_ui_command", "inspect_waveform"} <= set(defs)
    emit = defs["emit_ui_command"]
    enum = set(emit["inputSchema"]["properties"]["type"]["enum"])
    assert enum == catalog_types
    description = emit["description"]
    for phrase in [
        "detection.run",
        "detector_params",
        "detection.focus_top_candidate_channel",
        "waveform.focus_hotspot_channels",
        "classification.run",
        "events.stage_annotation",
        "result-shaping choices",
        "ask one concise clarification",
        "do not silently choose STE/MOLLE, filter bands, thresholds, or all-channel scope",
        'A MOLLE spindle run can use {"biomarker":"Spindle","detector":"MOLLE"',
        'Never use detector="STE" for biomarker="Spindle"',
        "auto-run/full autonomy may start compute commands immediately",
        "wait_for_ui_command",
    ]:
        assert phrase in description
    wait = defs["wait_for_ui_command"]
    assert "command_id" in wait["inputSchema"]["required"]
    assert "requires_completion_callback=true" in wait["description"]
    assert "analysis/compute/review_write/export/destructive" in wait["description"]
    assert "terminal applied" in wait["description"]


def test_emit_ui_command_marks_commands_that_need_completion_callback(monkeypatch):
    def fake_broker(method: str, path: str, body: dict | None = None):
        assert (method, path) == ("POST", "/ui/emit")
        assert body is not None
        return {
            "success": True,
            "command": {
                "command_id": "mcp-test",
                "type": body["type"],
                "payload": body["payload"],
            },
        }

    monkeypatch.setattr(mcp_server, "_broker", fake_broker)

    detection = json.loads(mcp_server.tool_emit_ui_command({
        "type": "detection.run",
        "payload": {"biomarker": "HFO", "detector": "STE", "confirmed_defaults": True},
        "reason": "test",
    }))
    assert detection["requires_completion_callback"] is True
    assert "wait_for_ui_command" in detection["agent_message_policy"]

    parameter_write = json.loads(mcp_server.tool_emit_ui_command({
        "type": "detection.set_parameters",
        "payload": {"filter": {"fp": 80, "fs": 250}},
        "reason": "test",
    }))
    assert parameter_write["requires_completion_callback"] is False

    annotation_write = json.loads(mcp_server.tool_emit_ui_command({
        "type": "events.stage_annotation",
        "payload": {"event_id": "evt-1", "label": "uncertain"},
        "reason": "test",
    }))
    assert annotation_write["requires_completion_callback"] is True


def test_emit_ui_command_rejects_underspecified_detection_run_before_broker(monkeypatch):
    calls = []

    def broker_should_not_be_called(method: str, path: str, body: dict | None = None):
        calls.append((method, path, body))
        raise AssertionError("underspecified detection.run must not reach broker")

    monkeypatch.setattr(mcp_server, "_broker", broker_should_not_be_called)

    detector_only = json.loads(mcp_server.tool_emit_ui_command({
        "type": "detection.run",
        "payload": {"biomarker": "HFO", "detector": "STE"},
        "reason": "bad direct MCP call",
    }))
    assert detector_only["success"] is False
    assert detector_only["clarification_required"] is True
    assert detector_only["blocked_by_policy"] == "detection_run_payload_validation"
    assert "filter band" in detector_only["error"]
    assert "channel scope" in detector_only["error"]
    assert "detector parameters" in detector_only["error"]

    missing_scope = json.loads(mcp_server.tool_emit_ui_command({
        "type": "detection.run",
        "payload": {
            "biomarker": "HFO",
            "detector": "MNI",
            "filter": {"fp": 80, "fs": 250},
            "detector_params": {"thrd_perc": 99.9},
        },
        "reason": "bad direct MCP call",
    }))
    assert missing_scope["success"] is False
    assert "channel scope" in missing_scope["error"]

    bad_spindle = json.loads(mcp_server.tool_emit_ui_command({
        "type": "detection.run",
        "payload": {
            "biomarker": "Spindle",
            "detector": "STE",
            "filter": {"fp": 11, "fs": 16},
            "detector_params": {"freq_sp": [11, 16]},
            "all_channels": True,
        },
        "reason": "bad direct MCP call",
    }))
    assert bad_spindle["success"] is False
    assert "not a supported Spindle detector" in bad_spindle["error"]
    assert calls == []


def test_emit_ui_command_allows_fully_specified_detection_run(monkeypatch):
    calls = []

    def fake_broker(method: str, path: str, body: dict | None = None):
        calls.append((method, path, body))
        if method == "GET":
            return {"ack": {}}
        assert body is not None
        return {
            "success": True,
            "command": {
                "command_id": "mcp-detect",
                "type": body["type"],
                "payload": body["payload"],
            },
        }

    monkeypatch.setattr(mcp_server, "_broker", fake_broker)

    result = json.loads(mcp_server.tool_emit_ui_command({
        "type": "detection.run",
        "payload": {
            "biomarker": "HFO",
            "detector": "MNI",
            "filter": {"fp": 80, "fs": 250},
            "detector_params": {"thrd_perc": 99.9},
            "scope": "all",
            "all_channels": True,
        },
        "reason": "confirmed detector run",
    }))

    assert result["success"] is True
    assert result["requires_completion_callback"] is True
    assert calls[0][0:2] == ("POST", "/ui/emit")
    assert calls[0][2]["payload"]["all_channels"] is True


def test_wait_for_ui_command_callback_semantics(monkeypatch):
    def applied_compute_broker(method: str, path: str, body: dict | None = None):
        assert (method, path) == ("GET", "/ui/ack?command_id=mcp-compute")
        return {"ack": {"status": "applied", "command_type": "detection.run"}}

    monkeypatch.setattr(mcp_server, "_broker", applied_compute_broker)
    compute = json.loads(mcp_server.tool_wait_for_ui_command({"command_id": "mcp-compute", "timeout_seconds": 0}))
    assert compute["success"] is False
    assert compute["timeout"] is True
    assert compute["last_ack"]["status"] == "applied"

    def applied_review_broker(method: str, path: str, body: dict | None = None):
        assert (method, path) == ("GET", "/ui/ack?command_id=mcp-review")
        return {"ack": {"status": "applied", "command_type": "events.stage_annotation"}}

    monkeypatch.setattr(mcp_server, "_broker", applied_review_broker)
    review = json.loads(mcp_server.tool_wait_for_ui_command({"command_id": "mcp-review", "timeout_seconds": 0}))
    assert review["success"] is False
    assert review["timeout"] is True
    assert review["last_ack"]["status"] == "applied"

    def completed_review_broker(method: str, path: str, body: dict | None = None):
        assert (method, path) == ("GET", "/ui/ack?command_id=mcp-review")
        return {"ack": {"status": "complete", "command_type": "events.stage_annotation"}}

    monkeypatch.setattr(mcp_server, "_broker", completed_review_broker)
    review = json.loads(mcp_server.tool_wait_for_ui_command({"command_id": "mcp-review", "timeout_seconds": 0}))
    assert review["success"] is True
    assert review["terminal"] is True
    assert review["ack"]["status"] == "complete"


def test_renderer_staged_ack_is_detected_from_canonical_receipt_transition(monkeypatch):
    bus = UiBus()
    bus.set_state({
        "session_id": "session-1",
        "state_revision": "rev-1",
        "resource_scope": {
            "state_revision": "rev-1",
            "recording_sha256": "a" * 64,
        },
    })
    command, error = bus.emit(
        "detection.run",
        {"biomarker": "HFO", "detector": "STE"},
        "run",
        authority_scope={
            "request_id": "req-1",
            "message_id": "msg-1",
            "conversation_id": "conv-1",
            "state_revision": "rev-1",
            "recording_fingerprint": "a" * 64,
            "resource_scope": {
                "recording_sha256": "a" * 64,
                "state_revision": "rev-1",
            },
        },
    )
    assert error is None and command is not None

    receipt, error = bus.record_ack(command["command_id"], {
        "status": "staged",
        "command_type": "detection.run",
    })
    assert error is None and receipt is not None
    assert receipt["status"] == "queued"
    assert "reported_status" not in receipt
    assert receipt["transitions"][-1] == {
        "sequence": 1,
        "from": "queued",
        "to": "queued",
        "observed_at": receipt["transitions"][-1]["observed_at"],
        "source": "renderer_ack",
    }

    def staged_broker(method: str, path: str, body: dict | None = None):
        assert (method, path) == (
            "GET",
            f"/ui/ack?command_id={command['command_id']}",
        )
        return {"ack": receipt}

    monkeypatch.setattr(mcp_server, "_broker", staged_broker)
    assert mcp_server._poll_apply_outcome(command["command_id"]) == receipt

    result = json.loads(mcp_server.tool_wait_for_ui_command({
        "command_id": command["command_id"],
        "timeout_seconds": 0,
    }))
    assert result["success"] is True
    assert result["terminal"] is False
    assert result["ack"]["status"] == "staged"
    assert result["ack"]["receipt_status"] == "queued"
    assert "reported_status" not in result["ack"]


def test_wait_for_ui_command_treats_noop_rejected_and_error_as_failures(monkeypatch):
    for reported, canonical in (("noop", "noop"), ("rejected", "rejected"), ("error", "failed")):
        def failed_broker(method: str, path: str, body: dict | None = None, status=reported):
            assert method == "GET"
            return {"ack": {"status": status, "command_type": "workspace.reset_waveform_view"}}

        monkeypatch.setattr(mcp_server, "_broker", failed_broker)
        result = json.loads(mcp_server.tool_wait_for_ui_command({
            "command_id": f"mcp-{reported}",
            "timeout_seconds": 0,
        }))
        assert result["success"] is False
        assert result["terminal"] is True
        assert result["failure_status"] == canonical


def test_emit_ui_command_forwards_optional_idempotency_key(monkeypatch):
    captured = {}

    def fake_broker(method: str, path: str, body: dict | None = None):
        assert (method, path) == ("POST", "/ui/emit")
        captured.update(body or {})
        return {
            "success": True,
            "command": {"command_id": "mcp-idempotent", "type": body["type"], "payload": body["payload"]},
        }

    monkeypatch.setattr(mcp_server, "_broker", fake_broker)
    result = json.loads(mcp_server.tool_emit_ui_command({
        "type": "workspace.open_panel",
        "payload": {"panel": "Review"},
        "idempotency_key": "turn-42-open-review",
        "authority_scope": {
            "request_id": "req-42",
            "message_id": "msg-42",
            "conversation_id": "conv-42",
            "state_revision": "rev-42",
        },
    }))

    assert result["success"] is True
    assert captured["idempotency_key"] == "turn-42-open-review"
    assert captured["authority_scope"]["message_id"] == "msg-42"
    emit_def = next(tool for tool in mcp_server._tool_defs() if tool["name"] == "emit_ui_command")
    assert "idempotency_key" in emit_def["inputSchema"]["properties"]
    assert "authority_scope" not in emit_def["inputSchema"]["properties"]


def test_ui_broker_rejects_unknown_and_statusless_acks():
    bus = UiBus()

    receipt, error = bus.record_ack("mcp-unknown", {"status": "complete", "detail": "done"})
    assert receipt is None
    assert error == "unknown command_id; ACK rejected"

    command, error = bus.emit("workspace.reset_waveform_view", {}, "reset")
    assert error is None and command is not None
    receipt, error = bus.record_ack(command["command_id"], {"received": True})
    assert receipt is None
    assert error == "ack status is required"
    assert bus.get_ack(command["command_id"])["status"] == "queued"


def test_runtime_no_longer_exposes_builtin_ui_tool_module():
    assert not (Path(__file__).resolve().parents[1] / "runtime" / "agent_runtime" / "ui_tools.py").exists()
