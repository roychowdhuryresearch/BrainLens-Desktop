import pytest

from runtime.models.memory import MemoryAccessContext, RuntimeMemoryQuery
from runtime.services import memory_service as memory_service_module
from runtime.services.memory_service import MemoryService


def test_missing_backend_token_prevents_requests(monkeypatch):
    monkeypatch.delenv("AGENT_BACKEND_TOKEN", raising=False)

    def unexpected_http():
        pytest.fail("The HTTP client must not be invoked without a configured token")

    monkeypatch.setattr(memory_service_module, "_get_http", unexpected_http)
    with pytest.raises(memory_service_module.MemoryServiceError, match="AGENT_BACKEND_TOKEN"):
        memory_service_module._request_json("GET", "/internal/api/memories/records")


def test_runtime_context_cache_varies_with_user_message(monkeypatch):
    memory_service_module._RUNTIME_CACHE.clear()
    calls = []

    def fake_request_json(method, path, *, access=None, json_body=None):
        calls.append((method, path, json_body))
        message = (json_body or {}).get("user_message", "")
        return {
            "user_preferences": [],
            "user_context_memories": [
                {
                    "id": len(calls),
                    "scope_level": "user",
                    "memory_kind": "project_context",
                    "namespace": "project_context",
                    "key": f"ctx_{len(calls)}",
                    "title": "上下文",
                    "summary": message,
                    "value": {"text": message},
                    "tags": [],
                }
            ],
            "team_memories": [],
            "company_memories": [],
        }

    monkeypatch.setattr(memory_service_module, "_request_json", fake_request_json)

    access = MemoryAccessContext(user_id="u1")
    first = MemoryService.build_runtime_context(
        access_context=access,
        query=RuntimeMemoryQuery(user_message="记住以后用中文回答", target="bootstrap"),
    )
    second = MemoryService.build_runtime_context(
        access_context=access,
        query=RuntimeMemoryQuery(user_message="记住以后一步一步讲", target="bootstrap"),
    )

    assert len(calls) == 2
    assert first.user_context_memories[0].summary == "记住以后用中文回答"
    assert second.user_context_memories[0].summary == "记住以后一步一步讲"
