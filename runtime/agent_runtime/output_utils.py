from typing import Any, Dict, Optional


def build_thinking_chat_kwargs(ai_service: Any) -> Dict[str, Any]:
    """Chat kwargs that disable a model's chain-of-thought ("thinking") trace.

    Reasoning models (qwen3.5-plus, GLM-4.5/4.6/5) emit a verbose ``reasoning_content``
    trace by default, which multiplies per-call latency — every tool-calling
    iteration first generates a full CoT before the answer/tool call, then we spend
    another LLM call compressing it for display. For a tool-calling ReAct loop the
    tool selection *is* the reasoning, so we turn thinking off. Provider-specific
    knobs (both validated against the live endpoints):
      - qianwen → ``enable_thinking: False`` (skipped for qwq / ``*-thinking`` models)
      - zhipu   → ``thinking: {"type": "disabled"}`` (glm-5 ~13s → ~2.6s first token)

    Single source of truth shared by the controller path and the main ReAct loop.
    """
    config = getattr(ai_service, "config", None)
    provider = str(getattr(config, "provider", "") or "").strip().lower()
    model = str(getattr(config, "model", "") or "").strip().lower()
    if provider == "qianwen":
        if "thinking" in model or model.startswith("qwq"):
            return {}
        return {"extra_body": {"enable_thinking": False}}
    if provider == "zhipu":
        return {"extra_body": {"thinking": {"type": "disabled"}}}
    return {}


def append_extra_message(content: str, extra_message: str) -> str:
    base = (content or "").strip()
    extra = (extra_message or "").strip()
    if not extra:
        return base
    if not base:
        return extra
    return f"{base}\n\n{extra}"


def sanitize_content(content: Optional[str], replacements: Optional[list[tuple[str, str]]] = None) -> str:
    if not content:
        return ""

    result = content
    for old, new in replacements or ():
        result = result.replace(old, new)
    return result
