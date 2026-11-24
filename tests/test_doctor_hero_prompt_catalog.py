from __future__ import annotations

import json
import sys
from pathlib import Path

from runtime.agent_runtime import pyhfo_tools


CATALOG_PATH = Path(__file__).resolve().parent / "fixtures" / "doctor_hero_prompts.json"
MATRIX_PATH = Path(__file__).resolve().parents[1] / "docs" / "doctor-hero-capability-matrix.md"
PYHFO_APP_ROOT = Path(__file__).resolve().parents[1] / "pyhfo" / "src"
if str(PYHFO_APP_ROOT) not in sys.path:
    sys.path.insert(0, str(PYHFO_APP_ROOT))

from pyhfo.agent_api.sidecar import get_capability_manifest  # noqa: E402

# Review/UI-facing capabilities are reached through the ieeg_ui MCP server rather than
# the in-process pyhfo CLI tools, so they are not in pyhfo_tools.get_tool_definitions().
UI_MCP_TOOLS = {"emit_ui_command", "get_ui_state", "wait_for_ui_command", "inspect_waveform"}


def _catalog() -> dict:
    return json.loads(CATALOG_PATH.read_text(encoding="utf-8"))


def test_doctor_hero_prompt_catalog_has_30_long_doctor_cases():
    catalog = _catalog()
    prompts = catalog["prompts"]

    assert catalog["schema_version"] == "doctor-hero-prompts.v1"
    assert len(prompts) == 30
    assert len({case["id"] for case in prompts}) == 30

    allowed_statuses = set(catalog["allowed_statuses"])
    known_tools = {tool["function"]["name"] for tool in pyhfo_tools.get_tool_definitions()} | UI_MCP_TOOLS
    known_sidecar_actions = {action["name"] for action in get_capability_manifest()["actions"]}
    required_tags = {
        "recording_overview",
        "roi",
        "qc",
        "preprocessing",
        "hfo_detection",
        "spike_detection",
        "spindle",
        "batch",
        "doctor_review",
        "report_export",
        "parameters",
        "labels",
        "real_llm",
    }
    observed_tags = set()

    for case in prompts:
        assert case["expected_status"] in allowed_statuses
        assert len(case["prompt"]) >= 280, case["id"]
        assert len(case["pass_criteria"]) >= 3, case["id"]
        assert set(case["first_safe_tools"]) <= known_tools, case["id"]
        assert set(case["required_tools"]) <= known_tools, case["id"]
        assert set(case["sidecar_actions"]) <= known_sidecar_actions, case["id"]
        assert case["coverage_tags"], case["id"]
        observed_tags.update(case["coverage_tags"])
        if case["expected_status"] in {"partial", "disabled_by_default", "needs_wrapper"}:
            assert case["gap_to_make_capable"], case["id"]

    assert required_tags <= observed_tags


def test_doctor_hero_prompt_catalog_matches_current_capability_manifest():
    catalog = _catalog()
    tools_by_name = {tool["function"]["name"]: tool for tool in pyhfo_tools.get_tool_definitions()}
    actions_by_name = {action["name"]: action for action in get_capability_manifest()["actions"]}

    for case in catalog["prompts"]:
        case_id = case["id"]
        first_safe_tools = set(case["first_safe_tools"])
        required_tools = set(case["required_tools"])
        forbidden_tools = set(case["forbidden_before_prerequisites"])
        sidecar_actions = [actions_by_name[action] for action in case["sidecar_actions"]]

        assert first_safe_tools, case_id
        assert first_safe_tools <= required_tools, case_id
        assert first_safe_tools.isdisjoint(forbidden_tools), case_id
        assert required_tools <= (set(tools_by_name) | UI_MCP_TOOLS), case_id

        if case["expected_status"] == "disabled_by_default":
            assert any(action["status"] == "disabled_by_default" for action in sidecar_actions), case_id
            assert case["gap_to_make_capable"], case_id
            continue

        assert not case["gap_to_make_capable"], case_id
        assert all(action["status"] == "callable" for action in sidecar_actions), case_id

        if case["expected_status"] == "callable_via_mcp":
            assert "emit_ui_command" in required_tools, case_id


def test_doctor_hero_prompt_catalog_covers_current_detector_and_review_surfaces():
    catalog = _catalog()
    prompts_by_id = {case["id"]: case for case in catalog["prompts"]}
    manifest = get_capability_manifest()
    detector_availability = manifest["detector_availability"]
    spindle_detectors = {
        detector["detector"]: detector
        for detector in detector_availability["detectors_by_biomarker"]["Spindle"]
    }

    assert prompts_by_id["doctor-hero-013-spindle-review"]["expected_status"] == "callable"
    assert prompts_by_id["doctor-hero-013-spindle-review"]["first_safe_tools"] == ["pyhfo_get_capability_manifest"]
    assert detector_availability["recommended_smoke_detectors"]["Spindle"] == "MOLLE"
    assert spindle_detectors["MOLLE"]["status"] == "callable"
    assert spindle_detectors["A7"]["status"] == "callable"
    assert spindle_detectors["LSM"]["status"] == "callable_requires_configuration"
    assert spindle_detectors["YASA"]["status"] in {"callable", "unavailable_optional_dependency"}

    review_actions = {
        "review_event_cursor",
        "event_snippet",
        "annotate_event",
        "cross_channel_overlap_review",
        "compare_detector_runs",
        "create_consensus_run",
        "export_review_state",
        "export_report",
        "waveform_window",
        "save_project",
    }
    callable_actions = {action["name"] for action in manifest["actions"] if action["status"] == "callable"}
    assert review_actions <= callable_actions

    disabled_actions = {action["name"] for action in manifest["actions"] if action["status"] == "disabled_by_default"}
    assert {
        "load_bids_channel_annotations",
        "compare_candidate_channels_to_bids_labels",
    } <= disabled_actions
    assert "compare_candidate_channels_to_bids_labels" in prompts_by_id["doctor-hero-023-label-gated-ground-truth"]["sidecar_actions"]


def test_doctor_hero_prompt_catalog_encodes_clinical_safety_invariants():
    catalog = _catalog()
    invariant_text = " ".join(catalog["safety_invariants"]).lower()

    assert "clinical diagnosis" in invariant_text
    assert "labels by default" in invariant_text
    assert "metadata before preprocessing" in invariant_text
    assert "raw recordings immutable" in invariant_text

    for case in catalog["prompts"]:
        combined = " ".join(case["pass_criteria"]).lower()
        if "pathology" in case["coverage_tags"] or "labels" in case["coverage_tags"]:
            assert "label" in combined or "clinical" in combined


def test_doctor_hero_capability_matrix_mentions_every_catalog_case():
    catalog = _catalog()
    matrix = MATRIX_PATH.read_text(encoding="utf-8")

    assert "Source of truth: `tests/fixtures/doctor_hero_prompts.json`" in matrix
    assert "PYHFO_AGENT_ENABLE_LABEL_LOADING=1" in matrix
    assert "IEEG_REAL_LLM_API_KEY" in matrix

    for case in catalog["prompts"]:
        assert f"`{case['id']}`" in matrix, case["id"]
        assert f"`{case['expected_status']}`" in matrix, case["id"]
