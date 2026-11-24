#!/usr/bin/env python3
"""Zero-dependency stdio MCP server: the iEEG **agent** as an MCP connector.

This is the mirror image of ``ui_mcp/mcp_server.py``. Where that server exposes the desktop UI so the
agent can drive it, THIS server exposes the agent itself so an external evaluator can drive the agent —
purely over MCP, with no access to the agent's Python process. It is a thin client of the agent runtime
HTTP API (``POST /internal/agent/v1/chat/stream``), so the agent it talks to may be on another machine:
point ``IEEG_AGENT_BASE_URL`` at any host and the same MCP contract works.

Exposed MCP tools:
  - agent_run_task(message, recording_path?, conversation_id?, ...) -> run ONE full agent turn and return
      its final answer + the complete tool trajectory (what the agent did, in order) + tool results.
  - agent_health()    -> is the agent reachable / ready?
  - agent_list_tools() -> what tools does the agent advertise (its capability surface)?

Speaks MCP JSON-RPC 2.0 over stdio (newline-delimited). Stdlib only — never `pip install mcp` (that
breaks the agent env's fastapi/zhipuai pins; this server lives outside that env anyway).

Config via env:
  IEEG_AGENT_BASE_URL       (default http://127.0.0.1:8001)         -- the agent runtime, possibly remote
  IEEG_AGENT_API_PREFIX     (default /internal/agent/v1)
  IEEG_AGENT_SERVICE_TOKEN  (required for runtime requests) -- bearer for the runtime
  IEEG_AGENT_TIMEOUT        (default 600)                           -- per-read socket timeout (detection is slow)
  IEEG_AGENT_MODEL          (optional)                              -- default model override per turn

Add to a Claude Code .mcp.json so an agent can evaluate the agent:
  {"mcpServers": {"ieeg-agent": {"command": "python",
     "args": ["/abs/path/evals/blackbox/agent_mcp_server.py"],
     "env": {"IEEG_AGENT_BASE_URL": "http://remote-host:8001"}}}}
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from uuid import uuid4

PROTOCOL_VERSION = "2024-11-05"
SERVER_INFO = {"name": "ieeg-agent", "version": "0.1.0"}
AGENT_CONTRACT_VERSION = "ieeg-agent.v1"

BASE_URL = os.getenv("IEEG_AGENT_BASE_URL", "http://127.0.0.1:8001").rstrip("/")
API_PREFIX = os.getenv("IEEG_AGENT_API_PREFIX", "/internal/agent/v1").rstrip("/")
API = f"{BASE_URL}{API_PREFIX}"
TOKEN = os.getenv("IEEG_AGENT_SERVICE_TOKEN", "").strip()
TIMEOUT = float(os.getenv("IEEG_AGENT_TIMEOUT", "600"))
DEFAULT_MODEL = os.getenv("IEEG_AGENT_MODEL") or None

# A stable, non-clinical identity for the evaluator that drives the agent.
EVAL_USER_CONTEXT = {"user_id": "blackbox-eval", "username": "evaluator", "role": "USER", "tenant_id": "default"}


# ── agent runtime HTTP client ─────────────────────────────────────────────────
def _headers() -> dict:
    if not TOKEN:
        raise ValueError("Set IEEG_AGENT_SERVICE_TOKEN to the runtime service token.")
    return {
        "content-type": "application/json",
        "authorization": f"Bearer {TOKEN}",
        "X-Contract-Version": AGENT_CONTRACT_VERSION,
    }


def _http(method: str, path: str, body: dict | None = None, timeout: float = 30.0) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{API}{path}", data=data, method=method, headers=_headers())
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode() or "{}")


def _sse_stream(path: str, body: dict, timeout: float):
    """Yield (event, data_dict) for each Server-Sent Event from a streaming POST.

    Canonical runtimes put the complete ``ieeg-agent.v1`` semantic envelope in
    the ``data:`` field.  Older runtimes put the event payload there directly.
    Normalize both forms to the historical ``(event, payload)`` shape consumed
    by the existing evaluation code. ``timeout`` is the per-read socket timeout,
    so a long-but-progressing detection stream is fine while a wedged server
    still aborts.
    """
    req = urllib.request.Request(f"{API}{path}", data=json.dumps(body).encode(), method="POST", headers=_headers())
    resp = urllib.request.urlopen(req, timeout=timeout)
    event, data_lines = None, []
    try:
        for raw in resp:  # HTTPResponse iterates line-by-line as bytes arrive
            line = raw.decode("utf-8", "replace").rstrip("\r\n")
            if line == "":  # blank line terminates one event
                if event is not None or data_lines:
                    yield _unwrap_sse_event(event or "message", _parse_data(data_lines))
                event, data_lines = None, []
                continue
            if line.startswith(":"):
                continue  # SSE comment / keep-alive
            if line.startswith("event:"):
                event = line[6:].strip()
            elif line.startswith("data:"):
                data_lines.append(line[5:].lstrip(" "))
        if event is not None or data_lines:  # flush a trailing event with no blank line
            yield _unwrap_sse_event(event or "message", _parse_data(data_lines))
    finally:
        resp.close()


def _parse_data(data_lines: list[str]) -> dict:
    payload = "\n".join(data_lines)
    if not payload:
        return {}
    try:
        parsed = json.loads(payload)
        return parsed if isinstance(parsed, dict) else {"value": parsed}
    except Exception:
        return {"_raw": payload}


def _unwrap_sse_event(transport_event: str, payload: dict) -> tuple[str, dict]:
    """Return one semantic event while retaining legacy flat-SSE compatibility."""

    canonical = {
        "contract_version",
        "sequence",
        "event",
        "visibility",
        "data",
    }.issubset(payload)
    if not canonical:
        return transport_event, payload

    if payload.get("contract_version") != AGENT_CONTRACT_VERSION:
        raise ValueError("unsupported agent stream contract version")
    semantic_event = payload.get("event")
    if not isinstance(semantic_event, str) or not semantic_event:
        raise ValueError("canonical agent stream envelope is missing event")
    if transport_event != "message" and transport_event != semantic_event:
        raise ValueError("SSE event name does not match canonical agent envelope")
    if "data" not in payload:
        raise ValueError("canonical agent stream envelope is missing data")

    semantic_data = payload["data"]
    if isinstance(semantic_data, dict):
        return semantic_event, semantic_data
    return semantic_event, {"value": semantic_data}


# ── tool implementations ──────────────────────────────────────────────────────
def tool_agent_run_task(args: dict) -> str:
    """Drive one full agent turn over HTTP/SSE and return the complete black-box trace."""
    message = str(args.get("message") or "").strip()
    if not message:
        return json.dumps({"ok": False, "error": "message is required"})
    conv_id = str(args.get("conversation_id") or f"blackbox-{uuid4().hex[:12]}")
    body = {
        "request_id": uuid4().hex,
        "conversation_id": conv_id,
        "message": message,
        "skill_environment": str(args.get("skill_environment") or "prod"),
        "user_context": dict(EVAL_USER_CONTEXT),
        "allowed_mcps": args.get("allowed_mcps") if isinstance(args.get("allowed_mcps"), list) else [],
    }
    if args.get("recording_path"):
        body["recording_path"] = str(args["recording_path"])
    if isinstance(args.get("ui_state"), dict):
        body["ui_state"] = args["ui_state"]
    model = args.get("model") or DEFAULT_MODEL
    if model:
        body["model"] = str(model)
    timeout = float(args.get("timeout_seconds") or TIMEOUT)

    trajectory: list[str] = []
    tool_calls: list[dict] = []
    tool_results: dict = {}
    tool_events: list[dict] = []
    content: list[str] = []
    event_log: list[dict] = []
    done = None
    error = None
    t0 = time.monotonic()
    try:
        for event, data in _sse_stream("/chat/stream", body, timeout):
            event_log.append({"event": event, "keys": sorted(data.keys())[:8]})
            name = data.get("name")
            if event == "tool_call" and name:
                trajectory.append(name)
                tool_calls.append({"name": name, "args": data.get("args") or data.get("arguments") or data.get("input") or {}})
            elif event == "tool_result" and name:
                tool_results[name] = data.get("result")
                tool_events.append({"name": name, "result": data.get("result")})
            elif event == "content":
                text = str(data.get("text") or data.get("content") or "")
                if data.get("replace") is True:
                    content[:] = [text]
                else:
                    content.append(text)
            elif event in ("done", "plan_completed"):
                done = data
            elif event == "error":
                error = str(data.get("message") or data.get("error") or "stream error")
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", "replace")[:200]
        except Exception:
            pass
        error = f"HTTP {exc.code}: {detail or exc.reason}"
    except Exception as exc:  # noqa: BLE001 — surface as tool error, not a transport crash
        error = f"{type(exc).__name__}: {exc}"

    return json.dumps({
        "ok": error is None,
        "conversation_id": conv_id,
        "final_answer": "".join(content),
        "trajectory": trajectory,
        "tool_calls": tool_calls,
        "tool_results": tool_results,
        "tool_events": tool_events,
        "events": event_log,
        "done": done,
        "error": error,
        "elapsed_seconds": round(time.monotonic() - t0, 2),
    }, ensure_ascii=False)


def tool_agent_health(_args: dict) -> str:
    out: dict = {"base_url": BASE_URL, "api": API}
    try:
        out["health"] = _http("GET", "/health")
        try:
            out["version"] = _http("GET", "/version")
        except Exception:
            pass
        out["ok"] = str(out.get("health", {}).get("status", "")).lower() in ("healthy", "ok", "ready")
    except urllib.error.HTTPError as exc:
        out["ok"] = False
        out["error"] = f"HTTP {exc.code}: {exc.reason}"
    except Exception as exc:  # noqa: BLE001
        out["ok"] = False
        out["error"] = f"{type(exc).__name__}: {exc}"
    return json.dumps(out, ensure_ascii=False)


def tool_agent_list_tools(_args: dict) -> str:
    body = {"user_context": dict(EVAL_USER_CONTEXT), "allowed_mcps": []}
    try:
        res = _http("POST", "/tools", body)
        tools = res.get("tools") or []
        names = [t.get("name") for t in tools if isinstance(t, dict) and t.get("name")]
        return json.dumps({"ok": True, "total": res.get("total", len(names)), "tool_names": names,
                           "servers": res.get("servers", [])}, ensure_ascii=False)
    except urllib.error.HTTPError as exc:
        return json.dumps({"ok": False, "error": f"HTTP {exc.code}: {exc.reason}"})
    except Exception as exc:  # noqa: BLE001
        return json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"})


def _tool_defs() -> list[dict]:
    return [
        {
            "name": "agent_run_task",
            "description": (
                "Run ONE full turn of the iEEG co-pilot agent and get back its complete black-box trace: "
                "the final answer it gave the clinician, plus `trajectory` (the ordered list of tools it "
                "called) and `tool_results`. Send a realistic clinician request as `message`. Pass "
                "`recording_path` to tell the agent which EDF the desktop has loaded (it operates on that "
                "recording). Reuse the same `conversation_id` across calls to probe a multi-turn dialogue. "
                "The agent runs autonomously — detection/classification may take minutes. Use this to "
                "evaluate whether the agent did the right thing and answered well."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "message": {"type": "string", "description": "The clinician request / task to send the agent."},
                    "recording_path": {"type": "string", "description": "Absolute path of the EDF the desktop has loaded (the agent's default input)."},
                    "conversation_id": {"type": "string", "description": "Reuse to continue a multi-turn conversation; omit for a fresh one."},
                    "skill_environment": {"type": "string", "description": "'prod' (default) or 'test'."},
                    "ui_state": {"type": "object", "description": "Optional deprecated desktop UI snapshot for compatibility tests; live products should prefer the ieeg-ui MCP broker."},
                    "allowed_mcps": {"type": "array", "items": {"type": "object"}, "description": "Optional MCP server allow-list to expose tools such as ieeg_ui during product evals."},
                    "model": {"type": "string", "description": "Optional model id to force for this turn."},
                    "timeout_seconds": {"type": "number", "description": "Max seconds to wait for the turn (default 600)."},
                },
                "required": ["message"],
            },
        },
        {
            "name": "agent_health",
            "description": "Check that the agent runtime is reachable and ready before evaluating it. Returns liveness + version.",
            "inputSchema": {"type": "object", "properties": {}},
        },
        {
            "name": "agent_list_tools",
            "description": "List the tools the agent advertises (its capability surface) — useful to judge whether it used the tools it should have.",
            "inputSchema": {"type": "object", "properties": {}},
        },
    ]


_DISPATCH = {
    "agent_run_task": tool_agent_run_task,
    "agent_health": tool_agent_health,
    "agent_list_tools": tool_agent_list_tools,
}


# ── MCP JSON-RPC over stdio ───────────────────────────────────────────────────
def _write(msg: dict) -> None:
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def _result(req_id, result) -> None:
    _write({"jsonrpc": "2.0", "id": req_id, "result": result})


def _error(req_id, code, message) -> None:
    _write({"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}})


def handle(msg: dict) -> None:
    method = msg.get("method")
    req_id = msg.get("id")
    is_request = req_id is not None
    if method == "initialize":
        client_proto = (msg.get("params") or {}).get("protocolVersion") or PROTOCOL_VERSION
        _result(req_id, {"protocolVersion": client_proto, "capabilities": {"tools": {"listChanged": False}}, "serverInfo": SERVER_INFO})
        return
    if method in ("notifications/initialized", "initialized", "notifications/cancelled"):
        return  # notifications: no response
    if method == "ping":
        _result(req_id, {})
        return
    if method == "tools/list":
        _result(req_id, {"tools": _tool_defs()})
        return
    if method == "tools/call":
        params = msg.get("params") or {}
        name = params.get("name")
        args = params.get("arguments") or {}
        fn = _DISPATCH.get(name)
        if not fn:
            _error(req_id, -32602, f"unknown tool: {name}")
            return
        try:
            text = fn(args)
            _result(req_id, {"content": [{"type": "text", "text": text}], "isError": False})
        except Exception as exc:  # surface as a tool error, not a transport crash
            _result(req_id, {"content": [{"type": "text", "text": json.dumps({"ok": False, "error": str(exc)})}], "isError": True})
        return
    if is_request:
        _error(req_id, -32601, f"method not found: {method}")


def main() -> int:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            continue
        try:
            handle(msg)
        except Exception as exc:
            sys.stderr.write(f"[ieeg-agent-mcp] handler error: {exc}\n")
            sys.stderr.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
