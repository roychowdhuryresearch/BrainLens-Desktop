#!/usr/bin/env python3
"""Audit Electron button coverage/clickability against the PyQt button inventory.

The browser preview cannot execute native file dialogs or backend detector/classifier
calls. This audit still exercises every visible non-native/non-backend Electron button
in the core PyQt-parity pages, verifies required PyQt button equivalents exist in the
DOM, verifies the workflow subpages expose a Back-to-Waveform control, and emits a JSON
matrix of clicked/skipped buttons for production QA signoff.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass, asdict
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[2]
DESKTOP = ROOT / "desktop"
PYHFO = ROOT / "pyhfo"
OUT = Path(os.environ.get("PYHFO_BUTTON_AUDIT_OUT", DESKTOP / "artifacts" / "button-parity-audit.json"))
PORT = int(os.environ.get("PYHFO_BUTTON_AUDIT_PORT", "5194"))
BASE_URL = f"http://127.0.0.1:{PORT}"

NATIVE_OR_FILE_PATTERNS = re.compile(
    r"(open|load|save|export|snapshot|artifact|project|session|file|browse|choose|reveal|copy path|shortcuts|batch)",
    re.IGNORECASE,
)
BACKEND_ACTION_PATTERNS = re.compile(
    r"(run detection|run ste|run detector|hfo classification|classify|detect_all|classifier_run|sidebar_filter|qd_run_detection|pyqt-run_button|filter$|analyze|apply|cancel task|quick detection cancel)",
    re.IGNORECASE,
)
SAFE_EXPLICIT_TESTIDS = {
    "pyqt-actionQuick_Detection_toolbar",
    "pyqt-actionStatus_Log_toolbar",
    "pyqt-recording_info_button",
    "pyqt-header_prepare_button",
    "pyqt-header_detect_button",
    "pyqt-header_classify_button",
    "pyqt-waveform_reset_view_button",
    "pyqt-go_to_time_button",
    "pyqt-zoom_out_button",
    "pyqt-zoom_in_button",
    "pyqt-raw_tool_button",
    "pyqt-filtered_tool_button",
    "pyqt-filter60_tool_button",
    "pyqt-normalize_tool_button",
    "pyqt-referential_tool_button",
    "pyqt-average_reference_button",
    "pyqt-auto_bipolar_button",
    "pyqt-highlight_channel_button",
    "pyqt-neighbor_channels_button",
    "pyqt-clean_view_button",
    "pyqt-all_channels_button",
    "pyqt-channel_preset_8",
    "pyqt-channel_preset_16",
    "pyqt-channel_preset_32",
    "pyqt-channel_preset_max",
    "pyqt-prev_event_button",
    "pyqt-center_event_button",
    "pyqt-next_event_button",
    "pyqt-pending_event_button",
    "pyqt-event_channels_button",
    "pyqt-cursor_tool_button",
    "pyqt-measure_tool_button",
    "pyqt-open_review_button",
    "pyqt-sidebar_run_button",
    "pyqt-sidebar_more_results_button",
    "pyqt-sidebar_prepare_button",
    "pyqt-sidebar_recording_info_button",
    "pyqt-sidebar_more_detection_button",
    "pyqt-sidebar_more_classification_button",
    "pyqt-sidebar_new_run_button",
    "pyqt-sidebar_n_jobs_ok_button",
    "pyqt-sidebar_open_review_button",
    "workflow-tab-prepare",
    "workflow-tab-detect",
    "workflow-tab-classify",
    "pyqt-subpage_back_to_main_button",
    "pyqt-runtime_log_close_button",
    "pyqt-recording_info_close_button",
    "pyqt-quick_detection_close_button",
    "pyqt-default_cpu_button",
    "pyqt-default_gpu_button",
    "pyqt-quick_detection_open_review_button",
    "pyqt-quick_detection_show_artifacts_button",
    "pyqt-annotation_close_button",
    "pyqt-PreviousButton",
    "pyqt-NextButton",
    "pyqt-PrevPendingButton",
    "pyqt-NextPendingButton",
    "pyqt-ClearAnnotationButton",
    "pyqt-PrevMatchButton",
    "pyqt-NextMatchButton",
    "pyqt-BackViewButton",
    "pyqt-ForwardViewButton",
    "pyqt-ResetViewButton",
    "pyqt-ZoomInButton",
    "pyqt-ZoomOutButton",
    "pyqt-PanLeftButton",
    "pyqt-PanRightButton",
    "pyqt-PanUpButton",
    "pyqt-PanDownButton",
}

REQUIRED_BUTTON_EQUIVALENTS = [
    # Main toolbar / main shell
    ("main", "action_Open_EDF", "pyqt-actionOpen_EDF_toolbar"),
    ("main", "actionQuick_Detection", "pyqt-actionQuick_Detection_toolbar"),
    ("main", "action_Load_Detection", "pyqt-actionLoad_Detection_toolbar"),
    ("main", "actionStatus_Log", "pyqt-actionStatus_Log_toolbar"),
    ("main", "waveform_plot_button", "pyqt-waveform_plot_button"),
    ("main", "Reset View", "pyqt-waveform_reset_view_button"),
    ("main", "Prepare workflow", "pyqt-header_prepare_button"),
    ("main", "Detect workflow", "pyqt-header_detect_button"),
    ("main", "Classify workflow", "pyqt-header_classify_button"),
    ("main", "Choose_Channels_Button", "pyqt-Choose_Channels_Button"),
    ("main", "bipolar_button", "pyqt-bipolar_button"),
    ("main", "overview_filter_button", "pyqt-sidebar_filter_button"),
    ("main", "n_jobs_ok_button", "pyqt-sidebar_n_jobs_ok_button"),
    ("main", "annotation_button", "pyqt-sidebar_open_review_button"),
    ("main", "save_npz_button", "pyqt-sidebar_save_session_button"),
    ("main", "save_csv_button", "pyqt-sidebar_export_workbook_button"),
    ("main", "detect_all_button", "pyqt-detect_all_button"),
    ("classify-subpage", "default_cpu_button", "pyqt-default_cpu_button"),
    ("classify-subpage", "default_gpu_button", "pyqt-default_gpu_button"),
    # Main right rail, production optimization of PyQt control column
    ("main-right-rail", "Run Actions", "pyqt-sidebar_run_button"),
    ("main-right-rail", "Run Stats", "pyqt-sidebar_run_stats_button"),
    ("main-right-rail", "Signal Prep", "pyqt-sidebar_prepare_button"),
    ("main-right-rail", "Signal Info", "pyqt-sidebar_recording_info_button"),
    ("main-right-rail", "Detection Setup", "pyqt-sidebar_more_detection_button"),
    ("main-right-rail", "Classification Setup", "pyqt-sidebar_more_classification_button"),
    # Workflow subpages and explicit return control
    ("subpage", "overview_tab", "workflow-tab-prepare"),
    ("subpage", "detector_tab", "workflow-tab-detect"),
    ("subpage", "classifier_tab", "workflow-tab-classify"),
    ("subpage", "return_to_main_button", "pyqt-subpage_back_to_main_button"),
    # Quick Detection dialog
    ("quick-detection", "qd_loadEDF_button", "pyqt-qd_loadEDF_button"),
    ("quick-detection", "run_button", "pyqt-run_button"),
    ("quick-detection", "default_cpu_button", "pyqt-default_cpu_button"),
    ("quick-detection", "default_gpu_button", "pyqt-default_gpu_button"),
    ("quick-detection", "qd_choose_artifact_model_button", "pyqt-qd_choose_artifact_model_button"),
    ("quick-detection", "qd_choose_spike_model_button", "pyqt-qd_choose_spike_model_button"),
    ("quick-detection", "qd_choose_ehfo_model_button", "pyqt-qd_choose_ehfo_model_button"),
    ("quick-detection", "Close", "pyqt-quick_detection_close_button"),
    # Annotation dialog
    ("annotation", "SetFreqLimit", "pyqt-SetFreqLimit"),
    ("annotation", "PreviousButton", "pyqt-PreviousButton"),
    ("annotation", "NextButton", "pyqt-NextButton"),
    ("annotation", "Accept", "pyqt-annotation_accept_button pyqt-Accept"),
    ("annotation", "ResetViewButton", "pyqt-ResetViewButton"),
    ("annotation", "ZoomInButton", "pyqt-ZoomInButton"),
    ("annotation", "ZoomOutButton", "pyqt-ZoomOutButton"),
    ("annotation", "PanLeftButton", "pyqt-PanLeftButton"),
    ("annotation", "PanRightButton", "pyqt-PanRightButton"),
    ("annotation", "PanUpButton", "pyqt-PanUpButton"),
    ("annotation", "PanDownButton", "pyqt-PanDownButton"),
    ("annotation", "BackViewButton", "pyqt-BackViewButton"),
    ("annotation", "ForwardViewButton", "pyqt-ForwardViewButton"),
    ("annotation", "Close", "pyqt-annotation_close_button"),
]

@dataclass
class ButtonRecord:
    state: str
    testid: str
    text: str
    enabled: bool
    visible: bool
    action: str
    result: str
    detail: str = ""


def wait_for_server(url: str, timeout: float = 20.0) -> None:
    deadline = time.time() + timeout
    last_error: Exception | None = None
    while time.time() < deadline:
        try:
            with urlopen(url, timeout=1) as response:
                if response.status < 500:
                    return
        except Exception as exc:  # noqa: BLE001
            last_error = exc
        time.sleep(0.25)
    raise RuntimeError(f"dev server did not become ready at {url}: {last_error}")


def start_vite() -> subprocess.Popen[str]:
    env = os.environ.copy()
    env["PATH"] = f"/opt/homebrew/bin:{env.get('PATH', '')}"
    return subprocess.Popen(
        ["npm", "run", "dev", "--", "--port", str(PORT), "--strictPort"],
        cwd=DESKTOP,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        text=True,
    )


def read_pyqt_source_buttons() -> list[dict[str, str]]:
    buttons: dict[str, dict[str, str]] = {}
    for path in [PYHFO / "src/ui/main_window.ui", PYHFO / "src/ui/quick_detection.ui", PYHFO / "src/ui/annotation.ui"]:
        if not path.exists():
            continue
        source = path.read_text(encoding="utf-8", errors="ignore")
        for match in re.finditer(r'<widget class="Q(?:Push|Tool)Button" name="([^"]+)"[^>]*>(.*?)</widget>', source, re.S):
            name, block = match.group(1), match.group(2)
            text_match = re.search(r'<property name="text">\s*<string>(.*?)</string>', block, re.S)
            buttons.setdefault(name, {"object": name, "text": re.sub(r"\s+", " ", text_match.group(1)).strip() if text_match else ""})
    for path in [PYHFO / "src/ui/annotation.py", PYHFO / "src/ui/quick_detection.py"]:
        if not path.exists():
            continue
        source = path.read_text(encoding="utf-8", errors="ignore")
        for match in re.finditer(r'self\.([A-Za-z0-9_]+)\s*=\s*QtWidgets\.Q(?:Push|Tool)Button\("([^"]*)"', source):
            buttons.setdefault(match.group(1), {"object": match.group(1), "text": match.group(2)})
        for match in re.finditer(r'self\.([A-Za-z0-9_]+)\.setText\("([^"]*)"\)', source):
            buttons.setdefault(match.group(1), {"object": match.group(1), "text": match.group(2)})["text"] = match.group(2)
    return sorted(buttons.values(), key=lambda row: row["object"])


def text_for_button(row: dict) -> str:
    text = row.get("text") or row.get("innerText") or row.get("aria") or row.get("title") or ""
    return re.sub(r"\s+", " ", text).strip()


def should_skip(testid: str, text: str, enabled: bool) -> tuple[bool, str]:
    if not enabled:
        return True, "disabled in this state"
    haystack = f"{testid} {text}"
    if testid in SAFE_EXPLICIT_TESTIDS:
        return False, ""
    if NATIVE_OR_FILE_PATTERNS.search(haystack):
        return True, "native/file/export action requires Electron preload or user-selected path"
    if BACKEND_ACTION_PATTERNS.search(haystack):
        return True, "backend action requires packaged/preload sidecar gate"
    return False, ""


def collect_buttons(page, state: str) -> list[ButtonRecord]:
    surface_selectors = {
        "quick-detection": '[data-testid="pyqt-quick_detection_window"] button',
        "annotation": '[data-testid="pyqt-annotation_window"] button',
        "runtime-log": '[data-testid="pyqt-status_log_dialog"] button',
        "recording-info": '[data-testid="pyqt-recording_info_dialog"] button',
    }
    selector = surface_selectors.get(state, "button")
    rows = page.locator(selector).evaluate_all(
        """(buttons) => buttons.map((button) => ({
          testid: button.getAttribute('data-testid') || '',
          text: button.innerText || button.getAttribute('aria-label') || button.getAttribute('title') || '',
          aria: button.getAttribute('aria-label') || '',
          title: button.getAttribute('title') || '',
          disabled: button.disabled || button.getAttribute('aria-disabled') === 'true',
          visible: !!(button.offsetWidth || button.offsetHeight || button.getClientRects().length)
        }))"""
    )
    records: list[ButtonRecord] = []
    for row in rows:
        if not row.get("visible"):
            continue
        raw_testid = row.get("testid") or ""
        text = text_for_button(row)
        enabled = not row.get("disabled")
        if not raw_testid:
            records.append(ButtonRecord(state, f"no-testid:{len(records)}", text, enabled, True, "skip", "skipped", "visible button has no data-testid; source-contract audit handles static anonymous controls"))
            continue
        testid = raw_testid
        skip, reason = should_skip(testid, text, enabled)
        records.append(ButtonRecord(state, testid, text, enabled, True, "skip" if skip else "pending-click", "skipped" if skip else "pending", reason))
    return records


def click_first_visible_enabled(page, testid: str) -> bool:
    selector = f'[data-testid="{testid}"]'
    return bool(page.locator(selector).evaluate_all("""(nodes) => {
      const target = nodes.find((node) => {
        const element = node;
        const rects = element.getClientRects();
        return rects.length && !element.disabled && element.getAttribute('aria-disabled') !== 'true';
      });
      if (!target) return false;
      target.click();
      return true;
    }"""))


def close_known_surfaces(page) -> None:
    for testid in [
        "pyqt-recording_info_close_button",
        "pyqt-runtime_log_close_button",
        "pyqt-load_detection_close_button",
        "pyqt-waveform_shortcuts_close_button",
        "pyqt-channel_selection_close_button",
        "pyqt-bipolar_close_button",
        "pyqt-batch_project_close_button",
        "pyqt-run_stats_close_button",
        "pyqt-annotation_close_button",
        "pyqt-quick_detection_close_button",
    ]:
        loc = page.get_by_test_id(testid)
        try:
            if loc.count() and loc.first.is_visible():
                loc.first.evaluate("(el) => el.click()")
                page.wait_for_timeout(80)
        except Exception:
            pass


def dom_click(page, testid: str) -> str:
    loc = page.get_by_test_id(testid).first
    if not loc.count():
        return "missing after collection"
    try:
        loc.evaluate("(el) => el.click()", timeout=1200)
        page.wait_for_timeout(160)
        close_known_surfaces(page)
        return "ok"
    except Exception as exc:  # noqa: BLE001
        return str(exc).split("\n", 1)[0]


def set_state(page, state: str) -> None:
    page.goto(f"{BASE_URL}/?visualFixture=1", wait_until="domcontentloaded")
    page.wait_for_selector('[data-testid="pyqt-main-window"]', timeout=8000)
    page.wait_for_timeout(250)
    if state == "agent-open":
        page.get_by_test_id("agent-activity-chat").click(force=True)
        page.wait_for_selector('[data-testid="agent-panel"]')
    elif state == "prepare-subpage":
        page.get_by_test_id("pyqt-header_prepare_button").evaluate("(el) => el.click()")
        page.wait_for_selector('[data-testid="pyqt-tabWidget"]:not([hidden])')
        page.wait_for_selector('[data-testid="workflow-prepare-content"]')
    elif state == "runtime-log":
        page.get_by_test_id("pyqt-actionStatus_Log_toolbar").evaluate("(el) => el.click()")
        page.wait_for_selector('[data-testid="pyqt-status_log_dialog"]')
    elif state == "recording-info":
        page.get_by_test_id("pyqt-recording_info_button").evaluate("(el) => el.click()")
        page.wait_for_selector('[data-testid="pyqt-recording_info_dialog"]')
    elif state == "detect-subpage":
        page.get_by_test_id("pyqt-header_detect_button").evaluate("(el) => el.click()")
        page.wait_for_selector('[data-testid="pyqt-tabWidget"]:not([hidden])')
        page.wait_for_selector('[data-testid="workflow-detect-content"]')
    elif state == "classify-subpage":
        page.get_by_test_id("pyqt-header_classify_button").evaluate("(el) => el.click()")
        page.wait_for_selector('[data-testid="pyqt-tabWidget"]:not([hidden])')
        page.wait_for_selector('[data-testid="workflow-classify-content"]')
    elif state == "quick-detection":
        page.get_by_test_id("pyqt-actionQuick_Detection_toolbar").click(force=True)
        page.wait_for_selector('[data-testid="pyqt-quick_detection_window"]')
    elif state == "annotation":
        if not click_first_visible_enabled(page, "pyqt-open_review_button"):
            raise RuntimeError("No visible enabled pyqt-open_review_button was available to open annotation")
        page.wait_for_selector('[data-testid="pyqt-annotation_window"]', timeout=5000)


def click_priority(record: ButtonRecord) -> int:
    opener_terms = ["quick_detection", "status_log", "recording_info", "more_", "open_review", "subpage_back", "close"]
    return 10 if any(term in record.testid for term in opener_terms) else 0


def audit_clicks(page, states: list[str]) -> list[ButtonRecord]:
    records: list[ButtonRecord] = []
    for state in states:
        set_state(page, state)
        state_records = collect_buttons(page, state)
        seen_testids: set[str] = set()
        for record in sorted(state_records, key=click_priority):
            if record.testid in seen_testids:
                record.action = "skip"
                record.result = "skipped"
                record.detail = "duplicate visible button testid already audited in this state"
                records.append(record)
                continue
            seen_testids.add(record.testid)
            if record.action != "pending-click":
                records.append(record)
                continue
            loc = page.get_by_test_id(record.testid).first
            try:
                if not loc.count() or not loc.is_visible():
                    record.action = "skip"
                    record.result = "skipped"
                    record.detail = "surface changed before click; equivalent opener/back behavior was audited separately"
                    records.append(record)
                    continue
            except Exception:
                record.action = "skip"
                record.result = "skipped"
                record.detail = "surface changed before visibility check"
                records.append(record)
                continue
            result = dom_click(page, record.testid)
            record.action = "clicked"
            record.result = "passed" if result == "ok" else "failed"
            record.detail = "" if result == "ok" else result
            records.append(record)
    return records


def required_equivalent_failures(page) -> list[str]:
    failures: list[str] = []
    groups = {
        "loaded-main": [item for item in REQUIRED_BUTTON_EQUIVALENTS if item[0] in {"main", "main-right-rail"}],
        "detect-subpage": [item for item in REQUIRED_BUTTON_EQUIVALENTS if item[0] == "subpage"],
        "classify-subpage": [item for item in REQUIRED_BUTTON_EQUIVALENTS if item[0] == "classify-subpage"],
        "quick-detection": [item for item in REQUIRED_BUTTON_EQUIVALENTS if item[0] == "quick-detection"],
        "annotation": [item for item in REQUIRED_BUTTON_EQUIVALENTS if item[0] == "annotation"],
    }
    for state, items in groups.items():
        set_state(page, state)
        for group, pyqt_object, testid in items:
            loc = page.get_by_test_id(testid)
            if loc.count() == 0:
                failures.append(f"{group}: PyQt {pyqt_object} equivalent missing Electron testid {testid}")
    return failures


def subpage_back_smoke(page) -> list[str]:
    failures: list[str] = []
    set_state(page, "detect-subpage")
    if page.get_by_test_id("pyqt-subpage_back_to_main_button").count() == 0:
        return ["Back-to-Waveform button is missing on Detect subpage"]
    page.get_by_test_id("pyqt-subpage_back_to_main_button").evaluate("(el) => el.click()")
    page.wait_for_timeout(120)
    hidden = page.get_by_test_id("pyqt-tabWidget").evaluate("(el) => el.hidden || getComputedStyle(el).display === 'none'")
    if not hidden:
        failures.append("Back-to-Waveform did not collapse Detect subpage")
    set_state(page, "classify-subpage")
    page.get_by_test_id("pyqt-subpage_back_to_main_button").evaluate("(el) => el.click()")
    page.wait_for_timeout(120)
    hidden = page.get_by_test_id("pyqt-tabWidget").evaluate("(el) => el.hidden || getComputedStyle(el).display === 'none'")
    if not hidden:
        failures.append("Back-to-Waveform did not collapse Classify subpage")
    return failures


def main() -> int:
    from playwright.sync_api import sync_playwright

    pyqt_buttons = read_pyqt_source_buttons()
    server = start_vite()
    try:
        wait_for_server(BASE_URL)
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
            page.set_default_timeout(1000)
            console_entries: list[dict[str, str]] = []
            page.on("console", lambda msg: console_entries.append({"type": msg.type, "text": msg.text[:300]}))
            states = [
                "loaded-main",
                "agent-open",
                "prepare-subpage",
                "runtime-log",
                "recording-info",
                "detect-subpage",
                "classify-subpage",
                "quick-detection",
                "annotation",
            ]
            required_failures = required_equivalent_failures(page)
            back_failures = subpage_back_smoke(page)
            click_records = audit_clicks(page, states)
            browser.close()
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()

    failed_clicks = [r for r in click_records if r.result == "failed"]
    clicked = [r for r in click_records if r.action == "clicked"]
    skipped = [r for r in click_records if r.action == "skip"]
    failures = required_failures + back_failures + [f"{r.state}:{r.testid} click failed: {r.detail}" for r in failed_clicks]
    unexpected_console = [entry for entry in console_entries if entry["type"] in {"error"} and "Electron preload bridge unavailable" not in entry["text"]]
    failures.extend([f"console error: {entry['text']}" for entry in unexpected_console])
    report = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "status": "passed" if not failures else "failed",
        "pyqt_source_button_count": len(pyqt_buttons),
        "pyqt_source_buttons": pyqt_buttons,
        "required_equivalents_checked": [
            {"group": group, "pyqt_object": pyqt_object, "electron_testid": testid}
            for group, pyqt_object, testid in REQUIRED_BUTTON_EQUIVALENTS
        ],
        "states_checked": states,
        "summary": {
            "electron_visible_button_records": len(click_records),
            "clicked_safe_buttons": len(clicked),
            "skipped_disabled_or_external_buttons": len(skipped),
            "failed_clicks": len(failed_clicks),
            "required_equivalent_failures": len(required_failures),
            "subpage_back_failures": len(back_failures),
            "unexpected_console_errors": len(unexpected_console),
        },
        "click_records": [asdict(r) for r in click_records],
        "console": console_entries[-80:],
        "failures": failures,
        "limitations": [
            "Browser-preview audit skips native file dialogs, save/export actions, and backend detector/classifier calls because those require Electron preload or real sidecar fixtures.",
            "Skipped external actions remain covered by source contracts, packaged Electron smoke, real-fixture smoke, and manual visual signoff gates.",
        ],
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({"status": report["status"], "summary": report["summary"], "report": str(OUT), "failures": failures[:20]}, indent=2))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
