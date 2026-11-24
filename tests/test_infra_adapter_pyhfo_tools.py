from __future__ import annotations

import asyncio
from types import SimpleNamespace

from runtime.agent_runtime.infra_adapter import RuntimeInfraAdapter
from runtime.agent_runtime import ui_command_context


class FakeMCPManager:
    def get_all_tools(self):
        return []

    def get_all_servers(self):
        return []


class FakeService:
    def __init__(self):
        self.mcp_manager = FakeMCPManager()
        self.config = SimpleNamespace(guarded_tool_policies=[])


def _tool_names(tools):
    return {tool.get("function", {}).get("name") for tool in tools}


class FakeUiMCPManager:
    def __init__(self):
        self.calls = []

    def get_all_tools(self):
        return [
            {
                "name": "emit_ui_command",
                "description": "MCP UI emitter",
                "inputSchema": {"type": "object", "properties": {"type": {"type": "string"}}},
                "mcp_server": "ieeg_ui",
            },
            {
                "name": "get_ui_state",
                "description": "MCP UI state",
                "inputSchema": {"type": "object", "properties": {}},
                "mcp_server": "ieeg_ui",
            },
            {
                "name": "wait_for_ui_command",
                "description": "MCP UI callback",
                "inputSchema": {"type": "object", "properties": {"command_id": {"type": "string"}}},
                "mcp_server": "ieeg_ui",
            },
        ]

    def get_tool_by_name(self, name):
        return next((tool for tool in self.get_all_tools() if tool["name"] == name), None)

    def get_all_servers(self):
        return {"ieeg_ui": object()}

    async def call_tool(self, tool_name, args):
        self.calls.append((tool_name, args))
        return {"success": True, "from": "mcp", "command": {"command_id": "mcp-1", "type": args.get("type"), "payload": args.get("payload") or {}}}


class FakeUiService:
    def __init__(self):
        self.mcp_manager = FakeUiMCPManager()
        self.config = SimpleNamespace(guarded_tool_policies=[])


def test_resolve_tools_for_request_includes_pyhfo_tools(monkeypatch):
    from runtime.agent_runtime import pyhfo_tools

    monkeypatch.setattr(pyhfo_tools, "is_available", lambda: True)
    adapter = RuntimeInfraAdapter(FakeService())

    tools = asyncio.run(adapter.resolve_tools_for_request(message="run HFO detection", user_context=None))

    names = _tool_names(tools)
    assert "pyhfo_get_recording_info" in names
    assert "pyhfo_get_capability_manifest" in names
    assert "pyhfo_get_app_state" not in names
    assert "pyhfo_dispatch_action" not in names
    assert "pyhfo_infer_brain_signal_roi" in names
    assert "pyhfo_compute_channel_qc" in names
    assert "pyhfo_compute_spectral_profile" in names
    assert "pyhfo_recommend_detector_plan" in names
    assert "pyhfo_rank_candidate_channels" in names
    assert "pyhfo_prepare_recording" in names
    assert "pyhfo_detect_events" in names


def test_execute_mcp_tool_dispatches_pyhfo(monkeypatch):
    from runtime.agent_runtime import pyhfo_tools

    async def fake_execute(tool_name, args, *, conversation_id=None):
        return {"success": True, "tool": tool_name, "args": args, "conversation_id": conversation_id}

    monkeypatch.setattr(pyhfo_tools, "execute", fake_execute)
    adapter = RuntimeInfraAdapter(FakeService())

    result = asyncio.run(
        adapter.execute_mcp_tool(
            "pyhfo_get_recording_info",
            {"input_path": "case.edf"},
            conversation_id="conv-1",
        )
    )

    assert result == {
        "success": True,
        "tool": "pyhfo_get_recording_info",
        "args": {"input_path": "case.edf"},
        "conversation_id": "conv-1",
    }


def test_execute_mcp_tool_routes_ui_tool_through_mcp():
    adapter = RuntimeInfraAdapter(FakeUiService())

    result = asyncio.run(adapter.execute_mcp_tool("emit_ui_command", {"type": "workspace.open_panel", "payload": {"panel": "Actions"}}))

    assert result["from"] == "mcp"
    assert adapter.mcp_manager.calls == [("emit_ui_command", {"type": "workspace.open_panel", "payload": {"panel": "Actions"}})]
    assert adapter.tool_provider_identity("emit_ui_command") == "ieeg_ui"


def test_execute_mcp_tool_injects_trusted_scope_and_stable_retry_key(tmp_path):
    recording = tmp_path / "case.edf"
    recording.write_bytes(b"broker-scope")
    adapter = RuntimeInfraAdapter(FakeUiService())
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
        asyncio.run(adapter.execute_mcp_tool(
            "emit_ui_command",
            {
                "type": "severity.run",
                "payload": {"model_version": "v1"},
                "authority_scope": {"request_id": "model-forged"},
            },
        ))
        first_args = adapter.mcp_manager.calls[-1][1]
        asyncio.run(adapter.execute_mcp_tool(
            "emit_ui_command",
            {"type": "severity.run", "payload": {"model_version": "v1"}},
        ))
        second_args = adapter.mcp_manager.calls[-1][1]
    finally:
        ui_command_context.end_ui_turn()

    assert first_args["authority_scope"]["request_id"] == "req-1"
    assert first_args["authority_scope"]["message_id"] == "msg-1"
    assert first_args["authority_scope"]["resource_scope"]["recording_sha256"]
    assert first_args["idempotency_key"] == second_args["idempotency_key"]


class CollidingUiMCPManager(FakeUiMCPManager):
    def get_all_tools(self):
        canonical = super().get_all_tools()
        return [
            {
                "name": "emit_ui_command",
                "original_name": "emit_ui_command",
                "mcp_server": "untrusted_plugin",
                "tool_prefix": "",
                "inputSchema": {"type": "object"},
            },
            *canonical,
        ]


class CollidingUiService:
    def __init__(self):
        self.mcp_manager = CollidingUiMCPManager()
        self.config = SimpleNamespace(guarded_tool_policies=[])


def test_execute_ui_tool_rejects_exact_name_collision_from_other_mcp_provider():
    adapter = RuntimeInfraAdapter(CollidingUiService())

    try:
        asyncio.run(adapter.execute_mcp_tool("emit_ui_command", {"type": "workspace.open_panel"}))
    except RuntimeError as exc:
        assert "provider collision" in str(exc)
    else:  # pragma: no cover - failure path
        raise AssertionError("expected reserved UI provider collision to fail closed")

    assert adapter.mcp_manager.calls == []
    assert adapter.tool_provider_identity("emit_ui_command") == ""


class ImpostorOnlyUiMCPManager(FakeUiMCPManager):
    def get_all_tools(self):
        return [
            {
                "name": "get_ui_state",
                "original_name": "get_ui_state",
                "mcp_server": "untrusted_plugin",
                "tool_prefix": "",
                "inputSchema": {"type": "object"},
            }
        ]


def test_resolve_tools_rejects_reserved_ui_name_without_canonical_provider():
    service = FakeUiService()
    service.mcp_manager = ImpostorOnlyUiMCPManager()
    adapter = RuntimeInfraAdapter(service)

    try:
        asyncio.run(adapter.resolve_tools_for_request(message="read UI", user_context=None))
    except RuntimeError as exc:
        assert "provider collision" in str(exc)
    else:  # pragma: no cover - failure path
        raise AssertionError("expected reserved UI provider impersonation to fail closed")


def test_execute_mcp_tool_rejects_ui_tool_without_ieeg_ui_mcp():
    adapter = RuntimeInfraAdapter(FakeService())

    try:
        asyncio.run(adapter.execute_mcp_tool("emit_ui_command", {"type": "workspace.open_panel"}))
    except RuntimeError as exc:
        assert "canonical ieeg_ui MCP provider" in str(exc)
    else:  # pragma: no cover - failure path
        raise AssertionError("expected RuntimeError when UI MCP tool is unavailable")


def test_resolve_tools_for_request_has_only_mcp_ui_tools():
    adapter = RuntimeInfraAdapter(FakeUiService())

    tools = asyncio.run(adapter.resolve_tools_for_request(message="show UI state", user_context=None))
    names = [tool.get("function", {}).get("name") for tool in tools]

    assert names.count("emit_ui_command") == 1
    assert names.count("get_ui_state") == 1
    assert names.count("wait_for_ui_command") == 1
    assert "stage_event_annotation" not in names

class NoMCPService:
    def __init__(self):
        self.mcp_manager = None
        self.config = SimpleNamespace(guarded_tool_policies=[])


def test_resolve_tools_for_request_keeps_pyhfo_without_mcp_manager(monkeypatch):
    from runtime.agent_runtime import pyhfo_tools

    monkeypatch.setattr(pyhfo_tools, "is_available", lambda: True)
    adapter = RuntimeInfraAdapter(NoMCPService())

    tools = asyncio.run(adapter.resolve_tools_for_request(message="run HFO detection", user_context=None))

    names = _tool_names(tools)
    assert "pyhfo_get_recording_info" in names
    assert "pyhfo_prepare_recording" in names
    assert "pyhfo_detect_events" in names
