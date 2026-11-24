from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
INTERNAL_AGENT_API = REPO_ROOT / "runtime" / "api" / "internal_agent.py"


def test_internal_agent_exposes_filtered_tools_endpoint() -> None:
    content = INTERNAL_AGENT_API.read_text(encoding="utf-8")

    assert 'class InternalToolListRequest(BaseModel):' in content
    assert '@router.post("/tools")' in content
    assert 'mcp_manager.get_tools_for_user(user_context)' in content
    assert 'pyhfo_tools.get_tool_definitions()' in content
    assert '"tools": tools' in content
