"""Offline tests for the streaming chat transport (no network).

Validates QianwenAIService.chat_stream's SSE delta parsing + final-response
assembly against fake DashScope OpenAI-compatible chunks, and the base-class
non-streaming fallback. Real-endpoint validation is a separate manual step.
"""
import asyncio
from types import SimpleNamespace

from runtime.services.ai_service import AIService, QianwenAIService, ZhipuAIService


class _FakeStreamResponse:
    def __init__(self, lines):
        self._lines = lines

    def raise_for_status(self):
        return None

    async def aiter_lines(self):
        for line in self._lines:
            yield line


class _FakeStreamCtx:
    def __init__(self, lines):
        self._resp = _FakeStreamResponse(lines)

    async def __aenter__(self):
        return self._resp

    async def __aexit__(self, *exc):
        return False


class _FakeClient:
    def __init__(self, lines):
        self._lines = lines
        self.calls = []

    def stream(self, method, url, json=None, headers=None):
        self.calls.append((method, url, json))
        return _FakeStreamCtx(self._lines)


def _make_service(cls, model, lines):
    svc = object.__new__(cls)
    svc.config = SimpleNamespace(model=model, temperature=0.7, max_tokens=2048)
    svc.api_base = "http://example/chat/completions"
    svc.headers = {}
    svc._hard_truncate_messages = lambda messages: messages
    svc.client = _FakeClient(lines)
    return svc


def _make_qwen(lines):
    return _make_service(QianwenAIService, "qwen3.5-plus", lines)


async def _collect(agen):
    return [event async for event in agen]


def test_qwen_chat_stream_yields_content_deltas_and_assembles_final():
    lines = [
        'data: {"choices":[{"delta":{"content":"Hel"}}]}',
        'data: {"choices":[{"delta":{"content":"lo"}}]}',
        'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}',
        ': keep-alive comment line ignored',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],'
        '"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}',
        'data: [DONE]',
    ]
    svc = _make_qwen(lines)
    events = asyncio.run(_collect(svc.chat_stream([{"role": "user", "content": "hi"}])))

    content_deltas = [e["text"] for e in events if e["type"] == "content"]
    reasoning_deltas = [e["text"] for e in events if e["type"] == "reasoning"]
    finals = [e for e in events if e["type"] == "final"]

    assert content_deltas == ["Hel", "lo"]
    assert reasoning_deltas == ["think"]
    assert len(finals) == 1
    resp = finals[0]["response"]
    assert resp["content"] == "Hello"
    assert resp["reasoning_content"] == "think"
    assert resp["finish_reason"] == "stop"
    assert resp["tokens_used"] == 7
    assert resp["tool_calls"] is None
    assert resp["model_used"] == "qwen3.5-plus"
    # streaming request actually set stream=True
    assert svc.client.calls[0][2]["stream"] is True


def test_qwen_chat_stream_accumulates_tool_call_across_deltas():
    lines = [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1",'
        '"type":"function","function":{"name":"detect","arguments":"{\\"a\\":"}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,'
        '"function":{"arguments":"1}"}}]}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        'data: [DONE]',
    ]
    svc = _make_qwen(lines)
    events = asyncio.run(_collect(svc.chat_stream([{"role": "user", "content": "go"}])))

    # no user-visible content was streamed for a pure tool-call turn
    assert [e for e in events if e["type"] == "content"] == []
    resp = [e for e in events if e["type"] == "final"][0]["response"]
    assert resp["tool_calls"] == [
        {
            "id": "call_1",
            "type": "function",
            "function": {"name": "detect", "arguments": '{"a":1}'},
        }
    ]
    assert resp["tool_call_origin"] == "native"
    assert resp["finish_reason"] == "tool_calls"


def test_base_chat_stream_falls_back_to_non_streaming():
    class _StubService(AIService):
        def __init__(self):
            pass  # skip the heavy base __init__

        async def chat(self, messages, tools=None, max_retries=None, extra_body=None):
            return {"content": "full answer", "tool_calls": None, "model_used": "stub"}

        def get_available_models(self):
            return []

    svc = _StubService()
    events = asyncio.run(_collect(svc.chat_stream([{"role": "user", "content": "hi"}])))

    assert events[0] == {"type": "content", "text": "full answer"}
    assert events[-1]["type"] == "final"
    assert events[-1]["response"]["content"] == "full answer"


def test_zhipu_chat_stream_delegates_to_shared_streamer():
    # ZhipuAIService.chat_stream delegates to the same OpenAI-compatible base
    # streamer, so it parses identical SSE and assembles the same final shape.
    lines = [
        'data: {"choices":[{"delta":{"content":"你"}}]}',
        'data: {"choices":[{"delta":{"content":"好"}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
        'data: [DONE]',
    ]
    svc = _make_service(ZhipuAIService, "glm-5", lines)
    events = asyncio.run(_collect(svc.chat_stream([{"role": "user", "content": "hi"}])))

    assert [e["text"] for e in events if e["type"] == "content"] == ["你", "好"]
    final = [e for e in events if e["type"] == "final"][0]["response"]
    assert final["content"] == "你好"
    assert final["model_used"] == "glm-5"
    assert svc.client.calls[0][2]["stream"] is True
