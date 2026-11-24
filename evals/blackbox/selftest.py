#!/usr/bin/env python3
"""Deterministic self-test for the agent-as-MCP connector (zero-dep, no model, no real agent).

Proves the full black-box round-trip an external evaluator uses to drive the agent:
  evaluator(MCP stdio) -> agent_run_task -> agent_mcp_server -> HTTP/SSE -> agent runtime
  the parsed trajectory + tool_results feed the EXISTING objective scorers (extract_candidates / reward)
It also proves the bearer auth is enforced (wrong token -> HTTP 401), i.e. the remote seam is real.

A fake agent runtime (bearer-gated, scripted SSE) stands in for the real one, so this runs in CI.

Run:  python evals/blackbox/selftest.py   (from the repo root)
"""
import json
import os
import socket
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
sys.path.insert(0, str(REPO_ROOT))

from evals.blackbox.mcp_client import AgentMcpClient  # noqa: E402
from evals.blackbox import run_blackbox_eval as bbe  # noqa: E402
from evals.optimize.reward import SozGold, score_candidates  # noqa: E402
from evals.optimize.run_outcome_eval import extract_candidates  # noqa: E402

TOKEN = "selftest-token"
API_PREFIX = "/internal/agent/v1"
CONTRACT_VERSION = "ieeg-agent.v1"

# A scripted agent run: inspect -> rank -> answer. Mirrors the (event, data) shapes stream_message yields.
SSE_SCRIPT = [
    ("status", {"message": "starting"}),
    ("tool_call", {"name": "pyhfo_get_recording_info", "args": {}}),
    ("tool_result", {"name": "pyhfo_get_recording_info", "result": {"sampling_rate": 2000, "n_channels": 3}}),
    ("tool_call", {"name": "pyhfo_rank_candidate_channels", "args": {"biomarker": "HFO"}}),
    ("tool_result", {"name": "pyhfo_rank_candidate_channels", "result": {
        "ranked_channels": [{"channel": "A1", "rate": 5.0}, {"channel": "B2", "rate": 3.0}, {"channel": "C3", "rate": 0.5}]}}),
    ("content", {"text": "Top candidate channels by HFO rate: A1, B2 (signal-derived candidates, not a clinical SOZ claim)."}),
    ("done", {"model_used": "fake-model", "active_skill": "pyhfo-detection", "sources": []}),
]

results = []


def check(name, ok, note=""):
    results.append((name, ok, note))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{(' — ' + note) if note else ''}")


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


def make_fake_agent(captured: dict):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def _authed(self) -> bool:
            if (
                self.headers.get("Authorization") == f"Bearer {TOKEN}"
                and self.headers.get("X-Contract-Version") == CONTRACT_VERSION
            ):
                return True
            self.send_response(401); self.send_header("Content-Length", "0"); self.end_headers()
            return False

        def _json(self, obj):
            body = json.dumps(obj).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if not self._authed():
                return
            if self.path == f"{API_PREFIX}/health":
                self._json({"status": "healthy"})
            elif self.path == f"{API_PREFIX}/version":
                self._json({"version": "1.0.0", "contract_version": "v1"})
            else:
                self.send_response(404); self.send_header("Content-Length", "0"); self.end_headers()

        def do_POST(self):
            if not self._authed():
                return
            length = int(self.headers.get("Content-Length", 0) or 0)
            body = json.loads(self.rfile.read(length) or "{}") if length else {}
            if self.path == f"{API_PREFIX}/tools":
                self._json({"status": "success", "total": 1, "servers": ["builtin_pyhfo"],
                            "tools": [{"name": "pyhfo_detect_events", "description": "detect", "inputSchema": {}, "mcp_server": "builtin_pyhfo"}]})
                return
            if self.path == f"{API_PREFIX}/chat/stream":
                captured["body"] = body  # let the test assert recording_path was forwarded
                captured["contract_version"] = self.headers.get("X-Contract-Version")
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()  # HTTP/1.0 + connection close delimits the SSE body
                for sequence, (event, data) in enumerate(SSE_SCRIPT):
                    envelope = {
                        "contract_version": CONTRACT_VERSION,
                        "request_id": str(body.get("request_id") or "selftest-request"),
                        "conversation_id": str(body.get("conversation_id") or "selftest-conversation"),
                        "sequence": sequence,
                        "event": event,
                        "visibility": "internal" if event in {"tool_call", "tool_result"} else "public",
                        "data": data,
                    }
                    self.wfile.write(f"event: {event}\ndata: {json.dumps(envelope)}\n\n".encode())
                    self.wfile.flush()
                return
            self.send_response(404); self.send_header("Content-Length", "0"); self.end_headers()

    return Handler


def main():
    port = free_port()
    captured: dict = {}
    server = ThreadingHTTPServer(("127.0.0.1", port), make_fake_agent(captured))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{port}"
    good_env = {"IEEG_AGENT_BASE_URL": base, "IEEG_AGENT_SERVICE_TOKEN": TOKEN}

    try:
        # 0) the harness drives the agent purely over MCP — importing it must NOT pull `runtime` (else it
        #    couldn't run against a remote agent whose code isn't present locally).
        check("harness import does NOT pull runtime (remote-capable)", "runtime" not in sys.modules,
              f"runtime_in_sys_modules={'runtime' in sys.modules}")

        with AgentMcpClient(env=good_env) as agent:
            # 1) tools/list exposes the three agent-control tools
            tools = {t["name"] for t in agent.list_tools()}
            check("tools/list exposes agent tools", {"agent_run_task", "agent_health", "agent_list_tools"} <= tools,
                  f"names={sorted(tools)}")

            # 2) health round-trips
            h = agent.health()
            check("agent_health reports reachable", h.get("ok") is True and h.get("health", {}).get("status") == "healthy",
                  json.dumps(h)[:120])

            # 3) capability surface
            lt = agent.agent_tools()
            check("agent_list_tools returns capability surface", lt.get("ok") is True and "pyhfo_detect_events" in (lt.get("tool_names") or []),
                  json.dumps(lt)[:120])

            # 4) run a full turn -> complete black-box trace
            res = agent.run_task("Detect HFOs and rank the candidate channels.", recording_path="/data/sub-01_ieeg.edf")
            check("agent_run_task succeeds", res.get("ok") is True and not res.get("error"), json.dumps(res.get("error"))[:120])
            check("trajectory captured in order",
                  res.get("trajectory") == ["pyhfo_get_recording_info", "pyhfo_rank_candidate_channels"],
                  f"trajectory={res.get('trajectory')}")
            check("final answer captured", "A1" in (res.get("final_answer") or ""), (res.get("final_answer") or "")[:80])
            check("recording_path forwarded to agent", captured.get("body", {}).get("recording_path") == "/data/sub-01_ieeg.edf",
                  json.dumps(captured.get("body", {}).get("recording_path")))
            check("contract version header forwarded to agent", captured.get("contract_version") == CONTRACT_VERSION,
                  str(captured.get("contract_version")))

            # 5) the MCP-derived trace feeds the EXISTING objective scorers unchanged
            cands, source = extract_candidates(res.get("tool_results") or {}, res.get("final_answer") or "", ["A1", "B2", "C3"])
            check("extract_candidates parses MCP trace", cands == ["A1", "B2", "C3"] and source == "rank_tool_result",
                  f"cands={cands} source={source}")
            gold = SozGold(recording_path="x", channels_tsv=None, all_channels=["A1", "B2", "C3"], soz=["A1", "B2"])
            scored = score_candidates(cands, gold, top_k=2)
            check("reward computes on MCP candidates", scored.get("reward") == 1.0, f"reward={scored.get('reward')}")

            # 5b) the objective harness's trajectory loop actually drives turns over MCP and assembles a
            #     report (judge disabled so it stays offline; the fake returns the same canned trajectory).
            os.environ["IEEG_JUDGE_DISABLE"] = "1"
            first_id = json.loads((REPO_ROOT / "evals" / "ieeg_doctor_scenarios.json").read_text(encoding="utf-8"))["scenarios"][0]["id"]
            import contextlib
            import io
            with contextlib.redirect_stdout(io.StringIO()):  # the harness's per-turn prints (the fake fails gold) are noise here
                traj = bbe.run_trajectory(agent, flt=first_id, runs=1, model=None, timeout=30)
            check("trajectory harness drives turns over MCP", traj.get("mode") == "trajectory"
                  and len(traj.get("scenarios") or []) == 1 and isinstance(traj["scenarios"][0].get("runs"), list),
                  f"turn_pass_rate={traj.get('turn_pass_rate')}")

        # 6) bearer auth is enforced — wrong token cannot drive the agent (remote seam is real)
        with AgentMcpClient(env={**good_env, "IEEG_AGENT_SERVICE_TOKEN": "wrong-token"}) as bad:
            res = bad.run_task("should be rejected")
            check("wrong bearer token is rejected (401)", res.get("ok") is False and "401" in (res.get("error") or ""),
                  json.dumps(res.get("error"))[:120])

        npass = sum(1 for _, ok, _ in results if ok)
        print(f"\n=== agent-as-MCP self-test: {npass}/{len(results)} PASS ===")
        return 0 if npass == len(results) else 1
    finally:
        server.shutdown()


if __name__ == "__main__":
    raise SystemExit(main())
