"""Regression: UI co-pilot MCP tools (emit_ui_command / get_ui_state / wait_for_ui_command / inspect_waveform) must
survive step-level tool filtering, exactly like vl_query.

The bug (found via a live-model smoke, not unit tests): a planned step carries a restrictive
`allowed_tool_names` that doesn't include the UI tools (skills/planner don't know about UI
control). `resolve_step_tools` filtered them out, so the per-step tool list handed to the LLM
(and to `tool_executor`'s `available` allow-list gate) lacked them. The model still tried to
call `emit_ui_command` (the system prompt teaches it), the gate rejected it as "unknown tool",
and `ui_commands` silently stayed empty — the co-pilot looked alive but never drove the UI.

These tests lock the structural fix deterministically (no model needed): the UI tools are
cross-cutting system capabilities and must pass through step filtering like vl_query.
"""
from runtime.agent_runtime.planning_policy import RuntimePlanningPolicy
from runtime.skills.models import ExecutionStep


def _tool(name):
    return {"type": "function", "function": {"name": name, "description": name, "parameters": {}}}


ALL_TOOLS = [
    _tool("emit_ui_command"),
    _tool("get_ui_state"),
    _tool("wait_for_ui_command"),
    _tool("inspect_waveform"),
    _tool("vl_query"),
    _tool("pyhfo_detect_events"),
    _tool("some_mcp_tool"),
]


def _names(tools):
    return {t["function"]["name"] for t in tools}


def test_ui_mcp_tools_survive_restrictive_step_allowlist():
    policy = RuntimePlanningPolicy()
    step = ExecutionStep(
        step_id="s1",
        skill_name="hfo",
        goal="detect",
        instructions="run detection",
        step_type="skill",
        allowed_tool_names=["pyhfo_detect_events"],  # restrictive: omits the UI tools
    )
    result = _names(policy.resolve_step_tools(step=step, all_tools=ALL_TOOLS, skill_context=None))
    assert "pyhfo_detect_events" in result  # the step's own allow-listed tool
    assert "emit_ui_command" in result      # preserved cross-cutting system capability
    assert "get_ui_state" in result         # preserved cross-cutting system capability
    assert "wait_for_ui_command" in result
    assert "inspect_waveform" in result
    assert "vl_query" in result             # existing preserved builtin (unchanged behavior)
    assert "some_mcp_tool" not in result    # genuinely filtered out (not allow-listed, not builtin)


def test_ui_mcp_tools_survive_explicit_empty_tool_selection():
    """explicit_tool_selection with an empty effective list still keeps system tools."""
    policy = RuntimePlanningPolicy()
    step = ExecutionStep(
        step_id="s2",
        skill_name="x",
        goal="g",
        instructions="i",
        step_type="general",
        allowed_tool_names=[],
        explicit_tool_selection=True,
    )
    result = _names(policy.resolve_step_tools(step=step, all_tools=ALL_TOOLS, skill_context=None))
    assert {"emit_ui_command", "get_ui_state", "wait_for_ui_command", "inspect_waveform"} <= result


def test_synthesis_step_still_gets_no_tools():
    """Guard: the fix must not leak tools into synthesis steps (which get none by design)."""
    policy = RuntimePlanningPolicy()
    step = ExecutionStep(
        step_id="s3", skill_name="x", goal="g", instructions="i", step_type="synthesis",
    )
    result = policy.resolve_step_tools(step=step, all_tools=ALL_TOOLS, skill_context=None)
    assert result == []
