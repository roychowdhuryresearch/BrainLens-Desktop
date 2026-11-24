"""Per-provider thinking-disable chat kwargs (validated against live endpoints)."""
from types import SimpleNamespace

import pytest

from runtime.agent_runtime.output_utils import build_thinking_chat_kwargs


def _svc(provider, model):
    return SimpleNamespace(config=SimpleNamespace(provider=provider, model=model))


@pytest.mark.parametrize(
    "provider,model,expected",
    [
        # qianwen: enable_thinking:False, except dedicated reasoning models
        ("qianwen", "qwen3.5-plus", {"extra_body": {"enable_thinking": False}}),
        ("qianwen", "qwen3.5-flash", {"extra_body": {"enable_thinking": False}}),
        ("qianwen", "qwen-turbo", {"extra_body": {"enable_thinking": False}}),
        ("qianwen", "qwq-32b", {}),
        ("qianwen", "qwen3-thinking", {}),
        # zhipu: the GLM thinking knob (different param), applies to all glm models
        ("zhipu", "glm-5", {"extra_body": {"thinking": {"type": "disabled"}}}),
        ("zhipu", "glm-4.6V", {"extra_body": {"thinking": {"type": "disabled"}}}),
        # unknown provider: leave untouched
        ("openai", "gpt-4", {}),
        ("", "", {}),
    ],
)
def test_build_thinking_chat_kwargs(provider, model, expected):
    assert build_thinking_chat_kwargs(_svc(provider, model)) == expected
