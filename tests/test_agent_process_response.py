import asyncio

import pytest

from runtime.api import internal_agent
from runtime.models.schemas import ChatResponse
from runtime.services.agent_service import (
    AgentService,
    AgentStreamResponseError,
    RequiredTurnPersistenceError,
)


class _FakeAI:
    class config:
        model = "fake-model"


def _service() -> AgentService:
    return AgentService(ai_service=_FakeAI(), mcp_manager=None, router_model_config=None, ai_models=[])


async def _never_refuse(_message):
    return False


@pytest.mark.asyncio
async def test_process_message_requires_done_and_never_synthesizes_eof_success(monkeypatch):
    service = _service()

    async def incomplete_stream(**_kwargs):
        yield {"event": "content", "data": {"text": "partial clinical answer"}}

    monkeypatch.setattr(service, "should_refuse_sensitive_internal_request", _never_refuse)
    monkeypatch.setattr(service, "stream_message", incomplete_stream)

    with pytest.raises(AgentStreamResponseError, match="^Agent stream did not complete$"):
        await service.process_message(message="review this")


@pytest.mark.asyncio
async def test_process_message_rejects_error_event_without_exposing_provider_detail(monkeypatch):
    service = _service()

    async def failed_stream(**_kwargs):
        yield {"event": "content", "data": {"text": "partial"}}
        yield {"event": "error", "data": {"message": "Bearer secret-provider-token"}}

    monkeypatch.setattr(service, "should_refuse_sensitive_internal_request", _never_refuse)
    monkeypatch.setattr(service, "stream_message", failed_stream)

    with pytest.raises(AgentStreamResponseError, match="^Agent stream failed$") as exc_info:
        await service.process_message(message="review this")
    assert "secret-provider-token" not in str(exc_info.value)


@pytest.mark.asyncio
async def test_process_message_honors_preview_discard_and_content_replacement(monkeypatch):
    service = _service()

    async def repaired_stream(**_kwargs):
        yield {"event": "content", "data": {"text": "discard me"}}
        yield {"event": "content_preview_discard", "data": {}}
        yield {"event": "content", "data": {"text": "old answer"}}
        yield {"event": "content_replace", "data": {"text": "grounded answer"}}
        yield {
            "event": "done",
            "data": {
                "message_id": "persisted-message",
                "sources": [{"id": "source-1"}],
                "model_used": "clinical-model",
                "tokens_used": 17,
                "ui_commands": [{"type": "review.open_event"}],
            },
        }

    monkeypatch.setattr(service, "should_refuse_sensitive_internal_request", _never_refuse)
    monkeypatch.setattr(service, "stream_message", repaired_stream)

    response = await service.process_message(message="review this")

    assert response.message_id == "persisted-message"
    assert response.content == "grounded answer"
    assert response.tokens_used == 17
    assert response.ui_commands == [{"type": "review.open_event"}]


@pytest.mark.asyncio
async def test_process_message_uses_one_nonshared_scope_when_conversation_is_missing(monkeypatch):
    service = _service()
    captured = {}

    async def completed_stream(**kwargs):
        captured["conversation_id"] = kwargs["conversation_id"]
        yield {"event": "content", "data": {"text": "ok"}}
        yield {"event": "done", "data": {"model_used": "fake-model"}}

    monkeypatch.setattr(service, "should_refuse_sensitive_internal_request", _never_refuse)
    monkeypatch.setattr(service, "stream_message", completed_stream)

    response = await service.process_message(message="hello")

    assert captured["conversation_id"].startswith("conv_ephemeral_")
    assert captured["conversation_id"] != "default"
    assert captured["conversation_id"] in response.message_id


def _internal_request(*, request_id="req-1", user_id="doctor-1", conversation_id=None):
    return internal_agent.InternalAgentChatRequest(
        request_id=request_id,
        conversation_id=conversation_id,
        message="review this",
        skill_environment="prod",
        user_context=internal_agent.InternalUserContext(
            user_id=user_id,
            username="doctor",
            role="USER",
        ),
    )


def test_internal_api_derives_stable_but_actor_isolated_conversation_scope():
    first = internal_agent._resolve_internal_conversation_id(_internal_request())
    retry = internal_agent._resolve_internal_conversation_id(_internal_request())
    other_request = internal_agent._resolve_internal_conversation_id(
        _internal_request(request_id="req-2")
    )
    other_actor = internal_agent._resolve_internal_conversation_id(
        _internal_request(user_id="doctor-2")
    )

    assert first == retry
    assert len({first, other_request, other_actor}) == 3
    assert all(value.startswith("conv_") for value in (first, other_request, other_actor))
    assert "default" not in {first, other_request, other_actor}


def test_sync_internal_api_uses_derived_scope_for_attachments_runtime_and_response(monkeypatch):
    captured = {}

    def attachments(conversation_id, *_args, **_kwargs):
        captured["attachments"] = conversation_id
        return "", []

    class _FakeService:
        async def process_message(self, **kwargs):
            captured["runtime"] = kwargs["conversation_id"]
            captured["request_id"] = kwargs["request_id"]
            return ChatResponse(message_id="m1", content="ok", sources=[], model_used="fake")

    monkeypatch.setattr(internal_agent, "process_uploaded_attachments", attachments)
    monkeypatch.setattr(internal_agent, "get_agent_service", lambda *_args, **_kwargs: _FakeService())
    monkeypatch.setattr(internal_agent, "_load_allowed_skill_packages", lambda _req: None)

    result = asyncio.run(internal_agent.chat(_internal_request()))

    assert captured["attachments"] == captured["runtime"] == result["conversation_id"]
    assert captured["request_id"] == "req-1"
    assert result["conversation_id"].startswith("conv_")


def test_stream_internal_api_uses_the_same_derived_scope_for_attachments_and_runtime(monkeypatch):
    captured = {}

    def attachments(conversation_id, *_args, **_kwargs):
        captured["attachments"] = conversation_id
        return "", []

    class _FakeService:
        async def stream_message(self, **kwargs):
            captured["runtime"] = kwargs["conversation_id"]
            captured["request_id"] = kwargs["request_id"]
            yield {"event": "content", "data": {"text": "ok"}}
            yield {"event": "done", "data": {"conversation_id": kwargs["conversation_id"]}}

    class _ConnectedRequest:
        async def is_disconnected(self):
            return False

    monkeypatch.setattr(internal_agent, "process_uploaded_attachments", attachments)
    monkeypatch.setattr(internal_agent, "get_agent_service", lambda *_args, **_kwargs: _FakeService())
    monkeypatch.setattr(internal_agent, "_load_allowed_skill_packages", lambda _req: None)

    async def run():
        response = await internal_agent.chat_stream(_internal_request(), _ConnectedRequest())
        return [chunk async for chunk in response.body_iterator]

    chunks = asyncio.run(run())

    assert chunks[-1].startswith("event: done")
    assert captured["attachments"] == captured["runtime"]
    assert captured["request_id"] == "req-1"
    assert captured["runtime"].startswith("conv_")


@pytest.mark.asyncio
async def test_success_finalization_requires_atomic_history_primitive():
    service = _service()

    class _History:
        def add_message(self, **_kwargs):
            return {"id": "message-1"}

        def complete_turn(self, **_kwargs):
            return None

    service.history_service = _History()

    with pytest.raises(RequiredTurnPersistenceError, match="atomic_turn_completion"):
        await service.persist_turn_completion(
            conversation_id="conv-1",
            current_turn_id="turn-1",
            final_content="grounded answer",
            status="completed",
        )


@pytest.mark.asyncio
async def test_success_finalization_returns_only_a_persisted_message_id():
    service = _service()
    captured = {}

    class _History:
        def persist_turn_completion_atomic(self, **kwargs):
            captured.update(kwargs)
            return {
                "message": {
                    "id": kwargs["message_id"],
                    "metadata": {
                        "schema_version": "agent-message-audit.v1",
                        "message_id": kwargs["message_id"],
                        "turn_id": kwargs["turn_id"],
                        "conversation_id": kwargs["conversation_id"],
                        "request_id": kwargs["request_id"],
                        "state_revision": kwargs["state_revision"],
                    },
                    "action_receipts": kwargs["action_receipts"],
                    "research_output": kwargs["research_output"],
                },
                "turn": {"turn_id": kwargs["turn_id"], "status": kwargs["status"]},
            }

    service.history_service = _History()

    message_id = await service.persist_turn_completion(
        conversation_id="conv-1",
        current_turn_id="turn-1",
        final_content="grounded answer",
        status="completed",
        message_id="message-1",
        request_id="req-1",
        state_revision="desktop-state-1",
        action_receipts=[{"receipt_id": "receipt-1", "terminal": True}],
        research_output={
            "schema_version": "research-output.v1",
            "output_id": "output-1",
            "message_id": "message-1",
            "request_id": "req-1",
            "conversation_id": "conv-1",
            "state_revision": "desktop-state-1",
        },
    )

    assert message_id == "message-1"
    assert captured["action_receipts"] == [{"receipt_id": "receipt-1", "terminal": True}]
    assert captured["research_output"]["output_id"] == "output-1"
    assert captured["request_id"] == "req-1"
    assert captured["state_revision"] == "desktop-state-1"


@pytest.mark.asyncio
@pytest.mark.parametrize("corruption", ["receipt", "research_output"])
async def test_success_finalization_rejects_same_id_but_mutated_evidence_ack(corruption):
    service = _service()

    class _History:
        def persist_turn_completion_atomic(self, **kwargs):
            receipts = kwargs["action_receipts"]
            research_output = kwargs["research_output"]
            if corruption == "receipt":
                receipts = [{**receipts[0], "status": "forged"}]
            else:
                research_output = {**research_output, "summary": "mutated after commit"}
            return {
                "message": {
                    "id": kwargs["message_id"],
                    "metadata": {
                        "schema_version": "agent-message-audit.v1",
                        "message_id": kwargs["message_id"],
                        "turn_id": kwargs["turn_id"],
                        "conversation_id": kwargs["conversation_id"],
                        "request_id": kwargs["request_id"],
                        "state_revision": kwargs["state_revision"],
                    },
                    "action_receipts": receipts,
                    "research_output": research_output,
                },
                "turn": {"turn_id": kwargs["turn_id"], "status": kwargs["status"]},
            }

    service.history_service = _History()
    with pytest.raises(RequiredTurnPersistenceError, match="evidence_ack_invalid"):
        await service.persist_turn_completion(
            conversation_id="conv-1",
            current_turn_id="turn-1",
            final_content="grounded answer",
            status="completed",
            message_id="message-1",
            request_id="req-1",
            state_revision="desktop-state-1",
            action_receipts=[{"receipt_id": "receipt-1", "terminal": True}],
            research_output={
                "schema_version": "research-output.v1",
                "output_id": "output-1",
                "message_id": "message-1",
                "request_id": "req-1",
                "conversation_id": "conv-1",
                "state_revision": "desktop-state-1",
            },
        )
