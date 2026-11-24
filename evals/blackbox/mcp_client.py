#!/usr/bin/env python3
"""Tiny zero-dependency MCP stdio client used by the black-box eval harness and the agentic tester.

It spawns an MCP server as a subprocess (by default the agent connector, ``agent_mcp_server.py``) and
speaks MCP JSON-RPC 2.0 over its stdin/stdout. This is the ONLY way the eval reaches the agent — no
``runtime.*`` imports — so the agent under test can live on another machine (set IEEG_AGENT_BASE_URL in
``env``). A background thread drains stderr so a long-running tool call can't deadlock on a full pipe.

    from evals.blackbox.mcp_client import AgentMcpClient
    with AgentMcpClient(env={"IEEG_AGENT_BASE_URL": "http://remote:8001"}) as agent:
        print(agent.health())
        res = agent.run_task("Detect HFOs and rank channels", recording_path="/data/sub-01_ieeg.edf")
        print(res["trajectory"], res["final_answer"])
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any, Optional

HERE = Path(__file__).resolve().parent
DEFAULT_SERVER = HERE / "agent_mcp_server.py"


class AgentMcpClient:
    """MCP stdio client. Context-manager: spawns the server on enter, tears it down on exit."""

    def __init__(self, command: Optional[list[str]] = None, env: Optional[dict] = None,
                 server_path: Optional[Path] = None, read_timeout: float = 900.0):
        self.command = command or [sys.executable, str(server_path or DEFAULT_SERVER)]
        self.env = {**os.environ, **(env or {})}
        self.read_timeout = read_timeout
        self.proc: Optional[subprocess.Popen] = None
        self._id = 0
        self._stderr_tail: list[str] = []

    # -- lifecycle --------------------------------------------------------------
    def __enter__(self) -> "AgentMcpClient":
        self.start()
        return self

    def __exit__(self, *_exc) -> None:
        self.stop()

    def start(self) -> None:
        self.proc = subprocess.Popen(
            self.command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, env=self.env, bufsize=1,
        )
        threading.Thread(target=self._drain_stderr, daemon=True).start()
        self._rpc({"jsonrpc": "2.0", "id": self._next(), "method": "initialize",
                   "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                              "clientInfo": {"name": "blackbox-eval", "version": "0"}}})
        self._notify({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def stop(self) -> None:
        if not self.proc:
            return
        try:
            self.proc.stdin.close()  # type: ignore[union-attr]
        except Exception:
            pass
        self.proc.terminate()
        try:
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()
        self.proc = None

    # -- JSON-RPC ---------------------------------------------------------------
    def _next(self) -> int:
        self._id += 1
        return self._id

    def _drain_stderr(self) -> None:
        assert self.proc and self.proc.stderr
        for line in self.proc.stderr:
            self._stderr_tail.append(line.rstrip("\n"))
            del self._stderr_tail[:-50]  # keep only the last 50 lines

    def _notify(self, obj: dict) -> None:
        assert self.proc and self.proc.stdin
        self.proc.stdin.write(json.dumps(obj) + "\n")
        self.proc.stdin.flush()

    def _rpc(self, obj: dict) -> dict:
        assert self.proc and self.proc.stdin and self.proc.stdout
        self.proc.stdin.write(json.dumps(obj) + "\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            tail = "\n".join(self._stderr_tail[-10:])
            raise RuntimeError(f"MCP server closed the connection. stderr:\n{tail}")
        return json.loads(line)

    # -- high-level helpers -----------------------------------------------------
    def list_tools(self) -> list[dict]:
        return self._rpc({"jsonrpc": "2.0", "id": self._next(), "method": "tools/list"}).get("result", {}).get("tools", [])

    def call(self, name: str, arguments: Optional[dict] = None) -> Any:
        resp = self._rpc({"jsonrpc": "2.0", "id": self._next(), "method": "tools/call",
                          "params": {"name": name, "arguments": arguments or {}}})
        if "error" in resp:
            return {"ok": False, "error": resp["error"].get("message", "rpc error")}
        content = (resp.get("result", {}).get("content") or [{}])[0].get("text", "")
        try:
            return json.loads(content)
        except Exception:
            return {"_raw": content}

    def run_task(self, message: str, **kwargs) -> dict:
        return self.call("agent_run_task", {"message": message, **kwargs})

    def health(self) -> dict:
        return self.call("agent_health", {})

    def agent_tools(self) -> dict:
        return self.call("agent_list_tools", {})
