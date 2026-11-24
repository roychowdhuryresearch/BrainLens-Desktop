import importlib
import json
import os
from pathlib import Path
import subprocess
import sys

from runtime.core.config import ConfigManager, _builtin_ieeg_ui_mcp_server_config


def test_builtin_ieeg_ui_mcp_command_prefers_packaged_executable(monkeypatch) -> None:
    executable = "/Applications/iEEG Workstation.app/Contents/Resources/backend/agent-runtime/ieeg-agent-runtime"
    monkeypatch.setenv("IEEG_UI_MCP_EXECUTABLE", executable)

    config = _builtin_ieeg_ui_mcp_server_config()

    assert config["command"] == "'/Applications/iEEG Workstation.app/Contents/Resources/backend/agent-runtime/ieeg-agent-runtime' --ui-mcp-server"
    assert config["env"]["IEEG_PARENT_PID"] == str(os.getpid())


def test_config_manager_uses_agent_config_dir(monkeypatch, tmp_path: Path) -> None:
    config_dir = tmp_path / "agent-config"
    monkeypatch.setenv("IEEG_AGENT_CONFIG_DIR", str(config_dir))

    manager = ConfigManager()

    assert manager.config_path == config_dir / "config.yaml"
    assert manager.user_config_path == config_dir / "user_config.yaml"
    manager.load_config()
    assert manager.user_config_path.exists()


def test_agent_history_db_uses_agent_data_dir(monkeypatch, tmp_path: Path) -> None:
    data_dir = tmp_path / "agent-data"
    import runtime.agent_history.db as db

    with monkeypatch.context() as scoped:
        scoped.setenv("IEEG_AGENT_DATA_DIR", str(data_dir))
        db = importlib.reload(db)
        assert db.DATA_DIR == data_dir
        assert db.HISTORY_DB_PATH == data_dir / "agent_history.db"
    importlib.reload(db)


def test_runtime_loggers_use_agent_data_dir(monkeypatch, tmp_path: Path) -> None:
    data_dir = tmp_path / "agent-data"
    monkeypatch.setenv("IEEG_AGENT_DATA_DIR", str(data_dir))

    from runtime.agent_runtime.vl_logger import VLLogger
    from runtime.context.context_logger import ContextLogger
    from runtime.core.mcp_logger import MCPLogger
    from runtime.skills.skill_logger import SkillLogger

    loggers = [MCPLogger(), ContextLogger(), SkillLogger(), VLLogger()]

    assert all(logger.log_dir == data_dir / "logs" for logger in loggers)
    assert loggers[2].verification_issue_log_path == data_dir / "logs" / "verification_issues.log"


def test_agent_runtime_self_test_sets_resource_defaults(monkeypatch, capsys) -> None:
    monkeypatch.delenv("SKILLS_BASE_DIR", raising=False)
    monkeypatch.delenv("IEEG_UI_CATALOG", raising=False)

    from runtime.scripts.ieeg_agent_runtime_entry import _self_test

    assert _self_test() == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["status"] == "passed"
    assert payload["resources"]["skills_base_dir"] is True
    assert payload["resources"]["skills_catalog"] is True
    assert payload["resources"]["ui_catalog"] is True


def test_agent_runtime_frozen_spec_excludes_non_runtime_dependency_stacks() -> None:
    spec_path = Path(__file__).resolve().parents[1] / "runtime" / "ieeg_agent_runtime_macos.spec"
    spec = spec_path.read_text(encoding="utf-8")

    for excluded in (
        "IPython",
        "ipykernel",
        "jedi",
        "parso",
        "sphinx",
        "sphinxcontrib",
        "docutils",
        "alabaster",
        "babel",
        "tkinter",
        "_tkinter",
        "psycopg",
        "psycopg_binary",
        "asyncpg",
    ):
        assert f'"{excluded}"' in spec

    for required in ("boto3", "botocore", "PIL", "lxml", "sqlalchemy"):
        assert f'"{required}"' not in spec


def test_agent_runtime_sidecar_exits_when_expected_parent_is_missing(tmp_path: Path) -> None:
    entry = Path(__file__).resolve().parents[1] / "runtime" / "scripts" / "ieeg_agent_runtime_entry.py"
    env = {
        **os.environ,
        "IEEG_PARENT_PID": "2147483647",
        "IEEG_PARENT_GUARD_INTERVAL": "0.05",
    }
    process = subprocess.Popen(
        [sys.executable, str(entry), "--ui-broker", "--host", "127.0.0.1", "--port", "0"],
        cwd=entry.parents[2],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        assert process.wait(timeout=5) == 0
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
