"""HTTP-layer audit tests for ``app/api/internal_*.py`` files.

Subagent-generated audit (2026-05-02) found 18 endpoints with no test
coverage and 20 with partial coverage. This file pins the highest-value
HTTP-layer contracts not already tested elsewhere:

  - internal_observability: both endpoints (auth, 404, response shape).
  - internal_history: pagination, title update, delete cascade signal,
    get_or_create idempotency, messages limit/offset, turns limit param,
    full_context endpoint.
Routing details and request body validation that depend on real DB / pgvector
are intentionally NOT covered here (that's the e2e suite's job).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

AGENT_ROOT = Path(__file__).resolve().parent.parent
if str(AGENT_ROOT) not in sys.path:
    sys.path.insert(0, str(AGENT_ROOT))


_TOKEN = "test-agent-service-token"
_HEADERS = {"Authorization": f"Bearer {_TOKEN}"}


# ─────────────────────────────────────────────────────────────────────────────
# § internal_observability
# ─────────────────────────────────────────────────────────────────────────────


class _StubObservabilityService:
    def __init__(self):
        self.list_calls = []
        self._turns = {
            "turn-known": {"turn_id": "turn-known", "status": "completed"},
        }

    def list_turns(self, *, limit, offset, sort_by, sort_order):
        self.list_calls.append({
            "limit": limit, "offset": offset,
            "sort_by": sort_by, "sort_order": sort_order,
        })
        return {"turns": [{"turn_id": "t1"}], "total": 1}

    def get_turn_detail(self, turn_id):
        return self._turns.get(turn_id)


def _obs_client(monkeypatch):
    monkeypatch.delenv("PYHFO_AGENT_SERVICE_TOKEN", raising=False)
    monkeypatch.setenv("AGENT_SERVICE_TOKEN", _TOKEN)
    from runtime.api.internal_observability import router

    app = FastAPI()
    app.include_router(router)
    stub = _StubObservabilityService()
    monkeypatch.setattr(
        "runtime.api.internal_observability.get_agent_observability_service",
        lambda: stub,
    )
    return TestClient(app), stub


class TestObservabilityListTurns:
    def test_unconfigured_auth_disables_internal_requests(self, monkeypatch):
        client, stub = _obs_client(monkeypatch)
        monkeypatch.delenv("AGENT_SERVICE_TOKEN")
        resp = client.get("/internal/agent/v1/observability/turns", headers=_HEADERS)
        assert resp.status_code == 503
        assert not stub.list_calls

    def test_requires_auth_token(self, monkeypatch):
        client, _ = _obs_client(monkeypatch)
        # No Authorization header → 401.
        resp = client.get("/internal/agent/v1/observability/turns")
        assert resp.status_code == 401

    def test_default_query_params_passed_through(self, monkeypatch):
        client, stub = _obs_client(monkeypatch)
        resp = client.get(
            "/internal/agent/v1/observability/turns", headers=_HEADERS,
        )
        assert resp.status_code == 200
        assert stub.list_calls[-1] == {
            "limit": 20, "offset": 0,
            "sort_by": "created_at", "sort_order": "desc",
        }

    def test_query_params_override(self, monkeypatch):
        client, stub = _obs_client(monkeypatch)
        resp = client.get(
            "/internal/agent/v1/observability/turns",
            params={
                "limit": 50, "offset": 100,
                "sort_by": "duration_ms", "sort_order": "asc",
            },
            headers=_HEADERS,
        )
        assert resp.status_code == 200
        assert stub.list_calls[-1] == {
            "limit": 50, "offset": 100,
            "sort_by": "duration_ms", "sort_order": "asc",
        }

    def test_response_shape(self, monkeypatch):
        client, _ = _obs_client(monkeypatch)
        resp = client.get(
            "/internal/agent/v1/observability/turns", headers=_HEADERS,
        )
        body = resp.json()
        assert "turns" in body and "total" in body


class TestObservabilityGetTurnDetail:
    def test_returns_404_when_missing(self, monkeypatch):
        client, _ = _obs_client(monkeypatch)
        resp = client.get(
            "/internal/agent/v1/observability/turns/ghost", headers=_HEADERS,
        )
        assert resp.status_code == 404
        assert resp.json()["detail"] == "Turn not found"

    def test_returns_payload_when_present(self, monkeypatch):
        client, _ = _obs_client(monkeypatch)
        resp = client.get(
            "/internal/agent/v1/observability/turns/turn-known",
            headers=_HEADERS,
        )
        assert resp.status_code == 200
        assert resp.json()["turn_id"] == "turn-known"


# ─────────────────────────────────────────────────────────────────────────────
# § internal_history — gaps not covered by test_internal_history_api.py
# ─────────────────────────────────────────────────────────────────────────────


class _StubHistoryService:
    def __init__(self):
        self.calls = []
        self._known = {"conv-1": {"conversation_id": "conv-1", "user_id": "u"}}

    def get_or_create_conversation(self, **kwargs):
        self.calls.append(("get_or_create", kwargs))
        return {"conversation_id": kwargs["conversation_id"], "user_id": kwargs["user_id"]}

    def get_conversation(self, conversation_id):
        return self._known.get(conversation_id)

    async def delete_conversation(self, conversation_id):
        self.calls.append(("delete", conversation_id))

    def update_conversation_title(self, conversation_id, title):
        if conversation_id not in self._known:
            return None
        self._known[conversation_id]["title"] = title
        return self._known[conversation_id]

    def list_user_conversations(self, user_id, limit, offset):
        self.calls.append(("list", user_id, limit, offset))
        return [{"conversation_id": "c1"}]

    def get_conversation_messages(self, conversation_id, limit, offset):
        self.calls.append(("messages", conversation_id, limit, offset))
        return [{"message_id": "m1"}]

    def get_recent_messages(self, conversation_id, limit):
        self.calls.append(("recent", conversation_id, limit))
        return [{"message_id": "m1"}]

    def get_conversation_turns(self, conversation_id):
        return [{"turn_id": f"t{i}"} for i in range(10)]

    def get_full_context(self, conversation_id):
        return {
            "conversation": {"conversation_id": conversation_id},
            "messages": [{"role": "user", "content": "hi"}],
            "summary": None,
            "turns": [],
        }


def _history_client(monkeypatch):
    monkeypatch.delenv("PYHFO_AGENT_SERVICE_TOKEN", raising=False)
    monkeypatch.setenv("AGENT_SERVICE_TOKEN", _TOKEN)
    from runtime.api.internal_history import router

    stub = _StubHistoryService()
    app = FastAPI()
    app.include_router(router)
    monkeypatch.setattr(
        "runtime.api.internal_history.get_agent_history_service", lambda: stub,
    )
    return TestClient(app), stub


class TestHistoryGetOrCreate:
    def test_passes_explicit_conversation_id_through(self, monkeypatch):
        client, stub = _history_client(monkeypatch)
        resp = client.post(
            "/internal/agent/v1/conversations/get-or-create",
            json={"conversation_id": "c-explicit", "user_id": "u"},
            headers=_HEADERS,
        )
        assert resp.status_code == 200
        kind, kwargs = stub.calls[-1]
        assert kind == "get_or_create"
        assert kwargs["conversation_id"] == "c-explicit"
        # Defaults: source=web, external_conversation_id="" (None coerced).
        assert kwargs["source"] == "web"
        assert kwargs["external_conversation_id"] == ""


class TestHistoryUpdateTitle:
    def test_returns_404_for_unknown_conversation(self, monkeypatch):
        client, _ = _history_client(monkeypatch)
        resp = client.put(
            "/internal/agent/v1/conversations/title",
            json={"conversation_id": "missing", "title": "x"},
            headers=_HEADERS,
        )
        assert resp.status_code == 404

    def test_updates_existing_conversation(self, monkeypatch):
        client, _ = _history_client(monkeypatch)
        resp = client.put(
            "/internal/agent/v1/conversations/title",
            json={"conversation_id": "conv-1", "title": "renamed"},
            headers=_HEADERS,
        )
        assert resp.status_code == 200
        assert resp.json()["title"] == "renamed"


class TestHistoryDelete:
    def test_returns_404_when_unknown(self, monkeypatch):
        client, _ = _history_client(monkeypatch)
        resp = client.delete(
            "/internal/agent/v1/conversations/missing", headers=_HEADERS,
        )
        assert resp.status_code == 404

    def test_returns_success_when_deleted(self, monkeypatch):
        client, stub = _history_client(monkeypatch)
        resp = client.delete(
            "/internal/agent/v1/conversations/conv-1", headers=_HEADERS,
        )
        assert resp.status_code == 200
        assert resp.json() == {"success": True}
        assert ("delete", "conv-1") in stub.calls


class TestHistoryListPaginationParams:
    def test_user_conversations_default_limit_offset(self, monkeypatch):
        client, stub = _history_client(monkeypatch)
        client.get(
            "/internal/agent/v1/users/u/conversations", headers=_HEADERS,
        )
        # Defaults: limit=20, offset=0.
        assert stub.calls[-1] == ("list", "u", 20, 0)

    def test_user_conversations_explicit_pagination(self, monkeypatch):
        client, stub = _history_client(monkeypatch)
        client.get(
            "/internal/agent/v1/users/u/conversations",
            params={"limit": 5, "offset": 10},
            headers=_HEADERS,
        )
        assert stub.calls[-1] == ("list", "u", 5, 10)

    def test_user_conversations_response_shape(self, monkeypatch):
        client, _ = _history_client(monkeypatch)
        resp = client.get(
            "/internal/agent/v1/users/u/conversations", headers=_HEADERS,
        )
        body = resp.json()
        assert "conversations" in body and "total" in body
        # ``total`` is the length of the returned page (not the grand total
        # in the DB) — pin the current contract so callers don't assume
        # it's the global count.
        assert body["total"] == len(body["conversations"])

    def test_messages_default_pagination(self, monkeypatch):
        client, stub = _history_client(monkeypatch)
        client.get(
            "/internal/agent/v1/conversations/conv-1/messages",
            headers=_HEADERS,
        )
        assert stub.calls[-1] == ("messages", "conv-1", 100, 0)

    def test_recent_messages_default_count(self, monkeypatch):
        client, stub = _history_client(monkeypatch)
        client.get(
            "/internal/agent/v1/conversations/conv-1/messages/recent",
            headers=_HEADERS,
        )
        assert stub.calls[-1] == ("recent", "conv-1", 20)


class TestHistoryTurnsLimit:
    def test_default_limit_50(self, monkeypatch):
        client, _ = _history_client(monkeypatch)
        resp = client.get(
            "/internal/agent/v1/conversations/conv-1/turns", headers=_HEADERS,
        )
        # Stub returns 10 turns; default limit=50 → all 10 returned.
        assert len(resp.json()) == 10

    def test_explicit_limit_truncates(self, monkeypatch):
        client, _ = _history_client(monkeypatch)
        resp = client.get(
            "/internal/agent/v1/conversations/conv-1/turns",
            params={"limit": 3},
            headers=_HEADERS,
        )
        assert len(resp.json()) == 3


class TestHistoryFullContext:
    def test_full_context_response_shape(self, monkeypatch):
        client, _ = _history_client(monkeypatch)
        resp = client.get(
            "/internal/agent/v1/conversations/conv-1/context", headers=_HEADERS,
        )
        body = resp.json()
        assert resp.status_code == 200
        # The minimum stable keys downstream readers depend on.
        assert "conversation" in body
        assert "messages" in body
        assert "summary" in body
        assert "turns" in body
