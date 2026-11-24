from __future__ import annotations

import hashlib

from runtime.agent_runtime import ui_command_context


def test_ui_command_context_records_external_command_only():
    commands = []
    ui_command_context.begin_ui_turn(commands)
    try:
        ui_command_context.record_ui_command({"command_id": "mcp-1", "type": "waveform.set_viewport"})
        assert commands == [{"command_id": "mcp-1", "type": "waveform.set_viewport"}]
        assert ui_command_context.collected_ui_commands() == commands
    finally:
        ui_command_context.end_ui_turn()


def test_ui_command_context_without_turn_is_empty_and_non_throwing():
    ui_command_context.end_ui_turn()

    ui_command_context.record_ui_command({"command_id": "mcp-1"})
    assert ui_command_context.collected_ui_commands() == []


def test_current_authority_scope_and_retry_key_bind_to_turn_and_recording(tmp_path):
    recording = tmp_path / "case.edf"
    recording.write_bytes(b"scope-bound-recording")
    ui_command_context.begin_ui_turn(
        [],
        authority_scope={
            "request_id": "req-1",
            "message_id": "msg-1",
            "conversation_id": "conv-1",
            "state_revision": "rev-1",
            "recording_path": str(recording),
        },
    )
    try:
        scope = ui_command_context.current_authority_scope()
        assert scope is not None
        fingerprint = hashlib.sha256(recording.read_bytes()).hexdigest()
        assert scope["recording_fingerprint"] == fingerprint
        assert scope["resource_scope"] == {
            "state_revision": "rev-1",
            "recording_sha256": fingerprint,
        }
        first = ui_command_context.command_idempotency_key(
            "severity.run", {"z": 1, "nested": {"b": 2, "a": 1}},
        )
        second = ui_command_context.command_idempotency_key(
            "severity.run", {"nested": {"a": 1, "b": 2}, "z": 1},
        )
        assert first == second
        assert first is not None and first.startswith("runtime-ui-v1-")
    finally:
        ui_command_context.end_ui_turn()
