#!/usr/bin/env python3
"""End-to-end self-test for the iEEG UI MCP connector (zero-dep, no model, deterministic).

Proves the full round-trip an external agent uses to drive the UI:
  Claude(MCP stdio) -> emit_ui_command -> broker queue -> renderer drains (GET /ui/commands)
  renderer reports ui_state (POST /ui/state) -> Claude(MCP) get_ui_state sees it (image stripped)
  renderer reports ui ack (POST /ui/ack) -> Claude(MCP) wait_for_ui_command sees callback status

Run:  python ui_mcp/selftest.py   (from the repo root)
"""
import json
import socket
import subprocess
import sys
import threading
from pathlib import Path
from urllib.request import Request, urlopen

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from ui_mcp.broker import UiBus, make_handler  # noqa: E402
from http.server import ThreadingHTTPServer  # noqa: E402

results = []
TEST_BROKER_TOKEN = "ieeg-ui-selftest-token"


def check(name, ok, note=""):
    results.append((name, ok, note))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{(' — ' + note) if note else ''}")


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


def http_json(method, url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = Request(url, data=data, method=method, headers={
        "content-type": "application/json",
        "authorization": f"Bearer {TEST_BROKER_TOKEN}",
    })
    with urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode() or "{}")


def main():
    port = free_port()
    bus = UiBus()
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(bus, TEST_BROKER_TOKEN))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{port}"
    check("broker boots", http_json("GET", f"{base}/health").get("status") == "ok")

    # Spawn the stdio MCP server pointed at this broker.
    proc = subprocess.Popen(
        [sys.executable, str(HERE / "mcp_server.py")],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        # Short ack-poll budget: this self-test has no renderer to ack, so emit_ui_command would
        # otherwise wait the full live budget for an outcome that never comes.
        text=True, env={
            **__import__("os").environ,
            "IEEG_UI_BROKER_URL": base,
            "IEEG_UI_BROKER_TOKEN": TEST_BROKER_TOKEN,
            "IEEG_UI_ACK_POLL_BUDGET_MS": "150",
        },
    )

    def rpc(obj, expect_response=True):
        proc.stdin.write(json.dumps(obj) + "\n"); proc.stdin.flush()
        if not expect_response:
            return None
        line = proc.stdout.readline()
        return json.loads(line) if line.strip() else None

    try:
        # 1) initialize handshake
        init = rpc({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "selftest", "version": "0"}}})
        check("initialize handshake", bool(init) and init.get("result", {}).get("serverInfo", {}).get("name") == "ieeg-ui",
              f"serverInfo={init.get('result', {}).get('serverInfo') if init else None}")
        rpc({"jsonrpc": "2.0", "method": "notifications/initialized"}, expect_response=False)

        # 2) tools/list exposes UI tools + emit enum has valid types (not invented ones)
        tl = rpc({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        tools = {t["name"]: t for t in tl.get("result", {}).get("tools", [])}
        check("tools/list exposes UI tools", {"emit_ui_command", "get_ui_state", "wait_for_ui_command", "inspect_waveform"} <= set(tools),
              f"names={sorted(tools)}")
        check("search_tools advertised", "search_tools" in tools, f"names={sorted(tools)}")
        enum = tools.get("emit_ui_command", {}).get("inputSchema", {}).get("properties", {}).get("type", {}).get("enum", [])
        check("emit type enum is catalog-backed", "waveform.set_viewport" in enum and "agent.set_viewport" not in enum,
              f"{len(enum)} types")
        emit_description = tools.get("emit_ui_command", {}).get("description", "")
        check("emit description includes command playbook",
              "detection.focus_top_candidate_channel" in emit_description and "detector_params" in emit_description,
              emit_description[:160])

        # 3) emit_ui_command (view) -> broker queue
        call = rpc({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "emit_ui_command", "arguments": {"type": "waveform.set_viewport", "payload": {"start_seconds": 30, "duration_seconds": 5}, "reason": "test"}}})
        emit_text = json.loads(call["result"]["content"][0]["text"])
        check("emit_ui_command accepted (view, not staged)", emit_text.get("success") is True and emit_text.get("staged") is False,
              json.dumps(emit_text)[:120])

        # 4) renderer drains the queued command (the UI would now move)
        drained = http_json("GET", f"{base}/ui/commands").get("commands", [])
        ok_drain = len(drained) == 1 and drained[0]["type"] == "waveform.set_viewport" and drained[0]["payload"]["start_seconds"] == 30
        check("renderer drains the command (UI would move)", ok_drain, json.dumps(drained)[:140])

        # 5) emit a WRITE command -> must be staged for human Apply
        call2 = rpc({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "emit_ui_command", "arguments": {"type": "detection.run", "payload": {"biomarker": "HFO", "detector": "STE", "confirmed_defaults": True}, "reason": "test"}}})
        emit2 = json.loads(call2["result"]["content"][0]["text"])
        check("write command is STAGED (requires_confirmation)", emit2.get("success") is True and emit2.get("staged") is True and emit2.get("requires_completion_callback") is True)

        command_id = emit2.get("command", {}).get("command_id")
        http_json("POST", f"{base}/ui/ack", {"command_id": command_id, "outcome": {"status": "staged", "command_type": "detection.run"}})
        wait = rpc({"jsonrpc": "2.0", "id": 41, "method": "tools/call", "params": {"name": "wait_for_ui_command", "arguments": {"command_id": command_id, "timeout_seconds": 0}}})
        wait_text = json.loads(wait["result"]["content"][0]["text"])
        check("wait_for_ui_command returns staged callback", wait_text.get("success") is True and wait_text.get("terminal") is False and wait_text.get("ack", {}).get("status") == "staged",
              json.dumps(wait_text)[:160])

        # 6) invalid command type rejected (no inventing)
        call3 = rpc({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "emit_ui_command", "arguments": {"type": "agent.set_viewport", "payload": {}}}})
        emit3 = json.loads(call3["result"]["content"][0]["text"])
        check("invalid command type rejected", emit3.get("success") is False and "unknown ui command" in emit3.get("error", ""))

        # 7) renderer reports ui_state -> MCP get_ui_state sees it, with base64 image stripped
        http_json("POST", f"{base}/ui/state", {"ui_state": {"viewport": {"start_seconds": 30}, "channels": ["A1", "A2"], "waveform_image": "data:image/png;base64,BIG"}})
        gs = rpc({"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "get_ui_state", "arguments": {}}})
        state = json.loads(gs["result"]["content"][0]["text"])
        check("get_ui_state returns live state, strips image", state.get("waveform_image_available") is True and "waveform_image" not in state and state.get("channels") == ["A1", "A2"])

        # 8) search_tools discovers catalog commands by intent (the progressive-disclosure path)
        st = rpc({"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": "search_tools", "arguments": {"query": "run STE detection", "limit": 5}}})
        st_res = json.loads(st["result"]["content"][0]["text"])
        st_types = [t.get("type") for t in st_res.get("tools", [])]
        check("search_tools surfaces a relevant command", "detection.run" in st_types and st_res.get("count", 0) >= 1, f"types={st_types}")
        check("search_tools cards carry risk/staged/payload",
              bool(st_res.get("tools")) and all(("risk" in t and "staged" in t and "required_payload" in t) for t in st_res["tools"]))

        # 9) synonym ranking — clinician-phrased goals find the right command (not just literal type words)
        def search_top_types(query, n=5):
            r = rpc({"jsonrpc": "2.0", "id": 70, "method": "tools/call", "params": {"name": "search_tools", "arguments": {"query": query, "limit": n}}})
            return [t.get("type") for t in json.loads(r["result"]["content"][0]["text"]).get("tools", [])]
        ann = search_top_types("label this event as an artifact")
        check("synonym search: annotate intent -> events.stage_annotation (TOP-1, not classification.run)",
              ann[:1] == ["events.stage_annotation"], f"top={ann}")
        prep = search_top_types("clean and notch filter the recording")
        check("synonym search: preprocess intent -> analysis.prepare_recording", "analysis.prepare_recording" in prep, f"top={prep}")
        # 9b) routing regressions found in the 2026-06-09 audit — an intent must not escalate to a heavier/wrong command
        spike = search_top_types("turn on the spike sub-classifier")
        check("set intent stays a view write: spike sub-classifier -> classification.set_parameters (not .run)",
              spike[:1] == ["classification.set_parameters"], f"top={spike}")
        nav = search_top_types("go to 30 seconds")
        check("nav intent -> waveform.set_viewport (not center_event)", nav[:1] == ["waveform.set_viewport"], f"top={nav}")
        setp = search_top_types("Set the detection filter band to fp 80 and fs 250, set the line-noise notch to 60 Hz")
        check("set-params intent -> detection.set_parameters TOP-1 (the original hang)", setp[:1] == ["detection.set_parameters"], f"top={setp}")
        for iq in ("show the filtered trace", "show a toast"):
            leaked = [t for t in search_top_types(iq, 8) if t in ("agent.show_trace_step", "workspace.show_toast")]
            check(f"internal commands excluded from search ({iq!r})", not leaked, f"leaked={leaked}")

        # 9c) doctor-prompt-catalog fixes (2026-06-15): detection.run usage gained a "surface the existing run"
        # state branch (+ fast-ripple Nyquist note). Lock that the added prose did NOT pull rank/show queries
        # onto detection.run, while bare detect-verbs still route to it; and that migrated commands stay findable.
        for dq in ("find the ripples", "detect all HFOs", "I want all ripples"):
            check(f"detect-verb still routes to detection.run ({dq!r})",
                  search_top_types(dq)[:1] == ["detection.run"], f"top={search_top_types(dq)}")
        for sq in ("show me the channel with the most ripples", "which channel has the most HFOs", "show the busiest channel"):
            top = search_top_types(sq)[0]
            check(f"surface-existing stays a view cmd, not a re-run ({sq!r})",
                  top in ("detection.focus_top_candidate_channel", "waveform.focus_hotspot_channels"), f"top={top}")
        rankq = search_top_types("rank the candidate channels")
        check("rank intent -> a ranking command, not detection.run",
              rankq[:1] in (["detection.rank_candidates"], ["detection.show_candidate_ranking"]), f"top={rankq}")
        for mq, want in (("combine the runs into a consensus", "detection.create_consensus_run"),
                         ("group the simultaneous events", "review.group_overlaps"),
                         ("save the project", "project.save")):
            check(f"migrated command discoverable ({mq!r} -> {want})",
                  search_top_types(mq)[:1] == [want], f"top={search_top_types(mq)}")

        # 10) list_tool_categories — browse fallback
        check("list_tool_categories advertised", "list_tool_categories" in tools, f"names={sorted(tools)}")
        lc = rpc({"jsonrpc": "2.0", "id": 71, "method": "tools/call", "params": {"name": "list_tool_categories", "arguments": {}}})
        lc_res = json.loads(lc["result"]["content"][0]["text"])
        cats = {c.get("category") for c in lc_res.get("categories", [])}
        check("list_tool_categories returns namespaces", {"detection", "review", "analysis"} <= cats and lc_res.get("total", 0) >= len(cats), f"cats={sorted(cats)}")

        npass = sum(1 for _, ok, _ in results if ok)
        print(f"\n=== UI MCP connector self-test: {npass}/{len(results)} PASS ===")
        return 0 if npass == len(results) else 1
    finally:
        proc.terminate()
        try:
            err = proc.stderr.read()
            if err.strip():
                print("--- mcp_server stderr ---\n" + err[:800])
        except Exception:
            pass
        server.shutdown()


if __name__ == "__main__":
    raise SystemExit(main())
