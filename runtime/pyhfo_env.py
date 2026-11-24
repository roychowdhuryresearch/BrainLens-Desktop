"""Run the checkout's PyHFO package with its configured Python interpreter."""

from __future__ import annotations

import os
from pathlib import Path


def pyhfo_process_env(app_root: Path) -> dict[str, str]:
    env = os.environ.copy()
    source_root = app_root / "src"
    if (source_root / "pyhfo" / "agent_cli.py").is_file():
        paths = [str(source_root)]
        if env.get("PYTHONPATH"):
            paths.append(env["PYTHONPATH"])
        env["PYTHONPATH"] = os.pathsep.join(paths)
    return env
