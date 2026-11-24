"""Unit tests for AIService._hard_truncate_messages tool-call pairing.

The hard-truncation path fires when a turn's payload exceeds MAX_INPUT_CHARS. It
drops the oldest messages to fit. The invariant it MUST preserve: every remaining
`role:"tool"` message stays paired with the `assistant` message whose `tool_calls`
it answers. Dropping an assistant-with-tool_calls but leaving its tool responses
yields an orphan tool message that OpenAI-compatible endpoints (Qwen/Zhipu) reject
with a non-retryable HTTP 400 — hard-failing the whole turn.
"""
from types import SimpleNamespace

from runtime.services.ai_service import AIService


# _hard_truncate_messages uses no instance state beyond the static _message_char_len
# helper, so exercise it with a dummy self that carries that helper.
_truncate = AIService._hard_truncate_messages.__get__(
    SimpleNamespace(_message_char_len=AIService._message_char_len)
)
_msg_len = AIService._message_char_len


def _assistant_tool_call(call_id: str, big: int = 0) -> dict:
    return {
        "role": "assistant",
        "content": "x" * big,
        "tool_calls": [{
            "id": call_id,
            "type": "function",
            "function": {"name": "do_thing", "arguments": "{}"},
        }],
    }


def _tool_result(call_id: str, big: int = 0) -> dict:
    return {"role": "tool", "tool_call_id": call_id, "content": "y" * big}


def _assert_no_orphan_tool(messages):
    """Every tool message must be immediately preceded by an assistant with tool_calls."""
    for i, m in enumerate(messages):
        if m.get("role") == "tool":
            assert i > 0, f"tool message at index 0 has no parent: {messages}"
            prev = messages[i - 1]
            assert prev.get("role") == "assistant" and prev.get("tool_calls"), (
                f"orphan tool message at index {i}: {messages}"
            )


def test_dropping_assistant_also_drops_its_tool_response():
    messages = [
        {"role": "system", "content": "sys"},
        _assistant_tool_call("call_a", big=5000),
        _tool_result("call_a", big=5000),
        {"role": "user", "content": "u1"},
        {"role": "assistant", "content": "final answer"},
        {"role": "user", "content": "u2"},
    ]
    out = _truncate(messages, max_chars=200)
    _assert_no_orphan_tool(out)
    # The oldest assistant+tool pair should be gone together, not half-removed.
    assert not any(m.get("tool_calls") for m in out)
    assert not any(m.get("role") == "tool" for m in out)


def test_system_message_is_preserved():
    messages = [
        {"role": "system", "content": "keep me"},
        _assistant_tool_call("call_a", big=8000),
        _tool_result("call_a", big=8000),
        {"role": "user", "content": "u"},
    ]
    out = _truncate(messages, max_chars=100)
    assert out[0]["role"] == "system"
    assert out[0]["content"] == "keep me"
    _assert_no_orphan_tool(out)


def test_leading_orphan_tool_in_input_is_removed_first():
    # A pre-existing leading orphan tool (parent already gone) must not survive.
    messages = [
        {"role": "system", "content": "sys"},
        _tool_result("stale", big=6000),
        {"role": "user", "content": "u1"},
        {"role": "user", "content": "u2"},
        {"role": "user", "content": "u3"},
    ]
    out = _truncate(messages, max_chars=200)
    _assert_no_orphan_tool(out)


def test_char_len_counts_tool_calls_payload():
    # A message whose body is entirely in tool_calls must not measure as 0 chars.
    msg = {"role": "assistant", "content": "", "tool_calls": [
        {"id": "c1", "type": "function", "function": {"name": "f", "arguments": '{"k": "vvvvvvvvvv"}'}},
    ]}
    assert _msg_len(msg) > 20


def test_under_limit_returns_unchanged_identity():
    messages = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "short"},
    ]
    out = _truncate(messages, max_chars=100000)
    assert out is messages  # no copy when nothing to do


def test_multiple_pairs_truncated_without_orphans():
    messages = [{"role": "system", "content": "sys"}]
    for i in range(6):
        messages.append(_assistant_tool_call(f"call_{i}", big=2000))
        messages.append(_tool_result(f"call_{i}", big=2000))
    messages.append({"role": "user", "content": "latest"})
    out = _truncate(messages, max_chars=6000)
    _assert_no_orphan_tool(out)
    # Whatever survived must still be a valid, shrunken transcript with the system kept.
    assert out[0]["role"] == "system"
    assert len(out) < len(messages)
