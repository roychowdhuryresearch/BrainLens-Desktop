"""HTTP-contract test for the co-pilot seams at the real /internal/agent/v1/chat endpoint.

The request still accepts legacy `ui_state`, but the runtime must not forward it into AgentService;
desktop UI state is read through MCP get_ui_state. The response still carries `ui_commands`.
"""
import asyncio

from runtime.api import internal_agent
from runtime.models.schemas import ChatResponse

_UI_COMMANDS = [
    {"command_id": "c1", "type": "waveform.set_viewport", "payload": {"start_seconds": 5, "duration_seconds": 4}, "requires_confirmation": False},
    {"command_id": "c2", "type": "detection.run", "payload": {"biomarker": "HFO", "detector": "STE"}, "requires_confirmation": True},
]


def _patch_service(monkeypatch):
    class _FakeService:
        async def process_message(self, **kwargs):
            assert "ui_state" not in kwargs
            return ChatResponse(message_id="m1", content="ok", sources=[], model_used="fake", ui_commands=_UI_COMMANDS)

    monkeypatch.setattr(internal_agent, "get_agent_service", lambda *_args, **_kwargs: _FakeService())
    monkeypatch.setattr(internal_agent, "_load_allowed_skill_packages", lambda req: None)
    monkeypatch.setattr(internal_agent, "process_uploaded_attachments", lambda *a, **k: ("", []))


def test_chat_endpoint_drops_ui_state_and_returns_ui_commands(monkeypatch):
    _patch_service(monkeypatch)
    body = {
        "request_id": "r1",
        "message": "center the spike on A1",
        "skill_environment": "prod",
        "user_context": {"user_id": "u", "username": "doc", "role": "USER"},
        "ui_state": {"selected_channel": "A1", "active_panel": "agent"},
    }
    req = internal_agent.InternalAgentChatRequest(**body)
    data = asyncio.run(internal_agent.chat(req))
    assert data["ui_commands"] == _UI_COMMANDS
    assert data["ui_commands"][1]["requires_confirmation"] is True  # write stays staged
    assert data["content"] == "ok"
