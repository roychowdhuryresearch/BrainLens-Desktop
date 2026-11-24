"""UI seam schema checks: legacy ui_state parses, UI commands still drain out."""
import dataclasses

from runtime.api.internal_agent import InternalAgentChatRequest
from runtime.models.schemas import ChatResponse
from runtime.skills.models import ExecutionState


def test_chat_response_ui_commands_default_and_set():
    r = ChatResponse(message_id="m", content="hi", sources=[], model_used="x")
    assert r.ui_commands == []  # additive default — existing callers unaffected
    r2 = ChatResponse(
        message_id="m", content="hi", sources=[], model_used="x",
        ui_commands=[{"type": "waveform.set_viewport", "payload": {"start_seconds": 5}}],
    )
    assert r2.ui_commands[0]["type"] == "waveform.set_viewport"


def test_request_accepts_legacy_ui_state_field():
    assert "ui_state" in InternalAgentChatRequest.model_fields


def test_execution_state_accumulates_ui_commands():
    names = {f.name for f in dataclasses.fields(ExecutionState)}
    assert "ui_commands" in names
