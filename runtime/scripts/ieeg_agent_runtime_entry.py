"""Frozen entry point for the Electron iEEG agent runtime.

One executable hosts three runtime surfaces used by the packaged desktop app:

* ``serve``: FastAPI agent runtime via uvicorn.
* ``--ui-broker``: stdlib HTTP broker for renderer <-> UI MCP command traffic.
* ``--ui-mcp-server``: stdio JSON-RPC UI MCP server launched by the agent.
* ``--self-test``: offline import/resource check for packaging validation.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Callable


ROOT = Path(__file__).resolve().parents[2]
if not getattr(sys, "frozen", False) and str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _resource_root() -> Path:
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS)  # type: ignore[attr-defined]
    return ROOT


def configure_frozen_environment() -> Path:
    """Install resource defaults before importing runtime modules with globals."""
    root = _resource_root()
    # SkillRegistry expects the directory *containing* the production `skills/`
    # folder, not the production folder itself.
    os.environ.setdefault("SKILLS_BASE_DIR", str(root / "skills"))
    os.environ.setdefault("IEEG_UI_CATALOG", str(root / "contracts" / "ui-command-catalog.json"))
    if getattr(sys, "frozen", False) and not os.environ.get("IEEG_AGENT_DATA_DIR"):
        if sys.platform == "darwin":
            data_dir = Path.home() / "Library" / "Application Support" / "iEEG" / "agent-runtime" / "data"
        elif os.name == "nt":
            data_dir = Path(os.environ.get("LOCALAPPDATA") or (Path.home() / "AppData" / "Local")) / "iEEG" / "agent-runtime" / "data"
        else:
            data_dir = Path(os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local" / "share")) / "ieeg-agent" / "data"
        os.environ["IEEG_AGENT_DATA_DIR"] = str(data_dir)
    return root


def _parent_process_exists(pid: int) -> bool:
    if pid <= 1:
        return False
    if os.name == "nt":
        return _parent_process_exists_windows(pid)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _parent_process_exists_windows(pid: int) -> bool:
    """Liveness probe for Windows, where os.kill(pid, 0) is NOT a probe.

    CPython maps os.kill() to TerminateProcess for every signal except CTRL_C_EVENT and
    CTRL_BREAK_EVENT, so the POSIX `os.kill(pid, 0)` existence check actually asks Windows to
    KILL that pid. Against the Electron main process that is exactly what happened: roughly one
    guard interval after the packaged sidecar started, the app died -- no crash, no log, just
    gone -- and the call itself came back as WinError 87.

    Query the process instead. PROCESS_QUERY_LIMITED_INFORMATION is the minimum right needed and
    is grantable even across integrity levels, so this works where OpenProcess(ALL_ACCESS) would
    not. On any ambiguity we report the parent as alive: a false 'alive' merely delays sidecar
    shutdown by one interval, while a false 'dead' silently kills a working service.
    """
    import ctypes
    from ctypes import wintypes

    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    STILL_ACTIVE = 259
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    kernel32.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
    kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)

    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        # ERROR_INVALID_PARAMETER means no such pid; anything else (e.g. ERROR_ACCESS_DENIED)
        # means it exists but we may not query it.
        return ctypes.get_last_error() != 87
    try:
        code = wintypes.DWORD()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
            return True
        return code.value == STILL_ACTIVE
    finally:
        kernel32.CloseHandle(handle)


def _start_parent_death_guard(
    *,
    exit_process: Callable[[int], object] = os._exit,
    expected_pid: int | None = None,
    interval: float | None = None,
) -> threading.Thread:
    """Stop a packaged sidecar when the process that launched it disappears.

    UI MCP is launched through a shell by the Agent runtime, so checking that
    the expected PID still exists is more reliable than requiring it to remain
    the executable's immediate parent.
    """
    if expected_pid is None:
        try:
            expected_pid = int(os.environ.get("IEEG_PARENT_PID") or os.getppid())
        except (TypeError, ValueError):
            expected_pid = os.getppid()
    if interval is None:
        try:
            interval = float(os.environ.get("IEEG_PARENT_GUARD_INTERVAL", "2") or "2")
        except (TypeError, ValueError):
            interval = 2.0
    interval = max(0.05, interval)

    def _watch() -> None:
        while True:
            time.sleep(interval)
            if not _parent_process_exists(expected_pid):
                exit_process(0)
                return

    thread = threading.Thread(target=_watch, name="ieeg-parent-death-guard", daemon=True)
    thread.start()
    return thread


def _serve(host: str, port: int) -> int:
    configure_frozen_environment()
    import uvicorn
    from runtime.main import app

    uvicorn.run(app, host=host, port=port, reload=False)
    return 0


def _ui_broker(host: str, port: int) -> int:
    configure_frozen_environment()
    from ui_mcp.broker import build_server, load_catalog

    server = build_server(host, port)
    print(
        f"[ieeg-ui-broker] listening on http://{host}:{port} "
        f"(catalog: {len(load_catalog())} commands)",
        flush=True,
    )
    server.serve_forever()
    return 0


def _ui_mcp_server() -> int:
    configure_frozen_environment()
    from ui_mcp.mcp_server import main as mcp_main

    return mcp_main()


def _self_test_impl() -> int:
    root = configure_frozen_environment()
    checks = {
        "skills_base_dir": Path(os.environ["SKILLS_BASE_DIR"]).is_dir(),
        "skills_catalog": (Path(os.environ["SKILLS_BASE_DIR"]) / "skills").is_dir(),
        "ui_catalog": Path(os.environ["IEEG_UI_CATALOG"]).is_file(),
        "runtime_prompts": (root / "runtime" / "prompts").is_dir(),
    }
    if not all(checks.values()):
        raise RuntimeError(f"Bundled agent runtime resources are incomplete: {checks}")

    from runtime.core.config import _builtin_ieeg_ui_mcp_server_config
    from ui_mcp.mcp_server import SERVER_INFO

    print(
        json.dumps(
            {
                "status": "passed",
                "service": "ieeg-agent-runtime",
                "frozen": bool(getattr(sys, "frozen", False)),
                "resources": checks,
                "ui_mcp_command": _builtin_ieeg_ui_mcp_server_config()["command"],
                "ui_mcp_server": SERVER_INFO,
            }
        ),
        flush=True,
    )
    return 0


def _self_test() -> int:
    """Run packaging checks without ever writing logs into the frozen bundle."""
    if os.environ.get("IEEG_AGENT_DATA_DIR"):
        return _self_test_impl()
    # ignore_cleanup_errors: importing the runtime installs logging handlers that hold
    # <data_dir>/logs/mcp.log open, and Windows refuses to delete an open file (POSIX happily
    # unlinks one, which is why this only ever failed here). Without this the self-test prints
    # its "passed" JSON and *then* dies in TemporaryDirectory.__exit__ with WinError 32, exiting
    # non-zero -- useless as a packaging gate. The temp dir is disposable either way.
    with tempfile.TemporaryDirectory(
        prefix="ieeg-agent-runtime-self-test-", ignore_cleanup_errors=True
    ) as data_dir:
        os.environ["IEEG_AGENT_DATA_DIR"] = data_dir
        try:
            return _self_test_impl()
        finally:
            os.environ.pop("IEEG_AGENT_DATA_DIR", None)


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    parser = argparse.ArgumentParser(prog="ieeg-agent-runtime")
    parser.add_argument("--ui-broker", action="store_true", help="run the UI HTTP broker")
    parser.add_argument("--ui-mcp-server", action="store_true", help="run the stdio UI MCP server")
    parser.add_argument("--self-test", action="store_true", help="validate bundled resources offline")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8001)
    parser.add_argument("command", nargs="?", choices=["serve"], default="serve")
    args = parser.parse_args(argv)

    modes = [args.ui_broker, args.ui_mcp_server, args.self_test]
    if sum(1 for enabled in modes if enabled) > 1:
        parser.error("choose only one of --ui-broker, --ui-mcp-server, or --self-test")

    if args.self_test:
        return _self_test()
    _start_parent_death_guard()
    if args.ui_mcp_server:
        return _ui_mcp_server()
    if args.ui_broker:
        return _ui_broker(args.host, args.port)
    return _serve(args.host, args.port)


if __name__ == "__main__":
    raise SystemExit(main())
