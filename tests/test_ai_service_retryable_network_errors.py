import asyncio
import json

import httpx

from runtime.models.schemas import AIModelConfig
from runtime.services.ai_service import AIServiceFactory, DeepSeekAIService, QianwenAIService


def _service() -> QianwenAIService:
    return QianwenAIService(
        AIModelConfig(
            provider="qianwen",
            model="qwen3.5-plus",
            api_key="test-key",
            api_base="https://dashscope.aliyuncs.com/compatible-mode/v1",
        )
    )


def test_retryable_network_error_detects_tls_eof() -> None:
    service = _service()

    assert service._is_retryable_network_error(
        httpx.ReadError("TLS/SSL connection has been closed (EOF) (_ssl.c:1147)")
    )


def test_retryable_network_error_detects_remote_disconnect() -> None:
    service = _service()

    assert service._is_retryable_network_error(
        httpx.RemoteProtocolError("Server disconnected without sending a response.")
    )


def test_retryable_network_error_ignores_non_network_errors() -> None:
    service = _service()

    assert not service._is_retryable_network_error(ValueError("bad prompt"))


def test_factory_supports_deepseek_provider_default_base() -> None:
    service = AIServiceFactory.create_service(
        AIModelConfig(
            provider="deepseek",
            model="deepseek-v4-flash",
            api_key="test-key",
        )
    )

    assert isinstance(service, DeepSeekAIService)
    assert service.api_base == "https://api.deepseek.com/chat/completions"
    assert "deepseek" in AIServiceFactory.get_supported_providers()


class _FakeResponse:
    status_code = 200
    text = "{}"

    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload

    def raise_for_status(self):
        return None


def _tool_call_code_block() -> str:
    return "```json\n" + json.dumps({
        "tool_calls": [
            {
                "type": "function",
                "function": {"name": "known_tool", "arguments": "{}"},
            }
        ]
    }) + "\n```"


def test_qianwen_does_not_execute_text_tool_call_fallback_by_default(monkeypatch):
    service = _service()
    monkeypatch.delenv("IEEG_AGENT_ALLOW_TEXT_TOOL_CALL_FALLBACK", raising=False)

    async def fake_consume(_estimated_tokens):
        return None

    async def fake_post(_url, json=None, headers=None):
        return _FakeResponse({
            "choices": [
                {
                    "message": {"content": _tool_call_code_block()},
                    "finish_reason": "stop",
                }
            ],
            "usage": {"total_tokens": 1},
        })

    monkeypatch.setattr(service, "_consume_tokens", fake_consume)
    monkeypatch.setattr(service.client, "post", fake_post)

    response = asyncio.run(
        service.chat(
            [{"role": "user", "content": "call a tool"}],
            tools=[{"type": "function", "function": {"name": "known_tool", "parameters": {"type": "object"}}}],
            max_retries=0,
        )
    )

    assert response["tool_calls"] is None
    assert response["tool_call_origin"] is None


def test_qianwen_text_tool_call_fallback_requires_compat_flag(monkeypatch):
    service = _service()
    monkeypatch.setenv("IEEG_AGENT_ALLOW_TEXT_TOOL_CALL_FALLBACK", "1")

    async def fake_consume(_estimated_tokens):
        return None

    async def fake_post(_url, json=None, headers=None):
        return _FakeResponse({
            "choices": [
                {
                    "message": {"content": _tool_call_code_block()},
                    "finish_reason": "stop",
                }
            ],
            "usage": {"total_tokens": 1},
        })

    monkeypatch.setattr(service, "_consume_tokens", fake_consume)
    monkeypatch.setattr(service.client, "post", fake_post)

    response = asyncio.run(
        service.chat(
            [{"role": "user", "content": "call a tool"}],
            tools=[{"type": "function", "function": {"name": "known_tool", "parameters": {"type": "object"}}}],
            max_retries=0,
        )
    )

    assert response["tool_call_origin"] == "text_json_fallback"
    assert response["tool_calls"][0]["id"].startswith("call_text_")
    assert response["tool_calls"][0]["function"]["name"] == "known_tool"
