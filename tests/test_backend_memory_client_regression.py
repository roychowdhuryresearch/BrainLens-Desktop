"""Product regression tests for the agent-side backend memory client.

These tests keep the runtime memory bridge deterministic without a live backend:
headers, cache keys, write invalidation, HTTP error handling, and singleton
lifecycle are all agent-facing contracts for future agent work.
"""

from __future__ import annotations

import httpx
import pytest

from runtime.services import backend_memory_client as module
from runtime.services.backend_memory_client import (
    BackendMemoryClient,
    BackendMemoryError,
    DurableMemoryPromptContext,
    MemoryAccess,
    MemoryPromptItem,
    _RuntimeCache,
)


@pytest.fixture(autouse=True)
def configured_backend_token(monkeypatch):
    monkeypatch.setenv("AGENT_BACKEND_TOKEN", "test-only-memory-token")


class _FakeResponse:
    def __init__(self, status_code=200, payload=None, text="ok", json_error=None):
        self.status_code = status_code
        self._payload = payload if payload is not None else {}
        self.text = text
        self._json_error = json_error

    def json(self):
        if self._json_error:
            raise self._json_error
        return self._payload


class _FakeHTTP:
    def __init__(self, responses):
        self._responses = list(responses)
        self.requests = []
        self.closed = False

    async def request(self, method, path, *, headers=None, json=None):
        self.requests.append(
            {
                "method": method,
                "path": path,
                "headers": dict(headers or {}),
                "json": json,
            }
        )
        if not self._responses:
            raise AssertionError(f"unexpected request: {method} {path}")
        item = self._responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    async def aclose(self):
        self.closed = True


async def _client_with_http(fake_http: _FakeHTTP) -> BackendMemoryClient:
    client = BackendMemoryClient()
    await client._http.aclose()
    client._http = fake_http
    return client


def _memory_record_payload(**overrides):
    base = {
        "id": 7,
        "scope_level": "user",
        "scope_id": "u-1",
        "user_id": "u-1",
        "memory_kind": "preference",
        "memory_type": "text",
        "namespace": "profile",
        "key": "language",
        "title": "Language",
        "value": "Chinese",
        "tags": ["ui"],
        "retrieval_targets": ["bootstrap"],
        "status": "active",
    }
    base.update(overrides)
    return base


@pytest.mark.asyncio
async def test_memory_access_headers_include_identity_without_empty_fields():
    access = MemoryAccess(
        user_id="u-1",
        tenant_id="tenant-a",
        team_ids=["team-1", "team-2"],
        permissions=["memory:read", "memory:write"],
    )

    assert access.to_headers() == {
        "X-User-Id": "u-1",
        "X-Tenant-Id": "tenant-a",
        "X-Team-Ids": "team-1,team-2",
        "X-Permissions": "memory:read,memory:write",
    }

    assert MemoryAccess(user_id="u-2").to_headers() == {"X-User-Id": "u-2"}


@pytest.mark.asyncio
async def test_runtime_cache_expires_and_invalidates_per_user(monkeypatch):
    now = 1000.0
    monkeypatch.setattr(module.time, "time", lambda: now)
    cache = _RuntimeCache(ttl=5.0)
    ctx = DurableMemoryPromptContext(
        user_preferences=[
            MemoryPromptItem(
                id=1,
                scope_level="user",
                memory_kind="preference",
                key="k",
            )
        ]
    )

    await cache.set(("u-1", "bootstrap", 4), ctx)
    assert await cache.get(("u-1", "bootstrap", 4)) is ctx

    now = 1006.0
    assert await cache.get(("u-1", "bootstrap", 4)) is None

    now = 1010.0
    await cache.set(("u-1", "bootstrap", 4), ctx)
    await cache.set(("u-2", "bootstrap", 4), ctx)
    await cache.invalidate("u-1")
    assert await cache.get(("u-1", "bootstrap", 4)) is None
    assert await cache.get(("u-2", "bootstrap", 4)) is ctx


@pytest.mark.asyncio
async def test_runtime_context_posts_identity_headers_and_reuses_cache():
    fake_http = _FakeHTTP(
        [
            _FakeResponse(
                payload={
                    "user_preferences": [
                        {
                            "id": 1,
                            "scope_level": "user",
                            "memory_kind": "preference",
                            "key": "tone",
                            "summary": "concise",
                        }
                    ],
                    "team_memories": [],
                    "company_memories": [],
                    "user_context_memories": [],
                }
            )
        ]
    )
    client = await _client_with_http(fake_http)

    access = MemoryAccess(user_id="u-1", tenant_id="tenant", team_ids=["team"])
    first = await client.get_runtime_context(
        access,
        target="chat",
        user_message="hello",
        limit_per_bucket=2,
    )
    second = await client.get_runtime_context(
        access,
        target="chat",
        user_message="different message should still hit cache",
        limit_per_bucket=2,
    )

    assert first is second
    assert first.user_preferences[0].key == "tone"
    assert len(fake_http.requests) == 1
    request = fake_http.requests[0]
    assert request["method"] == "POST"
    assert request["path"] == "/internal/api/memories/runtime-context"
    assert request["headers"]["Authorization"] == "Bearer test-only-memory-token"
    assert request["headers"]["X-User-Id"] == "u-1"
    assert request["headers"]["X-Tenant-Id"] == "tenant"
    assert request["headers"]["X-Team-Ids"] == "team"
    assert request["json"]["user_message"] == "hello"
    assert request["json"]["limit_per_bucket"] == 2


@pytest.mark.asyncio
async def test_missing_backend_token_prevents_requests(monkeypatch):
    monkeypatch.delenv("AGENT_BACKEND_TOKEN")
    transport = _FakeHTTP([])
    client = await _client_with_http(transport)
    with pytest.raises(BackendMemoryError, match="AGENT_BACKEND_TOKEN"):
        await client.get(MemoryAccess(user_id="u-1"), 1)
    assert transport.requests == []


@pytest.mark.asyncio
async def test_runtime_context_degrades_to_empty_context_on_backend_error():
    fake_http = _FakeHTTP([_FakeResponse(status_code=503, text="backend down")])
    client = await _client_with_http(fake_http)

    context = await client.get_runtime_context(MemoryAccess(user_id="u-1"))

    assert context.is_empty()


@pytest.mark.asyncio
async def test_crud_methods_parse_records_and_invalidate_cached_context():
    fake_http = _FakeHTTP(
        [
            _FakeResponse(payload=_memory_record_payload(id=1, key="created")),
            _FakeResponse(payload=_memory_record_payload(id=2, key="upserted")),
            _FakeResponse(payload=_memory_record_payload(id=3, key="patched")),
            _FakeResponse(payload={"deleted": True}),
        ]
    )
    client = await _client_with_http(fake_http)
    access = MemoryAccess(user_id="u-1")
    cached = DurableMemoryPromptContext(
        user_preferences=[
            MemoryPromptItem(
                id=1,
                scope_level="user",
                memory_kind="preference",
                key="cached",
            )
        ]
    )
    await client._cache.set(("u-1", "bootstrap", 4), cached)

    created = await client.create(access, {"key": "created"})
    assert created.id == 1
    assert await client._cache.get(("u-1", "bootstrap", 4)) is None

    await client._cache.set(("u-1", "bootstrap", 4), cached)
    upserted = await client.upsert(access, {"key": "upserted"})
    assert upserted.key == "upserted"
    assert await client._cache.get(("u-1", "bootstrap", 4)) is None

    await client._cache.set(("u-1", "bootstrap", 4), cached)
    patched = await client.update(access, 3, {"title": "new"})
    assert patched.id == 3
    assert await client._cache.get(("u-1", "bootstrap", 4)) is None

    await client._cache.set(("u-1", "bootstrap", 4), cached)
    assert await client.delete(access, 3) is True
    assert await client._cache.get(("u-1", "bootstrap", 4)) is None

    assert [r["method"] for r in fake_http.requests] == ["POST", "POST", "PATCH", "DELETE"]
    assert fake_http.requests[1]["path"] == "/internal/api/memories/records/upsert"
    assert fake_http.requests[2]["json"] == {"title": "new"}


@pytest.mark.asyncio
async def test_get_and_delete_treat_404_as_absent_but_raise_other_errors():
    access = MemoryAccess(user_id="u-1")
    fake_http = _FakeHTTP(
        [
            _FakeResponse(status_code=404, text="missing"),
            _FakeResponse(status_code=404, text="missing"),
            _FakeResponse(status_code=500, text="bad"),
        ]
    )
    client = await _client_with_http(fake_http)

    assert await client.get(access, 404) is None
    assert await client.delete(access, 404) is False
    with pytest.raises(BackendMemoryError, match="500 calling GET"):
        await client.get(access, 500)


@pytest.mark.asyncio
async def test_low_level_request_wraps_network_timeout_and_bad_json():
    access = MemoryAccess(user_id="u-1")
    timeout_request = httpx.Request("GET", "https://backend.example.invalid/test")
    timeout = httpx.ReadTimeout("slow", request=timeout_request)
    client = await _client_with_http(_FakeHTTP([timeout]))

    with pytest.raises(BackendMemoryError, match="timeout calling GET"):
        await client._get_json("/timeout", access)

    bad_json = await _client_with_http(
        _FakeHTTP([_FakeResponse(json_error=ValueError("not json"))])
    )
    with pytest.raises(BackendMemoryError, match="invalid json"):
        await bad_json._get_json("/bad-json", access)


@pytest.mark.asyncio
async def test_singleton_lifecycle_closes_previous_client(monkeypatch):
    fake_client = await _client_with_http(_FakeHTTP([]))
    monkeypatch.setattr(module, "_instance", fake_client)

    assert await module.get_client() is fake_client
    await module.close_client()

    assert fake_client._http.closed is True
    assert module._instance is None
