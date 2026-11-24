"""Slice-3 drain proof: agent-emitted ui_commands flow out via the `done` event into ChatResponse.

The orchestrator binds state.ui_commands at turn start and puts them on the `done` event;
process_message drains that event into ChatResponse.ui_commands (which internal_agent copies into
the /chat result dict). Here we simulate the stream's `done` event and assert process_message surfaces it.
"""
import pytest

from runtime.services.agent_service import AgentService


class _FakeAI:
    class config:
        model = "fake-model"


def _service():
    return AgentService(ai_service=_FakeAI(), mcp_manager=None, router_model_config=None, ai_models=[])


@pytest.mark.asyncio
async def test_process_message_surfaces_ui_commands_from_done_event(monkeypatch):
    svc = _service()
    cmds = [
        {"command_id": "c1", "type": "waveform.set_viewport", "payload": {"start_seconds": 5}, "requires_confirmation": False},
        {"command_id": "c2", "type": "detection.run", "payload": {"biomarker": "HFO", "detector": "STE"}, "requires_confirmation": True},
    ]

    async def fake_stream(**kwargs):
        # UI state is no longer forwarded in-process; the agent must read it through MCP get_ui_state.
        assert "ui_state" not in kwargs
        yield {"event": "content", "data": {"text": "done."}}
        yield {"event": "done", "data": {"sources": [], "model_used": "m", "active_skill": "s", "ui_commands": cmds}}

    async def _no_refuse(_message):
        return False

    monkeypatch.setattr(svc, "stream_message", fake_stream)
    monkeypatch.setattr(svc, "should_refuse_sensitive_internal_request", _no_refuse)

    resp = await svc.process_message(message="hi")
    assert resp.content == "done."
    assert resp.ui_commands == cmds
    # the write command stays flagged for the renderer to stage
    assert resp.ui_commands[1]["requires_confirmation"] is True
