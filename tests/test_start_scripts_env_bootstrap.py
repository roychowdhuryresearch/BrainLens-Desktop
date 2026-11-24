from __future__ import annotations

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def test_agent_start_script_is_standalone_research_runtime():
    content = (REPO_ROOT / "start.bat").read_text(encoding="utf-8")

    assert "iEEG Agent Runtime" in content
    assert "python -m uvicorn runtime.main:app" in content


def test_agent_start_script_documents_required_runtime_secrets():
    content = (REPO_ROOT / "start.bat").read_text(encoding="utf-8")

    assert "IEEG_JWT_SECRET_KEY" in content or "AGENT_JWT_SECRET_KEY" in content
    assert "IEEG_ALLOW_INTERNAL_DEBUG_DETAILS" in content


def test_electron_launch_script_skips_slow_desktop_agent_tone_classifier():
    content = (REPO_ROOT / "desktop" / "scripts" / "launch-electron-app.mjs").read_text(encoding="utf-8")

    assert "IEEG_AGENT_SKIP_TONE" in content
    assert "process.env.IEEG_AGENT_SKIP_TONE || '1'" in content


def test_electron_launch_script_uses_ui_mcp_allowlist():
    content = (REPO_ROOT / "desktop" / "scripts" / "launch-electron-app.mjs").read_text(encoding="utf-8")

    assert "IEEG_AGENT_SKIP_MCP" in content
    assert "process.env.IEEG_AGENT_SKIP_MCP || '0'" in content
    assert "IEEG_AGENT_MCP_SERVERS" in content
    assert "process.env.IEEG_AGENT_MCP_SERVERS || 'ieeg_ui'" in content
