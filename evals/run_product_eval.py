#!/usr/bin/env python3
"""Run product-level iEEG agent evaluations.

Modes:
  fixture  - deterministic CI mode; scores fixture traces from product_agent_scenarios.json.
  blackbox - real-agent mode; sends scenarios to the agent MCP connector and scores the trace.

Examples:
  python -m evals.run_product_eval --mode fixture
  python -m evals.run_product_eval --mode blackbox --filter desktop-ambiguous --timeout 120
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from evals.product_agent_eval import (
    DEFAULT_SCENARIOS,
    evaluate_fixture_scenarios,
    evaluate_trace,
    load_product_scenarios,
)


DEFAULT_UI_MCP = [{"name": "ieeg-ui", "server_id": "ieeg_ui", "capabilities": ["tools"]}]


def _matches_filter(scenario: dict[str, Any], flt: str) -> bool:
    if not flt:
        return True
    needles = [item.strip() for item in flt.split(",") if item.strip()]
    haystack = f"{scenario.get('id', '')} {scenario.get('surface', '')} {scenario.get('user', '')}"
    return any(needle in haystack for needle in needles)


def _required_agent_tools(scenario: dict[str, Any]) -> set[str]:
    expect = scenario.get("expect") or {}
    required = set(expect.get("required_tools") or [])
    for command_type in expect.get("required_ui_commands") or []:
        if command_type:
            required.add("emit_ui_command")
    for command_type in expect.get("required_ui_commands_any") or []:
        if command_type:
            required.add("emit_ui_command")
    for command_type in expect.get("wait_after_ui_commands") or []:
        if command_type:
            required.add("wait_for_ui_command")
    return required


def run_fixture(data: dict[str, Any], flt: str) -> list[dict[str, Any]]:
    scenarios = [scenario for scenario in data["scenarios"] if _matches_filter(scenario, flt)]
    fixture_data = {**data, "scenarios": scenarios}
    return [result.as_dict() for result in evaluate_fixture_scenarios(fixture_data)]


def run_blackbox(data: dict[str, Any], flt: str, model: str | None, timeout: float, include_tool_boundary: bool) -> list[dict[str, Any]]:
    from evals.blackbox.mcp_client import AgentMcpClient

    scenarios = [
        scenario
        for scenario in data["scenarios"]
        if _matches_filter(scenario, flt)
        and bool(scenario.get("run_real_model"))
        and (include_tool_boundary or scenario.get("surface") != "tool_boundary")
    ]
    results: list[dict[str, Any]] = []
    with AgentMcpClient(read_timeout=timeout + 60) as client:
        health = client.health()
        if not health.get("ok"):
            raise SystemExit(f"Agent runtime is not reachable: {json.dumps(health, ensure_ascii=False)[:300]}")
        tools_info = client.agent_tools()
        available_tools = set(tools_info.get("tool_names") or [])
        for scenario in scenarios:
            required = _required_agent_tools(scenario)
            missing_tools = sorted(required - available_tools)
            if missing_tools:
                results.append({
                    "scenario_id": scenario["id"],
                    "passed": False,
                    "skipped": True,
                    "failures": [f"missing required agent tools: {missing_tools}"],
                    "warnings": [],
                })
                continue
            res = client.run_task(
                scenario["user"],
                conversation_id=f"product-{scenario['id']}",
                recording_path=scenario.get("recording_path") or data.get("default_recording_path"),
                ui_state=scenario.get("ui_state"),
                allowed_mcps=DEFAULT_UI_MCP if scenario.get("surface") == "desktop_copilot" else [],
                model=model,
                timeout_seconds=timeout,
            )
            trace = {
                "tool_calls": res.get("tool_calls") or [],
                "tool_events": res.get("tool_events") or [],
                "tool_results": res.get("tool_results") or {},
                "final_answer": res.get("final_answer") or "",
            }
            scored = evaluate_trace(scenario, trace).as_dict()
            scored["trajectory"] = res.get("trajectory") or []
            scored["final_answer_preview"] = (res.get("final_answer") or "")[:500]
            scored["agent_error"] = res.get("error")
            results.append(scored)
    return results


def _summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    passed = sum(1 for row in rows if row.get("passed") is True)
    failures = [row for row in rows if row.get("passed") is not True]
    skipped = sum(1 for row in rows if row.get("skipped") is True)
    return {"passed": passed, "total": len(rows), "failed": len(rows) - passed, "skipped": skipped, "failures": failures}


def main() -> int:
    parser = argparse.ArgumentParser(description="Run product-level iEEG agent evaluations.")
    parser.add_argument("--mode", choices=["fixture", "blackbox"], default="fixture")
    parser.add_argument("--scenarios", default=str(DEFAULT_SCENARIOS))
    parser.add_argument("--filter", default="")
    parser.add_argument("--model", default=None)
    parser.add_argument("--timeout", type=float, default=180.0)
    parser.add_argument("--include-tool-boundary", action="store_true", help="Run tool_boundary scenarios in blackbox mode when requested.")
    parser.add_argument("--out", default="")
    args = parser.parse_args()

    data = load_product_scenarios(args.scenarios)
    if args.mode == "fixture":
        rows = run_fixture(data, args.filter)
    else:
        rows = run_blackbox(data, args.filter, args.model, args.timeout, args.include_tool_boundary)

    summary = _summary(rows)
    report = {"mode": args.mode, "summary": summary, "results": rows}
    text = json.dumps(report, ensure_ascii=False, indent=2)
    print(text)
    if args.out:
        Path(args.out).write_text(text + "\n", encoding="utf-8")
    return 0 if summary["failed"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
