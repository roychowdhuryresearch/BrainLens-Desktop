from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from runtime.core.agent_settings import get_agent_settings
from runtime.pyhfo_env import pyhfo_process_env


REPO_ROOT = Path(__file__).resolve().parents[1]
PYHFO_ROOT = REPO_ROOT / "pyhfo"
DEFAULT_AGENT_HOST = "127.0.0.1"
DEFAULT_AGENT_PORT = 8001
DEFAULT_PYHFO_HOST = "127.0.0.1"
DEFAULT_PYHFO_PORT = 8765
DEFAULT_TIMEOUT_SECONDS = 5.0
AGENT_CONTRACT_VERSION = "ieeg-agent.v1"

DEFAULT_BACKEND_ALLOWED_SKILLS = [
    "eeg-format-understanding",
    "eeg-signal-roi",
    "eeg-qc-cleaning",
    "eeg-preprocessing",
    "pyhfo-detection",
    "eeg-result-interpretation",
    "eeg-iteration-optimization",
    "eeg-clinical-label-evaluation",
]


@dataclass(frozen=True)
class ServiceSpec:
    name: str
    command: List[str]
    cwd: Path
    env: Dict[str, str]
    health_url: str
    token: Optional[str] = None


def _json_print(payload: Any) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))


def _agent_token(explicit: Optional[str] = None) -> str:
    token = (explicit or "").strip() or get_agent_settings().service_token
    if not token:
        raise argparse.ArgumentTypeError(
            "set PYHFO_AGENT_SERVICE_TOKEN or AGENT_SERVICE_TOKEN, or pass --token"
        )
    return token


def _pyhfo_python(explicit: Optional[str] = None) -> str:
    return explicit or os.getenv("PYHFO_AGENT_PYTHON") or sys.executable


def _pyhfo_root(explicit: Optional[str] = None) -> Path:
    configured = explicit or os.getenv("PYHFO_AGENT_APP_ROOT")
    return Path(configured).expanduser().resolve() if configured else PYHFO_ROOT


def _env_with_defaults(base: Optional[Dict[str, str]] = None, **updates: str) -> Dict[str, str]:
    env = dict(base or os.environ)
    for key, value in updates.items():
        if value is not None:
            env[key] = value
    return env


def build_agent_service_spec(
    *,
    host: str = DEFAULT_AGENT_HOST,
    port: int = DEFAULT_AGENT_PORT,
    token: Optional[str] = None,
    pyhfo_root: Optional[str] = None,
    pyhfo_python: Optional[str] = None,
    enable_mcp: bool = False,
) -> ServiceSpec:
    resolved_token = _agent_token(token)
    env = _env_with_defaults(
        AGENT_SERVICE_TOKEN=resolved_token,
        PYHFO_AGENT_SERVICE_TOKEN=resolved_token,
        PYHFO_AGENT_APP_ROOT=str(_pyhfo_root(pyhfo_root)),
        PYHFO_AGENT_PYTHON=_pyhfo_python(pyhfo_python),
        IEEG_AGENT_SKIP_MCP="0" if enable_mcp else "1",
        IEEG_AGENT_SKIP_TONE=os.getenv("IEEG_AGENT_SKIP_TONE") or "1",
    )
    return ServiceSpec(
        name="agent",
        command=[
            sys.executable,
            "-m",
            "uvicorn",
            "runtime.main:app",
            "--host",
            host,
            "--port",
            str(port),
        ],
        cwd=REPO_ROOT,
        env=env,
        health_url=f"http://{host}:{port}/health",
        token=resolved_token,
    )


def build_pyhfo_service_spec(
    *,
    host: str = DEFAULT_PYHFO_HOST,
    port: int = DEFAULT_PYHFO_PORT,
    token: Optional[str] = None,
    pyhfo_root: Optional[str] = None,
    pyhfo_python: Optional[str] = None,
    agent_url: Optional[str] = None,
    agent_token: Optional[str] = None,
) -> ServiceSpec:
    resolved_root = _pyhfo_root(pyhfo_root)
    resolved_python = _pyhfo_python(pyhfo_python)
    env_updates: Dict[str, str] = {
        "PYHFO_AGENT_APP_ROOT": str(resolved_root),
        "PYHFO_AGENT_PYTHON": resolved_python,
    }
    if agent_url:
        env_updates["PYHFO_AGENT_CHAT_URL"] = agent_url
    if agent_token:
        env_updates["PYHFO_AGENT_SERVICE_TOKEN"] = agent_token
    if token:
        env_updates["PYHFO_BACKEND_TOKEN"] = token
    return ServiceSpec(
        name="pyhfo",
        command=[
            resolved_python,
            "-m",
            "pyhfo.agent_api.server",
            "--host",
            host,
            "--port",
            str(port),
        ],
        cwd=resolved_root,
        env=_env_with_defaults(pyhfo_process_env(resolved_root), **env_updates),
        health_url=f"http://{host}:{port}/health",
        token=token,
    )


def build_pyhfo_cli_command(args: Sequence[str], *, pyhfo_python: Optional[str] = None) -> List[str]:
    return [_pyhfo_python(pyhfo_python), "-m", "pyhfo.agent_cli", *list(args)]


def _request_json(
    url: str,
    *,
    method: str = "GET",
    token: Optional[str] = None,
    contract_version: Optional[str] = None,
    payload: Optional[Dict[str, Any]] = None,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
) -> Dict[str, Any]:
    headers = {"accept": "application/json"}
    data = None
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["content-type"] = "application/json; charset=utf-8"
    if token:
        headers["authorization"] = f"Bearer {token}"
    if contract_version:
        headers["X-Contract-Version"] = contract_version
    req = Request(url, data=data, headers=headers, method=method)
    with urlopen(req, timeout=timeout_seconds) as response:
        raw = response.read().decode("utf-8")
    try:
        parsed = json.loads(raw or "{}")
    except json.JSONDecodeError:
        return {"status": "error", "raw": raw}
    return parsed if isinstance(parsed, dict) else {"status": "ok", "result": parsed}


def check_service(
    url: str,
    *,
    token: Optional[str] = None,
    contract_version: Optional[str] = None,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
) -> Dict[str, Any]:
    try:
        payload = _request_json(
            url,
            token=token,
            contract_version=contract_version,
            timeout_seconds=timeout_seconds,
        )
        status = str(payload.get("status") or "").lower()
        ok = status in {"ok", "healthy", "ready", "success"} or bool(payload)
        return {"ok": ok, "url": url, "response": payload}
    except HTTPError as exc:
        return {"ok": False, "url": url, "error": f"HTTP {exc.code}"}
    except (OSError, URLError) as exc:
        return {"ok": False, "url": url, "error": str(exc)}


def build_chat_payload(args: argparse.Namespace) -> Dict[str, Any]:
    allowed_skills = None
    if not args.all_skills:
        allowed_skills = [{"name": name} for name in DEFAULT_BACKEND_ALLOWED_SKILLS]
    return {
        "request_id": args.request_id or f"cli-{uuid.uuid4().hex}",
        "conversation_id": args.conversation_id,
        "message": args.message,
        "knowledge_base_id": None,
        "use_search": not args.no_search,
        "active_skill": args.active_skill,
        "model": args.model,
        "skill_environment": args.skill_environment,
        "response_mode": args.response_mode,
        "user_context": {
            "user_id": args.user_id,
            "username": args.username,
            "role": args.role,
            "tenant_id": args.tenant_id,
            "team_ids": [],
            "allowed_mcp_servers": [] if args.disable_mcp else None,
        },
        "auth_context": {"permissions": ["agent:chat"], "session_id": args.session_id},
        "allowed_skills": allowed_skills,
        "skill_recommendation_candidates": [],
        "allowed_mcps": [],
        "request_metadata": {
            "source": "backend-cli",
            "trace_id": args.trace_id,
            "client_version": "runtime.cli",
            "request_id": args.request_id,
        },
        "recording_path": args.recording,
    }


def _wait_for_ready(specs: Iterable[ServiceSpec], timeout_seconds: float) -> Dict[str, Any]:
    deadline = time.time() + timeout_seconds
    pending = {spec.name: spec for spec in specs}
    status: Dict[str, Any] = {}
    while pending and time.time() < deadline:
        for name, spec in list(pending.items()):
            check = check_service(spec.health_url, timeout_seconds=1.0)
            status[name] = check
            if check.get("ok"):
                pending.pop(name, None)
        if pending:
            time.sleep(0.25)
    for name, spec in pending.items():
        status[name] = check_service(spec.health_url, timeout_seconds=1.0)
    return status


def _terminate(processes: Sequence[subprocess.Popen[Any]]) -> None:
    for process in processes:
        if process.poll() is None:
            process.terminate()
    deadline = time.time() + 8.0
    while time.time() < deadline and any(process.poll() is None for process in processes):
        time.sleep(0.1)
    for process in processes:
        if process.poll() is None:
            process.kill()


def cmd_serve(args: argparse.Namespace) -> int:
    agent = build_agent_service_spec(
        host=args.host,
        port=args.port,
        token=args.token,
        pyhfo_root=args.pyhfo_root,
        pyhfo_python=args.pyhfo_python,
        enable_mcp=args.enable_mcp,
    )
    specs = [agent]
    if not args.no_pyhfo:
        specs.append(
            build_pyhfo_service_spec(
                host=args.pyhfo_host,
                port=args.pyhfo_port,
                token=args.pyhfo_token,
                agent_url=(
                    os.getenv("PYHFO_AGENT_CHAT_URL")
                    or os.getenv("IEEG_AGENT_CHAT_URL")
                    or f"http://{args.host}:{args.port}/internal/agent/v1/chat"
                ),
                agent_token=agent.token,
                pyhfo_root=args.pyhfo_root,
                pyhfo_python=args.pyhfo_python,
            )
        )

    processes: List[subprocess.Popen[Any]] = []

    def handle_signal(_signum: int, _frame: Any) -> None:
        _terminate(processes)
        raise SystemExit(0)

    previous_int = signal.signal(signal.SIGINT, handle_signal)
    previous_term = signal.signal(signal.SIGTERM, handle_signal)
    try:
        for spec in specs:
            processes.append(subprocess.Popen(spec.command, cwd=str(spec.cwd), env=spec.env))
        ready = _wait_for_ready(specs, args.startup_timeout)
        _json_print(
            {
                "status": "ready" if all(item.get("ok") for item in ready.values()) else "starting",
                "services": {
                    spec.name: {
                        "url": spec.health_url.rsplit("/health", 1)[0],
                        "health_url": spec.health_url,
                        "pid": processes[index].pid,
                        "token_env": "AGENT_SERVICE_TOKEN" if spec.name == "agent" else ("PYHFO_BACKEND_TOKEN" if spec.token else None),
                    }
                    for index, spec in enumerate(specs)
                },
                "health": ready,
            }
        )
        while True:
            for process, spec in zip(processes, specs):
                code = process.poll()
                if code is not None:
                    _terminate(processes)
                    print(f"{spec.name} exited with code {code}", file=sys.stderr)
                    # poll() returned non-None, so `code` is a real exit code. Don't map a
                    # clean 0 to 1 (`0 or 1` == 1) — that would make a graceful child
                    # shutdown look like a crash to a supervisor. Encode signal deaths the
                    # conventional way (SIGTERM -15 -> 143).
                    return code if code >= 0 else 128 - code
            time.sleep(0.5)
    finally:
        signal.signal(signal.SIGINT, previous_int)
        signal.signal(signal.SIGTERM, previous_term)
        _terminate(processes)


def cmd_health(args: argparse.Namespace) -> int:
    token = _agent_token(args.token)
    agent_url = args.agent_url.rstrip("/")
    pyhfo_url = args.pyhfo_url.rstrip("/") if args.pyhfo_url else None
    checks = {
        "agent": check_service(f"{agent_url}/health", timeout_seconds=args.timeout),
        "agent_internal": check_service(
            f"{agent_url}/internal/agent/v1/health",
            token=token,
            contract_version=AGENT_CONTRACT_VERSION,
            timeout_seconds=args.timeout,
        ),
    }
    if pyhfo_url:
        checks["pyhfo"] = check_service(
            f"{pyhfo_url}/health",
            token=args.pyhfo_token,
            timeout_seconds=args.timeout,
        )
    ok = all(item.get("ok") for item in checks.values())
    _json_print({"status": "ok" if ok else "error", "checks": checks})
    return 0 if ok else 1


def cmd_chat(args: argparse.Namespace) -> int:
    url = args.url.rstrip("/") + "/internal/agent/v1/chat"
    payload = build_chat_payload(args)
    try:
        response = _request_json(
            url,
            method="POST",
            token=_agent_token(args.token),
            contract_version=AGENT_CONTRACT_VERSION,
            payload=payload,
            timeout_seconds=args.timeout,
        )
    except HTTPError as exc:
        print(json.dumps({"status": "error", "error": f"HTTP {exc.code}"}, sort_keys=True), file=sys.stderr)
        return 1
    except (OSError, URLError) as exc:
        print(json.dumps({"status": "error", "error": str(exc)}, sort_keys=True), file=sys.stderr)
        return 1

    if args.json:
        _json_print(response)
    else:
        # Distinguish an empty-string answer (tool-only / streamed turn) from a missing
        # key: `content or response` would dump the whole response dict on an empty answer.
        content = response.get("content")
        print(content if content is not None else json.dumps(response, sort_keys=True))
    return 0 if str(response.get("status", "completed")) in {"completed", "success"} else 1


def cmd_pyhfo(args: argparse.Namespace) -> int:
    if not args.pyhfo_args:
        print("usage: python -m runtime.cli pyhfo <pyhfo-agent command> [args...]", file=sys.stderr)
        return 2
    root = _pyhfo_root(args.pyhfo_root)
    command = build_pyhfo_cli_command(args.pyhfo_args, pyhfo_python=args.pyhfo_python)
    env = _env_with_defaults(
        pyhfo_process_env(root),
        PYHFO_AGENT_APP_ROOT=str(root),
        PYHFO_AGENT_PYTHON=_pyhfo_python(args.pyhfo_python),
    )
    completed = subprocess.run(command, cwd=str(root), env=env)
    return int(completed.returncode)


def _env_port(name: str, default: int) -> int:
    """Parse a port from an env var without crashing the whole CLI on a bad value.

    build_parser() is called for EVERY subcommand, so an inline int(os.getenv(...)) in a
    default= expression makes a malformed IEEG_AGENT_PORT/PYHFO_BACKEND_PORT abort even
    `health`/`chat` with a raw traceback before argparse runs.
    """
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        print(f"warning: {name}={raw!r} is not a valid port; using {default}", file=sys.stderr)
        return default


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="ieeg-agent",
        description="Backend-only CLI for the iEEG agent runtime and bundled PyHFO engine.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    serve = subparsers.add_parser("serve", help="Start the headless backend services.")
    serve.add_argument("--host", default=os.getenv("IEEG_AGENT_HOST", DEFAULT_AGENT_HOST))
    serve.add_argument("--port", type=int, default=_env_port("IEEG_AGENT_PORT", DEFAULT_AGENT_PORT))
    serve.add_argument("--token", help="Agent service token. Required unless PYHFO_AGENT_SERVICE_TOKEN or AGENT_SERVICE_TOKEN is set.")
    serve.add_argument("--enable-mcp", action="store_true", help="Enable configured MCP servers. Disabled by default for backend-only startup.")
    serve.add_argument("--no-pyhfo", action="store_true", help="Start only the agent runtime.")
    serve.add_argument("--pyhfo-host", default=os.getenv("PYHFO_BACKEND_HOST", DEFAULT_PYHFO_HOST))
    serve.add_argument("--pyhfo-port", type=int, default=_env_port("PYHFO_BACKEND_PORT", DEFAULT_PYHFO_PORT))
    serve.add_argument("--pyhfo-token", help="Optional token required by the PyHFO sidecar.")
    serve.add_argument("--pyhfo-root", help="Path to the bundled or alternate PyHFO app root.")
    serve.add_argument("--pyhfo-python", help="Python executable for PyHFO commands.")
    serve.add_argument("--startup-timeout", type=float, default=60.0)
    serve.set_defaults(func=cmd_serve)

    health = subparsers.add_parser("health", help="Check backend service health.")
    health.add_argument("--agent-url", default=f"http://{DEFAULT_AGENT_HOST}:{DEFAULT_AGENT_PORT}")
    health.add_argument("--pyhfo-url", default=f"http://{DEFAULT_PYHFO_HOST}:{DEFAULT_PYHFO_PORT}", help="Set empty string to skip PyHFO.")
    health.add_argument("--token", help="Agent service token.")
    health.add_argument("--pyhfo-token", help="Optional PyHFO sidecar token.")
    health.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_SECONDS)
    health.set_defaults(func=cmd_health)

    chat = subparsers.add_parser("chat", help="Send one non-streaming chat request to a running agent backend.")
    chat.add_argument("message")
    chat.add_argument("--url", default=f"http://{DEFAULT_AGENT_HOST}:{DEFAULT_AGENT_PORT}")
    chat.add_argument("--token", help="Agent service token.")
    chat.add_argument("--timeout", type=float, default=300.0)
    chat.add_argument("--conversation-id")
    chat.add_argument("--session-id")
    chat.add_argument("--request-id")
    chat.add_argument("--trace-id")
    chat.add_argument("--recording")
    chat.add_argument("--active-skill")
    chat.add_argument("--model")
    chat.add_argument("--skill-environment", default="prod")
    chat.add_argument("--response-mode", default="default")
    chat.add_argument("--user-id", default="backend-cli-user")
    chat.add_argument("--username", default="Backend CLI")
    chat.add_argument("--role", default="researcher")
    chat.add_argument("--tenant-id", default="default")
    chat.add_argument("--no-search", action="store_true")
    chat.add_argument("--enable-mcp", dest="disable_mcp", action="store_false", default=True)
    chat.add_argument("--all-skills", action="store_true", help="Do not restrict the request to backend-safe EEG/PyHFO skills.")
    chat.add_argument("--json", action="store_true", help="Print the full JSON response.")
    chat.set_defaults(func=cmd_chat)

    pyhfo = subparsers.add_parser("pyhfo", help="Run the bundled PyHFO agent CLI.")
    pyhfo.add_argument("--pyhfo-root", help="Path to the bundled or alternate PyHFO app root.")
    pyhfo.add_argument("--pyhfo-python", help="Python executable for PyHFO commands.")
    pyhfo.add_argument("pyhfo_args", nargs=argparse.REMAINDER)
    pyhfo.set_defaults(func=cmd_pyhfo)

    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except argparse.ArgumentTypeError as exc:
        parser.error(str(exc))


if __name__ == "__main__":
    raise SystemExit(main())
