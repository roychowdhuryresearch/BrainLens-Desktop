from __future__ import annotations

import os
import sys
from pathlib import Path


os.environ.setdefault("AGENT_SERVICE_TOKEN", "test-agent-service-token")

AGENT_ROOT = Path(__file__).resolve().parent.parent
if str(AGENT_ROOT) not in sys.path:
    sys.path.insert(0, str(AGENT_ROOT))


def test_mcp_local_client_builds_utf8_subprocess_env(monkeypatch):
    from runtime.core.mcp_local_client import LocalMCPClient

    monkeypatch.setenv("SHARED_ENV", "from-parent")
    client = LocalMCPClient(
        "test",
        {
            "type": "local",
            "command": "echo test",
            "env": {
                "CHILD_ONLY": "from-config",
            },
        },
    )

    env = client._build_subprocess_env()

    assert env["SHARED_ENV"] == "from-parent"
    assert env["CHILD_ONLY"] == "from-config"
    assert env["PYTHONIOENCODING"] == "utf-8"
    assert env["PYTHONUTF8"] == "1"
