"""Product-level iEEG agent evaluation helpers.

This module is intentionally model-agnostic: it scores a trace made of
tool_calls, tool_events/tool_results, and final_answer. The same evaluator can
grade deterministic fixtures in CI and real black-box agent runs.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any


HERE = Path(__file__).resolve().parent
DEFAULT_SCENARIOS = HERE / "product_agent_scenarios.json"
MISSING = object()


@dataclass
class EvalResult:
    scenario_id: str
    passed: bool
    failures: list[str]
    warnings: list[str]

    def as_dict(self) -> dict[str, Any]:
        return {
            "scenario_id": self.scenario_id,
            "passed": self.passed,
            "failures": self.failures,
            "warnings": self.warnings,
        }


def load_product_scenarios(path: str | Path = DEFAULT_SCENARIOS) -> dict[str, Any]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if data.get("schema_version") != "product-agent-evals.v1":
        raise ValueError(f"Unsupported product eval schema: {data.get('schema_version')!r}")
    if not isinstance(data.get("scenarios"), list):
        raise ValueError("Product eval file must contain a scenarios list.")
    return data


def _path_get(value: Any, path: str) -> Any:
    current = value
    for raw_part in str(path or "").split("."):
        if not raw_part:
            continue
        if isinstance(current, dict):
            if raw_part not in current:
                return MISSING
            current = current[raw_part]
            continue
        if isinstance(current, list):
            try:
                current = current[int(raw_part)]
            except (ValueError, IndexError):
                return MISSING
            continue
        return MISSING
    return current


def _string_contains(haystack: Any, needle: Any) -> bool:
    return str(needle).lower() in str(haystack).lower()


def _assertion_passes(actual: Any, op: str, expected: Any = None) -> bool:
    if op == "exists":
        return actual is not MISSING
    if op == "missing":
        return actual is MISSING
    if op == "truthy":
        return bool(actual) and actual is not MISSING
    if op == "falsy":
        return actual in (MISSING, None, False, "", [], {})
    if actual is MISSING:
        return False
    if op == "eq":
        return actual == expected
    if op == "neq":
        return actual != expected
    if op == "contains":
        return _string_contains(actual, expected)
    if op == "contains_any":
        return any(_string_contains(actual, item) for item in (expected or []))
    if op == "not_contains_any":
        return not any(_string_contains(actual, item) for item in (expected or []))
    raise ValueError(f"Unsupported assertion op: {op}")


def _tool_calls(trace: dict[str, Any]) -> list[dict[str, Any]]:
    calls = trace.get("tool_calls") or []
    return [call for call in calls if isinstance(call, dict)]


def _tool_events(trace: dict[str, Any]) -> list[dict[str, Any]]:
    events = trace.get("tool_events")
    if isinstance(events, list):
        return [event for event in events if isinstance(event, dict)]
    results = trace.get("tool_results") or {}
    if isinstance(results, dict):
        return [{"name": name, "result": result} for name, result in results.items()]
    return []


def _call_name(call: dict[str, Any]) -> str:
    return str(call.get("name") or "").strip()


def _call_args(call: dict[str, Any]) -> dict[str, Any]:
    args = call.get("args") or call.get("arguments") or call.get("input") or {}
    return args if isinstance(args, dict) else {}


def _ui_type_from_call(call: dict[str, Any]) -> str:
    if _call_name(call) != "emit_ui_command":
        return ""
    return str(_call_args(call).get("type") or "").strip()


def _ui_type_from_event(event: dict[str, Any]) -> str:
    result = event.get("result")
    if not isinstance(result, dict):
        return ""
    command = result.get("command")
    if isinstance(command, dict) and command.get("type"):
        return str(command.get("type"))
    if result.get("command_type"):
        return str(result.get("command_type"))
    ack = result.get("ack")
    if isinstance(ack, dict) and ack.get("command_type"):
        return str(ack.get("command_type"))
    return ""


def _matching_calls(trace: dict[str, Any], tool: str | None = None, ui_type: str | None = None) -> list[dict[str, Any]]:
    matches = []
    for call in _tool_calls(trace):
        if tool and _call_name(call) != tool:
            continue
        if ui_type and _ui_type_from_call(call) != ui_type:
            continue
        matches.append(call)
    return matches


def _matching_events(trace: dict[str, Any], tool: str | None = None, ui_type: str | None = None) -> list[dict[str, Any]]:
    matches = []
    for event in _tool_events(trace):
        if tool and str(event.get("name") or "") != tool:
            continue
        if ui_type and _ui_type_from_event(event) != ui_type:
            continue
        matches.append(event)
    return matches


def _first_call_index(trace: dict[str, Any], tool: str | None = None, ui_type: str | None = None) -> int | None:
    for index, call in enumerate(_tool_calls(trace)):
        if tool and _call_name(call) != tool:
            continue
        if ui_type and _ui_type_from_call(call) != ui_type:
            continue
        return index
    return None


def _has_call_after(trace: dict[str, Any], index: int, tool: str) -> bool:
    for later in _tool_calls(trace)[index + 1 :]:
        if _call_name(later) == tool:
            return True
    return False


def _format_actual(actual: Any) -> str:
    if actual is MISSING:
        return "<missing>"
    return repr(actual)


def _score_tool_expectations(expect: dict[str, Any], trace: dict[str, Any], failures: list[str]) -> None:
    call_names = [_call_name(call) for call in _tool_calls(trace)]
    for tool in expect.get("required_tools") or []:
        if tool not in call_names:
            failures.append(f"required tool {tool!r} was not called")
    for tool in expect.get("forbidden_tools") or []:
        if tool in call_names:
            failures.append(f"forbidden tool {tool!r} was called")

    order = list(expect.get("required_order") or [])
    cursor = 0
    for tool in order:
        try:
            found = call_names.index(tool, cursor)
        except ValueError:
            failures.append(f"required tool order missing {tool!r} after position {cursor}")
            return
        cursor = found + 1


def _score_ui_expectations(expect: dict[str, Any], trace: dict[str, Any], failures: list[str]) -> None:
    ui_types = [_ui_type_from_call(call) for call in _tool_calls(trace) if _ui_type_from_call(call)]
    for command_type in expect.get("required_ui_commands") or []:
        if command_type not in ui_types:
            failures.append(f"required UI command {command_type!r} was not emitted")
    any_required = expect.get("required_ui_commands_any") or []
    if any_required and not any(command_type in ui_types for command_type in any_required):
        failures.append(f"none of the acceptable UI commands were emitted: {any_required!r}")
    for command_type in expect.get("forbidden_ui_commands") or []:
        if command_type in ui_types:
            failures.append(f"forbidden UI command {command_type!r} was emitted")
    for command_type in expect.get("wait_after_ui_commands") or []:
        emit_index = _first_call_index(trace, tool="emit_ui_command", ui_type=command_type)
        if emit_index is None:
            failures.append(f"cannot verify wait: UI command {command_type!r} was not emitted")
            continue
        if not _has_call_after(trace, emit_index, "wait_for_ui_command"):
            failures.append(f"UI command {command_type!r} was not followed by wait_for_ui_command")


def _score_payload_assertions(expect: dict[str, Any], trace: dict[str, Any], failures: list[str]) -> None:
    for assertion in expect.get("payload_assertions") or []:
        tool = assertion.get("tool")
        ui_type = assertion.get("ui_type")
        matches = _matching_calls(trace, tool=tool, ui_type=ui_type)
        label = f"{tool or '*'}:{ui_type or '*'} {assertion.get('path')}"
        if not matches:
            failures.append(f"payload assertion has no matching call for {label}")
            continue
        actual = _path_get(matches[0], assertion.get("path") or "")
        op = assertion.get("op") or "eq"
        expected = assertion.get("value")
        if not _assertion_passes(actual, op, expected):
            failures.append(f"payload assertion failed for {label}: expected {op} {expected!r}, got {_format_actual(actual)}")


def _score_result_assertions(expect: dict[str, Any], trace: dict[str, Any], failures: list[str]) -> None:
    for assertion in expect.get("result_assertions") or []:
        tool = assertion.get("tool")
        ui_type = assertion.get("ui_type")
        matches = _matching_events(trace, tool=tool, ui_type=ui_type)
        label = f"{tool or '*'}:{ui_type or '*'} {assertion.get('path')}"
        if not matches:
            failures.append(f"result assertion has no matching event for {label}")
            continue
        actual = _path_get(matches[0], assertion.get("path") or "")
        op = assertion.get("op") or "eq"
        expected = assertion.get("value")
        if not _assertion_passes(actual, op, expected):
            failures.append(f"result assertion failed for {label}: expected {op} {expected!r}, got {_format_actual(actual)}")


def _score_final_answer(expect: dict[str, Any], trace: dict[str, Any], failures: list[str]) -> None:
    rule = expect.get("final_answer") or {}
    answer = str(trace.get("final_answer") or "")
    lowered = answer.lower()
    for phrase in rule.get("must_include_all") or []:
        if str(phrase).lower() not in lowered:
            failures.append(f"final answer missing required phrase {phrase!r}")
    any_phrases = list(rule.get("must_include_any") or [])
    if any_phrases and not any(str(phrase).lower() in lowered for phrase in any_phrases):
        failures.append(f"final answer missing any acceptable phrase from {any_phrases!r}")
    for phrase in rule.get("must_not_include_any") or []:
        if str(phrase).lower() in lowered:
            failures.append(f"final answer contains forbidden phrase {phrase!r}")


def evaluate_trace(scenario: dict[str, Any], trace: dict[str, Any]) -> EvalResult:
    failures: list[str] = []
    warnings: list[str] = []
    expect = scenario.get("expect") or {}
    _score_tool_expectations(expect, trace, failures)
    _score_ui_expectations(expect, trace, failures)
    _score_payload_assertions(expect, trace, failures)
    _score_result_assertions(expect, trace, failures)
    _score_final_answer(expect, trace, failures)
    return EvalResult(
        scenario_id=str(scenario.get("id") or ""),
        passed=not failures,
        failures=failures,
        warnings=warnings,
    )


def evaluate_fixture_scenarios(data: dict[str, Any]) -> list[EvalResult]:
    results: list[EvalResult] = []
    for scenario in data.get("scenarios") or []:
        fixture = scenario.get("fixture_trace")
        if not isinstance(fixture, dict):
            results.append(EvalResult(str(scenario.get("id") or ""), False, ["missing fixture_trace"], []))
            continue
        results.append(evaluate_trace(scenario, fixture))
    return results


def summarize_results(results: list[EvalResult]) -> dict[str, Any]:
    passed = sum(1 for result in results if result.passed)
    return {
        "passed": passed,
        "total": len(results),
        "failed": len(results) - passed,
        "failures": [result.as_dict() for result in results if not result.passed],
    }
