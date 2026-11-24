"""MCP capability guide builder -- config-driven.

Each MCP server's ``guide`` field in config.yaml holds the usage description.
This module matches active tool names against server prefixes or exact guide
tool names and assembles the guide section for the system prompt.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Iterable, List, Optional

from runtime.prompts import render_prompt_file

_RUNTIME_PROMPTS_ROOT = Path(__file__).resolve().parents[1] / "prompts" / "runtime"


def _extract_tool_name(item: Any) -> str:
    """Extract a tool name from a tool dict or plain string."""
    if isinstance(item, str):
        return item.strip()
    if not isinstance(item, dict):
        return ""
    function_payload = item.get("function")
    if isinstance(function_payload, dict):
        function_name = str(function_payload.get("name") or "").strip()
        if function_name:
            return function_name
    return str(item.get("name") or "").strip()


def _collect_active_guides(
    tools_or_names: Iterable[Any],
    mcp_server_configs: Optional[List[Any]] = None,
) -> List[str]:
    """Return guide texts for MCP servers whose tools appear in *tools_or_names*.

    Each config object is expected to have attributes:
      - tool_prefix: str
      - guide_tool_names: list[str]
      - guide: Optional[str]
      - enabled: bool
    """
    if not mcp_server_configs:
        return []

    tool_names_lower: set[str] = set()
    for item in tools_or_names or []:
        name = _extract_tool_name(item).lower()
        if name:
            tool_names_lower.add(name)

    if not tool_names_lower:
        return []

    guide_texts: List[str] = []
    seen_guides: set[str] = set()
    active_prefixes: set[str] = set()
    for cfg in mcp_server_configs:
        prefix = str(getattr(cfg, "tool_prefix", "") or "").strip()
        exact_names = {
            str(name or "").strip().lower()
            for name in (getattr(cfg, "guide_tool_names", None) or [])
            if str(name or "").strip()
        }
        guide = str(getattr(cfg, "guide", "") or "").strip()
        enabled = getattr(cfg, "enabled", True)
        if not guide or not enabled:
            continue
        prefix_lower = prefix.lower()
        prefix_matched = bool(prefix_lower) and any(name.startswith(prefix_lower) for name in tool_names_lower)
        exact_matched = bool(exact_names & tool_names_lower)
        if prefix_matched or exact_matched:
            active_prefixes.add(prefix_lower)
            if guide not in seen_guides:
                seen_guides.add(guide)
                guide_texts.append(guide)

    return guide_texts


def _get_mcp_server_configs() -> list:
    """Lazy-load MCP server configs from config_manager (avoids circular import)."""
    try:
        from runtime.core.config import config_manager
        cfg = config_manager.config
        return list(cfg.mcp_servers or []) if cfg else []
    except Exception:
        return []


def build_mcp_capability_section(
    tools_or_names: Iterable[Any],
    mcp_server_configs: Optional[List[Any]] = None,
) -> str:
    """Build the MCP capability prompt section.

    Args:
        tools_or_names: Tool dicts or tool name strings currently available.
        mcp_server_configs: Optional list of MCPServerConfig objects.
            If ``None``, falls back to reading from ``config_manager``.
    """
    if mcp_server_configs is None:
        mcp_server_configs = _get_mcp_server_configs()

    guide_texts = _collect_active_guides(tools_or_names, mcp_server_configs)

    if not guide_texts:
        return ""

    mcp_guides_text = "\n\n".join(guide_texts)
    return render_prompt_file(
        _RUNTIME_PROMPTS_ROOT / "mcp_capability_section.md",
        mcp_guides_text=mcp_guides_text,
    ).strip()
