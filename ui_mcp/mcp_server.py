#!/usr/bin/env python3
"""Zero-dependency stdio MCP server: the iEEG UI as an MCP connector.

Lets an external MCP agent (e.g. Claude Code) DRIVE the iEEG desktop UI. It is a thin client of the
UI broker (ui_mcp/broker.py) — it does NOT touch the agent's Python env. Exposed MCP tools:
  - search_tools(query)                    -> discover the catalog command(s) that match a goal
  - list_tool_categories()                 -> browse the whole command surface by category
  - get_ui_state()                         -> what the clinician is currently viewing
  - emit_ui_command(type, payload, reason) -> drive the UI (catalog-validated; writes are staged)
  - wait_for_ui_command(command_id)        -> wait for renderer/backend callback when needed
  - inspect_waveform(query)                -> have a vision model read the live waveform image

Speaks MCP JSON-RPC 2.0 over stdio (newline-delimited). Stdlib only.

Config via env:
  IEEG_UI_BROKER_URL    (default http://127.0.0.1:8770)
  IEEG_UI_BROKER_TOKEN  (optional bearer for the broker)
  IEEG_UI_VLM_API_KEY / IEEG_UI_VLM_BASE_URL / IEEG_UI_VLM_MODEL  (optional, for inspect_waveform)

Add to a Claude Code .mcp.json:
  {"mcpServers": {"ieeg-ui": {"command": "python", "args": ["/abs/path/ui_mcp/mcp_server.py"],
                              "env": {"IEEG_UI_BROKER_URL": "http://127.0.0.1:8770"}}}}
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.request
from urllib.parse import quote
from pathlib import Path

try:
    from ui_mcp.broker import load_catalog as _load_resolved_catalog
except ModuleNotFoundError:  # direct `python ui_mcp/mcp_server.py` execution
    from broker import load_catalog as _load_resolved_catalog

PROTOCOL_VERSION = "2024-11-05"
SERVER_INFO = {"name": "ieeg-ui", "version": "0.1.0"}
BROKER = os.getenv("IEEG_UI_BROKER_URL", "http://127.0.0.1:8770").rstrip("/")
BROKER_TOKEN = os.getenv("IEEG_UI_BROKER_TOKEN", "")
# How long emit_ui_command waits for the renderer's apply outcome before returning 'pending'. The
# renderer drains ~700ms and acks; a value of 0 disables the poll (emit returns at enqueue).
_ACK_POLL_BUDGET_MS = int(os.getenv("IEEG_UI_ACK_POLL_BUDGET_MS", "1500"))
WRITE_RISKS = frozenset({"compute", "artifact_write", "review_write", "destructive"})
ASYNC_COMPLETION_RISKS = frozenset({"analysis", "compute", "artifact_write", "destructive"})
CALLBACK_RISKS = ASYNC_COMPLETION_RISKS | frozenset({"review_write"})
FAILURE_ACK_STATUSES = frozenset({"failed", "rejected", "noop"})
ACK_STATUS_ALIASES = {
    "staged": "queued",
    "dismissed": "rejected",
    "unknown": "rejected",
    "error": "failed",
    "cancelled": "failed",
    "canceled": "failed",
    "success": "complete",
}
_CATALOG_PATH = Path(os.getenv("IEEG_UI_CATALOG") or (Path(__file__).resolve().parents[1] / "contracts" / "ui-command-catalog.json"))


def _is_renderer_staged_ack(ack: object) -> bool:
    """Recognize a staged renderer ACK without weakening the canonical receipt status."""
    if not isinstance(ack, dict):
        return False
    raw_status = str(ack.get("status") or "").strip().lower()
    if raw_status == "staged":
        return True
    if ACK_STATUS_ALIASES.get(raw_status, raw_status) != "queued":
        return False
    if ack.get("requires_confirmation") is not True:
        return False
    transitions = ack.get("transitions")
    if not isinstance(transitions, list) or not transitions:
        return False
    latest = transitions[-1]
    if not isinstance(latest, dict):
        return False
    return (
        latest.get("source") == "renderer_ack"
        and latest.get("from") == "queued"
        and latest.get("to") == "queued"
    )


def _load_catalog() -> dict:
    return _load_resolved_catalog(_CATALOG_PATH)


CATALOG = _load_catalog()

COMMAND_USAGE = {
    'workspace.open_panel': (
        'Open visible UI panels/dialogs. Examples: {"panel":"Detect"}, {"panel":"Classify"}, '
        '{"panel":"Review"}, {"panel":"Run Stats"}, {"panel":"Recording Info"}, {"panel":"Actions"}, '
        '{"panel":"Artifacts"}. NOTE: opened dialogs/tabs do NOT show up in get_ui_state (active_panel '
        'stays "workspace") — a success result means it opened; do not re-emit thinking it failed. An '
        'unknown panel name reports noop.'
    ),
    'workspace.reset_waveform_view': (
        'Return the waveform to a clean default state in one shot. Use for "reset the view", "clear all '
        'the filters and montage", "put the waveform back to normal", "start over on the display". '
        'Payload: {} (no fields). Instant view-class action (applies immediately, no Apply); if the view '
        'is already at defaults it returns noop. Effect: scrolls to time 0 and the first channel, turns '
        'OFF the filtered display and the 60 Hz line filter, drops vertical normalization, sets montage '
        "back to referential, sets channel focus mode to 'all', and turns cursor and measure tools off. "
        'It does NOT change the recording, the amplitude-scale factor, or any detection runs/labels — it '
        'only resets DISPLAY controls. DISTINCT FROM waveform.set_display (which flips individual '
        'toggles like show_filtered/filter_60hz/montage_mode one at a time — use reset to clear them ALL '
        'at once), from waveform.set_amplitude_scale (gain is a separate control this does not touch), '
        'and from recording.open/project.open (which discard the whole workspace, not just the view).'
    ),
    'recording.inspect_metadata': (
        "Open the Recording Info dialog to SHOW the loaded recording's metadata — sampling rate, "
        'duration, channel count/names, and header details — for the clinician to read. Use for "open '
        'recording info", "show the file header", "what\'s the sampling rate / how long is this '
        'recording" when the clinician wants the panel opened. Payload: {} (no fields). '
        'requiresRecording. Read-class, applies instantly (no Apply). NOTE: like other dialog openers it '
        'surfaces in get_ui_state.active_dialog, NOT in active_panel (which stays "workspace") — a '
        'success result means it opened, so do NOT re-emit it thinking it failed. If you instead need '
        'the metadata VALUES to reason with (not to show a dialog), read them directly from get_ui_state '
        'rather than opening this dialog. DISTINCT FROM analysis.run_qc / '
        'analysis.compute_spectral_profile, which COMPUTE new channel-QC / spectral / Nyquist-line-noise '
        'evidence rather than just displaying the existing header, and from recording.infer_roi (which '
        'infers relevant brain channels).'
    ),
    'detection.run': (
        'Stage a detector run. "Ripples", "fast ripples" and "HFOs" are all HFO biomarkers — a bare "I '
        'want all ripples" / "find the ripples" / "detect all HFOs" is a complete request, act on it '
        '(never ask what ripples means). BUT check get_ui_state runs_detail first: if a run with the '
        'same biomarker/band already exists, do NOT re-run — surface that run with '
        'detection.focus_top_candidate_channel or detection.rank_candidates. Re-run only when none '
        'exists yet or the user explicitly asks to iterate. For an underspecified non-standard detector '
        'run, ask for result-shaping choices: detector/protocol, parameter preset or confirmed defaults, '
        'filter band, and channel scope; ask one concise clarification and do not silently choose '
        'STE/MOLLE, filter bands, thresholds, or all-channel scope. For "detect all ripples/HFOs": '
        '{"biomarker":"HFO","detector":"STE","scope":"all","all_channels":true,"filter":{"fp":80,"fs":250'
        '},"confirmed_defaults":true,"exports":["csv","session","summary_json"],"n_jobs":1} (ripple band '
        'is ALWAYS 80-250 Hz; fast ripples 250-500 and need fs>=~1052 Hz or they yield 0 events; '
        'bare/generic HFO 80-500). Then rank/show the channels. A MOLLE spindle run can use '
        '{"biomarker":"Spindle","detector":"MOLLE","scope":"all","all_channels":true,"filter":{"fp":1,"fs'
        '":30},"detector_params":{"method":"MOLLE","freq_sp":[11,16]}}. Never use detector="STE" for '
        'biomarker="Spindle"; STE is an HFO detector. For "RMS = 2 detect STE", keep detector="STE" and '
        'pass {"detector_params":{"rms_thres":2}}.'
    ),
    'detection.set_parameters': (
        'WRITE detector/preprocessing parameters into the Prepare panel without running anything '
        '(instant view-class write — nothing is computed). Use for goals like "set the filter band to fp '
        '80 and fs 250", "set the line-noise notch to 60 Hz", "resample to 1000", or "use 4 jobs". '
        'Example covering a whole request: '
        '{"filter":{"fp":80,"fs":250},"line_noise_notch_hz":60,"resample_sfreq":1000,"n_jobs":4}. fp/fs '
        'may also be passed flat ({"fp":80,"fs":250}). This only SETS the controls; to actually run '
        'preprocessing the user must ask for it (analysis.prepare_recording).'
    ),
    'classification.set_parameters': (
        'WRITE classifier parameters into the Classify panel without running (instant view-class write). '
        'EXACT keys (others ignored -> noop): mode, device, batch_size, use_spike(bool), use_ehfo(bool), '
        'ignore_before, ignore_after, model paths. Example: {"mode":"HF '
        'CPU","device":"cpu","use_spike":true,"use_ehfo":false}. To actually classify, use '
        'classification.run.'
    ),
    'detection.focus_top_candidate_channel': (
        'After loaded events exist, show the channel with the most candidate events. Use for "show me '
        'the channel with the most HFO". Example: {"biomarker":"HFO","duration_seconds":2}.'
    ),
    'detection.rank_candidates': (
        'Rank the active run\'s candidate channels by event count/rate — the "which channels" answer. '
        'Needs an existing detection run; if none exists yet, say detection must run first rather than '
        'fabricating a ranking. Example: {"biomarker":"HFO"}.'
    ),
    'severity.run': (
        'Score a scalp EEG recording\'s overall severity (0-5 per 15-second segment) with the BASED '
        'model — the "how severe/abnormal is this EEG" answer. Whole-recording: needs a loaded scalp '
        'EEG recording but NO detection run and no biomarker. Only meaningful when the recording is '
        'scalp EEG (recording_info.eeg_type == "scalp"); on intracranial recordings say so instead of '
        'scoring. Report as a signal-derived research score, never a clinical severity diagnosis. '
        'The panel reports artifact-excluded numbers (clean_mean_score / clean_peak_score / '
        'clean_peak_time_sec); quote those so the answer matches what the user sees. '
        'Example: {}.'
    ),
    'waveform.focus_hotspot_channels': (
        'After loaded events exist, show the top-N event-count channels. Example: '
        '{"biomarker":"HFO","top_n":8,"duration_seconds":4}.'
    ),
    'waveform.set_viewport': (
        'Move/resize the waveform time window — the main time-navigation command. For "go to 30 seconds" '
        'or "jump to 60s for 4s": {"start_seconds":30,"duration_seconds":4}. duration_seconds is the '
        'visible span.'
    ),
    'waveform.set_display': (
        'Change display toggles. EXACT keys (others are ignored -> noop): show_filtered(bool), '
        'filter_60hz(bool), normalize_vertically(bool), cursor_enabled(bool), measure_enabled(bool), '
        'amplitude_scale(num), visible_channels(int), channels(array of channel names), '
        'time_window_seconds(num), montage_mode in {referential,averageReference,autoBipolar}, '
        'channel_focus_mode in {all,highlight,neighbors,clean,events}. Example: '
        '{"show_filtered":true,"filter_60hz":true}. Note: "filtered"/"filter60" etc. are NOT recognized.'
    ),
    'recording.set_channel_visibility': (
        'Restrict the waveform to a channel subset and/or set the visible count. Pass {"channels":["POL '
        'ST1",...]} or {"visible_channels":8}. An empty payload (or only unknown channel names) changes '
        'nothing -> noop.'
    ),
    'events.move_cursor': (
        'Step through loaded review events: {"direction":"next"} or {"direction":"prev"} moves the '
        'cursor one event from the current selection; or pass {"event_id":"evt-..."} to jump to a '
        'specific loaded event. With no loaded events, or already at the first/last, it reports noop.'
    ),
    'analysis.run_qc': (
        'Run the recording planning analysis (label-free ROI -> channel QC -> spectral profile) and '
        'populate the Prepare/analysis panel. NOTE: run_qc and compute_spectral_profile both trigger the '
        'SAME full 3-step pass, so call ONE of them, not both. It runs in the background; results appear '
        'in the panel, NOT in get_ui_state.'
    ),
    'waveform.focus_channel': (
        'Focus ONE named channel in the waveform and optionally jump the time window to it in the SAME '
        'command. Use for "focus on POL IO3", "show me channel LHH2 around 10s", "bring up the RA1 trace '
        'for 2 seconds at 30s". requiredPayload channel — must be an EXACT loaded channel name (unknown '
        "-> 'missing channel'/rejected; already focused with no window change -> noop); "
        'start_seconds/duration_seconds are OPTIONAL (omit to keep the current time window). Instant '
        'view-class action (applies immediately, no Apply). Effect: brings the channel to the top of the '
        "plot, sets it as the annotation channel, switches focus mode to 'highlight', and (if a window "
        'is given) moves the viewport. DISTINCT FROM recording.select_channel (same channel-highlight '
        'effect but takes NO time window — use focus_channel when you also want to jump in time), from '
        'waveform.set_viewport (moves time only, no channel change), and from '
        'detection.focus_top_candidate_channel / waveform.focus_hotspot_channels (which pick channels '
        'automatically by event count from the active run rather than by name).'
    ),
    'waveform.center_event': (
        "Center the waveform time window on ONE loaded detected event and bring that event's channel to "
        'the front. Use after detection when the clinician says "show me event evt-12", "jump to that '
        'ripple", "center on the selected HFO". requiredPayload event_id — must be an EXACT loaded event '
        "id (call get_ui_state for valid ids; an id that is no longer loaded is validated to 'missing "
        "event'/noop). The window is sized automatically from the event's own duration and the current "
        'waveform time-window setting (the payload does NOT take a duration). Instant view-class action '
        '(applies immediately, no Apply). Effect: sets start_seconds so the event sits mid-window, moves '
        "the event's channel to the top, and sets waveform focus mode to 'events'. With no detection run "
        '/ no loaded events there is nothing to center — say detection must run first rather than '
        'emitting a fabricated id. DISTINCT FROM events.select_event (selects an event for review '
        'WITHOUT moving the waveform), events.move_cursor (steps next/prev through the review list via '
        '{"direction"}), waveform.focus_channel (centers a CHANNEL, not an event), review.focus_event '
        '(does the same recenter PLUS moves the review cursor), and review.open_event (opens the full '
        'review-dialog evidence packet).'
    ),
    'review.open_event': (
        'Open the Event Review dialog (the full per-event evidence packet — snippet, feature summary, '
        'waveform context) on a specific event, and navigate the panes to it. Use it when the clinician '
        'wants to INSPECT one event in detail: "open event evt-0042", "show the evidence for this '
        'candidate", "open the review detail". requiresEvent but NO required payload key: pass '
        '{"event_id":"evt-..."} to open a named event, or {} to open the currently selected event (the '
        'handler resolves event_id -> selected event -> first loaded event). It also selects the event '
        'and recenters the waveform on it (like review.focus_event) before opening the dialog. Instant '
        'view-class command (no Apply gate). Surfaces in get_ui_state.active_dialog (not active_panel) — '
        'a success result means it opened; do not re-emit. DISTINCT FROM review.focus_event: focus_event '
        'only navigates the review list + waveform panes; open_event additionally POPS the Event Review '
        'modal dialog. DISTINCT FROM events.select_event: select_event just sets the current event with '
        'no waveform move and no dialog. DISTINCT FROM review.open_comparison: open_event is about ONE '
        "event's evidence; open_comparison opens whole-run statistics/comparison. Opening the dialog "
        'does not annotate — no label is staged.'
    ),
    'review.open_comparison': (
        'Open the run statistics / comparison UI for the active detection run — the read-only "look at '
        'the run\'s stats / compare runs" view (per-channel counts, rates, overlap between runs). Use it '
        'for "open run statistics", "compare the runs", "show run stats / differences". requiresRun; '
        'empty payload: {}. Instant view-class command that opens a panel/dialog (no Apply gate). '
        'Surfaces in get_ui_state.active_dialog/active_tab (the bare active_panel stays "workspace") — a '
        'success result means it opened; do not re-emit thinking it failed. DISTINCT FROM '
        'review.accept_run: accept_run is a review_write that MARKS a run as the accepted run of record '
        '(STAGED for Apply, changes state); open_comparison only LOOKS at run stats and writes nothing. '
        'DISTINCT FROM review.group_overlaps: group_overlaps computes within-run cross-channel event '
        'co-occurrence; open_comparison surfaces whole-run summary statistics/comparison. DISTINCT FROM '
        'artifacts.open_report: open_comparison shows the live in-app run stats UI; '
        'artifacts.open_report opens a saved report artifact file.'
    ),
    'classification.run': (
        'Stage classification for the active run. Needs an existing detection run — if get_ui_state '
        'shows no matching run, say detection must run first and do NOT fabricate labels. Example: '
        '{"biomarker":"HFO","mode":"HF CPU"}.'
    ),
    'events.stage_annotation': (
        'Stage a review label for an event. Example: '
        '{"event_id":"evt-...","label":"accepted","notes":"brief rationale"}. Valid labels include '
        'accepted, artifact, rejected, uncertain, and clear.'
    ),
    'artifacts.open_report': (
        'Open the Artifacts panel (which lists the reports/exports already generated). Use it for "open '
        'the artifacts", "show me the reports", "open the artifacts panel". Payload is empty ({}); it '
        'ALWAYS opens the Artifacts panel and does NOT read a path or open one specific file. Instant '
        'view-class command that opens a panel/dialog (no Apply gate); surfaces in '
        'get_ui_state.active_dialog/active_tab, not active_panel — a success result means it opened, do '
        'not re-emit. It only OPENS the panel; it does NOT create or regenerate any artifact. DISTINCT '
        'FROM export.report: export.report GENERATES a new HTML case report (an artifact_write, STAGED '
        "for the clinician's Apply); artifacts.open_report just opens the panel that lists outputs "
        'already produced. If no report has been produced yet, run export.report first — do not call '
        'open_report on a path that was never generated. DISTINCT FROM review.open_comparison: '
        'open_comparison opens the live in-app run statistics UI, whereas open_report opens the '
        'Artifacts panel.'
    ),
    'detection.create_consensus_run': (
        'Create a consensus candidate run from multiple existing detector runs (a compute write — staged '
        'for Apply). Example: {} for the default strategy, or {"strategy":"majority"}.'
    ),
    'review.group_overlaps': (
        'Compute cross-channel overlapping-event groups for the active run so co-occurring events '
        '(events that fire simultaneously across channels within tolerance) can be reviewed together. It '
        'runs the backend overlap analysis and reports the number of overlap group(s); it does NOT hide, '
        'merge, delete, or relabel any events — everything stays loaded. Use it for "group the '
        'overlapping events", "which events co-occur across channels", "show simultaneous/cross-channel '
        'events". requiresRun — if get_ui_state shows no run, say detection must run first rather than '
        'fabricating groups. Empty payload: {}. Risk class is analysis, so it applies without an Apply '
        'gate (results land in the review message/panel, not directly in get_ui_state top-level). '
        'DISTINCT FROM detection.create_consensus_run: consensus_run is a compute write (STAGED for '
        'Apply) that CREATES a new consensus candidate run from multiple detectors; group_overlaps only '
        "clusters the existing run's events for viewing and creates nothing. DISTINCT FROM "
        'review.open_comparison: that opens the run statistics/comparison UI to compare whole runs; '
        'group_overlaps analyzes within-run event co-occurrence.'
    ),
    'project.save': (
        'Save the current PROJECT — persist the working case (recording, all runs, review '
        "labels/annotations, and the action log) to the app's project file so the workspace can be "
        'reopened and continued later; this is the tracked working document, and saving marks it clean '
        '(no longer dirty). Use it for "save the project", "save my work", "persist this case", or '
        '"store the workspace". Payload is typically empty: {} (saves to the current project path, '
        "prompting for a location on first save). This is an artifact_write — STAGED for the clinician's "
        'Apply. DISTINCT FROM export.session: project.save writes/updates the ongoing editable project '
        'file the app owns and tracks as dirty/clean; export.session produces a separate standalone '
        '.pybrain snapshot for archiving or handoff. DISTINCT FROM export.report / export.workbook, '
        'which emit read-only output documents (HTML report, Excel table) rather than resumable project '
        'state. DISTINCT FROM project.open, which is the destructive load that REPLACES the current '
        'workspace with a saved file. DISTINCT FROM review.accept_run, which marks a run as the accepted '
        'run of record but writes no file. Default to project.save (not export.session) when the user '
        "just wants to 'save' inside the app."
    ),
    'project.open': (
        'Open/resume a saved project file, REPLACING the current workspace (staged for Apply). Example: '
        '{"input_path":"/path/case.ieegproj"}.'
    ),
    'review.accept_run': (
        'Mark a detection run as the accepted run of record after review (staged for Apply). Needs an '
        'existing run. Example: {} for the active run, or {"run_id":"..."}. For "accept/finalize/sign '
        'off this run" — distinct from exporting or saving the project.'
    ),
    'export.report': (
        'Export a human-readable CASE REPORT for the current run/session — the narrative sign-off '
        'artifact. It renders a summary plus tables: per-run rows, channel ranking, an event preview, '
        'and review annotations, written as HTML. Use it for "export the report", "generate a case '
        'report", "write up this run", or "produce a summary document for the file". Payload: {} exports '
        'the active run (falls back to accepted/first run); pass {"run_id":"..."} to target a specific '
        'run. IMPORTANT: there is NO honored format field on the agent payload — the handler reads only '
        'run_id. The renderer supplies a default filename (e.g. run-statistics-<run>-report.html) and '
        'opens a Save dialog for the clinician to name/place it; do NOT pass {"format":"html"} expecting '
        'it to switch formats (only run_id is read). requiresRun — if get_ui_state shows none, say '
        'detection must run first rather than exporting an empty report (the renderer also hard-guards '
        "'Create or load a detection run before exporting.'). This is an artifact_write — STAGED for the "
        "clinician's Apply. DISTINCT FROM export.workbook, which is the machine-readable spreadsheet "
        '(events + per-channel stats as .xlsx) for downstream analysis, NOT a written report. DISTINCT '
        'FROM export.session, which is a reloadable .pybrain checkpoint of the whole session state for '
        'reproducibility/handoff, not a document to read. DISTINCT FROM project.save (saves the working '
        'project file you keep editing) and review.accept_run (marks the run of record without producing '
        'any file).'
    ),
    'export.workbook': (
        "Export a data WORKBOOK — a machine-readable Excel spreadsheet (.xlsx) of the run's events and "
        'per-channel statistics for downstream analysis in Excel/pandas/stats tools. Use it for "export '
        'the workbook", "give me the events as a spreadsheet", "dump per-channel stats to Excel", or '
        '"export a table of the detections". Payload: {} exports the active run (falls back to '
        'accepted/first run); pass {"run_id":"..."} to target a specific run. There is NO honored format '
        'field on the agent payload — the handler reads only run_id. The renderer supplies a default '
        '.xlsx filename and opens a Save dialog for the clinician to name/place it. requiresRun — if '
        'none exists, say detection must run first rather than exporting an empty workbook (renderer '
        "hard-guards on no run). This is an artifact_write — STAGED for the clinician's Apply. DISTINCT "
        'FROM export.report, which is the human-readable case report (HTML summary + tables) meant to be '
        'read/signed-off, whereas the workbook is raw tabular data for a machine. DISTINCT FROM '
        'export.session, which is a reloadable session checkpoint (.pybrain), not a spreadsheet. '
        'DISTINCT FROM project.save (persists the editable project file) — the workbook is a one-way '
        'data export, not a resumable state file.'
    ),
    'export.session': (
        'Export a reproducible SESSION checkpoint — a reloadable bundle of the entire workspace state '
        '(recording reference, all detection runs, review events, cursor, classifier/prepare controls, '
        'recording analysis, recent runtime log) written as a .pybrain checkpoint (backend also supports '
        '.npz). It is what you reopen later to resume or hand the case to a colleague with everything '
        'intact. Use it for "save/export the session", "snapshot this session so I can reload it", or '
        '"bundle everything for reproducibility/handoff". Payload: {} exports the current workspace (or '
        'pass {"run_id":"..."} to stamp a specific run into the filename); only run_id is honored from '
        "the agent payload. Requires a loaded recording OR at least one run — the renderer guards 'Open "
        "a recording or create a detection run before saving a session.' if the workspace is empty. This "
        "is an artifact_write — STAGED for the clinician's Apply. DISTINCT FROM export.report (a "
        'read-only HTML case report) and export.workbook (an Excel data table) — both are one-way '
        'outputs you cannot reload; the session bundle is reloadable state. DISTINCT FROM project.save: '
        'project.save writes the ongoing editable PROJECT file (recording, runs, labels, action log) '
        'that the app tracks as the working document and marks clean; export.session produces a '
        "standalone portable snapshot artifact for archiving/handoff. When the user says 'save my work' "
        "inside the app, prefer project.save; when they say 'export a session bundle' or 'so someone "
        "else can reload it', use export.session."
    ),
    'analysis.prepare_recording': (
        'PRODUCE a new prepared/cleaned recording artifact for detection — a heavy compute pass that '
        'runs preprocessing (bandpass, line-noise notch, resample, channel-drop cleaning) and writes a '
        'derived .fif copy, then loads it as the active recording. Use ONLY for an explicit '
        '"clean/prepare the recording", "make a cleaned copy for detection", "drop the flat/bad channels '
        'and stage it", or "re-reference and prepare" request — even when that request also mentions a '
        'notch/filter, because here the notch is part of PRODUCING a file, not setting a control. STAGED '
        "write (risk=compute): under review autonomy it holds for the clinician's Apply (auto-run/full "
        'autonomy may start it immediately); after emitting, wait_for_ui_command on the returned '
        'command_id before claiming it finished, then read get_ui_state.prepare / operation to confirm. '
        'Payload is effectively EMPTY ({}); the handler calls applyFilters() and does NOT read '
        'fp/fs/notch from its own payload — it consumes whatever is already in the Prepare panel. So to '
        'prepare with specific values: FIRST detection.set_parameters '
        '{"filter":{"fp":80,"fs":250},"line_noise_notch_hz":60,"resample_sfreq":1000,"n_jobs":4} to '
        'write the controls, THEN analysis.prepare_recording {} to run the pass. DISTINCT FROM '
        'detection.set_parameters, which only WRITES values into the Prepare panel instantly and '
        'computes NOTHING — never emit prepare_recording just to set a notch or filter value. DISTINCT '
        'FROM detection.run (that detects events; this only creates the cleaned input) and '
        'detection.plan (that recommends settings; this applies/produces). Also do NOT reach for the '
        'pyhfo_prepare_recording backend tool in the desktop co-pilot — it bypasses the Apply gate; '
        'always go through this emit_ui_command.'
    ),
    'recording.infer_roi': (
        'Infer the label-free brain-signal ROI — which loaded channels are genuine brain-signal '
        'electrodes vs non-brain/reference/technical channels — and populate default detection '
        'exclusions in the Prepare/analysis panel. Use for "which channels are brain signal / relevant", '
        '"figure out the ROI", "which electrodes should I include/exclude", or "pick the channels to '
        'detect on". Instant analysis-class command (no Apply gate, requiresRecording); runs in the '
        'BACKGROUND and its results appear in get_ui_state.analysis (roi/qc/spectral) with the '
        'dispatched op under get_ui_state.operation — NOT in the emit result — so read those back before '
        'reporting counts, and never fabricate a channel list. Payload is empty ({}). IMPORTANT: '
        'infer_roi, analysis.run_qc, and analysis.compute_spectral_profile all dispatch the SAME single '
        'analyzeRecordingPlanning() ROI->QC->spectral pass — call exactly ONE of the three, not several, '
        'then read whichever slice you need from get_ui_state.analysis. Pick infer_roi when the question '
        'is about CHANNEL SELECTION / brain-vs-non-brain scope; run_qc for bad/flat/noisy quality; '
        'compute_spectral_profile for the Nyquist/frequency/line-noise picture. DISTINCT FROM '
        'recording.set_channel_visibility (that just changes which channels are drawn) and from '
        'detection.set_parameters channel-drops (that writes exclusions you already chose); infer_roi '
        'COMPUTES the recommended ROI.'
    ),
    'analysis.compute_spectral_profile': (
        "Compute the recording's spectral profile and the Nyquist / line-noise evidence — the "
        'power-spectrum picture used to answer "is the sampling rate high enough for the fast-HFO '
        'band?", "where\'s the line noise, 50 or 60 Hz?", "what\'s the Nyquist frequency", or "show me the '
        'spectral/PSD profile". Instant analysis-class command (no Apply gate, requiresRecording); runs '
        'in the BACKGROUND with results under get_ui_state.analysis.spectral (Nyquist, per-band power, '
        'detected line-noise frequency) and the op under get_ui_state.operation — read those back rather '
        'than quoting numbers from the emit result, and never state a Nyquist/line-noise value you did '
        'not read. Payload is empty ({}). IMPORTANT: this, recording.infer_roi, and analysis.run_qc all '
        'fire the SAME single ROI->QC->spectral pass, so call ONLY ONE of the three (this one when the '
        'question is about frequency/spectrum/Nyquist/line-noise); calling run_qc or infer_roi too just '
        'repeats the same work. Use the resulting Nyquist to gate detection choices — e.g. the 250-500 '
        'Hz fast-HFO band needs fs>=~1052 Hz or it yields 0 events. DISTINCT FROM '
        'analysis.prepare_recording (this only MEASURES the spectrum; prepare_recording is the heavy '
        'write that actually applies a notch/filter and produces a cleaned file) and from '
        'detection.set_parameters (that writes a notch value without measuring anything).'
    ),
    'detection.plan': (
        'Recommend Nyquist-safe detector SETTINGS for a recording without running anything — a REAL '
        'backend recommend action (calls recommendParameters, goal-profile aware, uses metadata + any '
        'ROI evidence). It picks a biomarker/detector and filter band/notch, then WRITES the recommended '
        'values into the visible Prepare panel (so the clinician can review before running) and reports '
        'the recommended detector, validation status, and warnings. Applies instantly (analysis-class, '
        'no Apply gate); requiresRecording. Real payload keys (all optional): biomarker (defaults to '
        '"HFO"; also "Spindle"/"Spike"), detector (leave off to let the planner choose), and '
        'goal_profile (alias goal). Example for "what detector and settings should I use for HFO '
        'detection?": {"biomarker":"HFO"}. Steering the profile: '
        '{"biomarker":"HFO","goal_profile":"high_sensitivity"}. Use when the clinician asks WHICH '
        'detector/parameters to use, "recommend settings", "how should I detect this", or wants a '
        'Nyquist-safe starting point. DISTINCT FROM detection.set_parameters, which blindly WRITES exact '
        'values the clinician already named (no recommendation, no backend call) — detection.plan '
        'COMPUTES a recommendation and then fills the panel with it. DISTINCT FROM analysis.run_qc / '
        'recording.infer_roi / analysis.compute_spectral_profile, which run the shared ROI->QC->spectral '
        'evidence pass (raw signal analysis), whereas detection.plan CONSUMES that evidence to advise on '
        'detector config. DISTINCT FROM detection.run, which actually EXECUTES a detector and writes '
        'event artifacts (a staged compute) — detection.plan runs nothing. Typical flow: detection.plan '
        '-> review/adjust in Prepare (or detection.set_parameters) -> detection.run.'
    ),
    'detection.select_run': (
        'Make an EXISTING detector run the active run of the workspace — switches which run the Review '
        'pane, waveform overlays, and ranking/focus commands operate on. Applies instantly (view-class, '
        "no Apply gate): it activates the run, adds it to the visible overlays, and loads that run's "
        'events into review. requiredPayload run_id, and the run must already be loaded; an unknown '
        "run_id is validated to 'missing run'/noop (call get_ui_state.runs_detail for valid run_ids — "
        'never guess). Real payload key: run_id (the only field; the handler passes only '
        'command.payload.run_id). Example for "switch to the MNI run" / "look at the second detection": '
        '{"run_id":"<id from get_ui_state.runs_detail>"}. Use when the clinician has multiple runs and '
        'wants to work with a different one before ranking, focusing, reviewing, classifying, or '
        'accepting it. DISTINCT FROM detection.run, which CREATES a new run (staged compute) — '
        'select_run only switches among runs that already exist, computing nothing and never '
        're-detecting. DISTINCT FROM review.accept_run, which is a review_write that marks a run as the '
        'accepted run of record (staged for Apply) — select_run just makes it the current working run '
        'and does not endorse it. DISTINCT FROM the view/rank commands '
        '(detection.show_candidate_ranking, detection.rank_candidates, '
        'detection.focus_top_candidate_channel): those read/rank the ACTIVE run; call select_run FIRST '
        'when you need those to apply to a different run.'
    ),
    'detection.show_candidate_ranking': (
        'Refresh/surface the candidate-channel ranking evidence for the active run in the analysis panel '
        '— a PURE view refresh (view-class, applies instantly, no Apply gate, no chat run card). It '
        "recomputes the per-channel event-count/rate ranking from the run's detector CSV artifact and "
        'the result lands in get_ui_state.analysis.candidate_ranking (top channels, counts, per-minute '
        "rates). requiresRun AND that run must carry a CSV artifact; with none it reports noop ('no "
        "detector run with a CSV artifact to rank — run detection with CSV export first') — do not "
        'fabricate a ranking. Payload is normally empty: {}. Use for "show me the channel ranking", '
        '"display the candidate-channel table", or to re-surface the ranking view after switching runs. '
        'DISTINCT FROM detection.rank_candidates, which runs the SAME ranking but as an analysis/compute '
        'op that posts a chat run card and closes the agent loop — use rank_candidates when the '
        "clinician's GOAL is to compute/get the ranking answer, and show_candidate_ranking for a "
        'lightweight view-only refresh of what already exists. DISTINCT FROM '
        'detection.focus_top_candidate_channel, which navigates the WAVEFORM to the single busiest '
        'channel rather than listing the ranked table, and from waveform.focus_hotspot_channels, which '
        'focuses the top-N channels in the waveform. All of these read the ACTIVE run, so call '
        'detection.select_run first if you mean a different run.'
    ),
    'recording.open': (
        'Load a specific recording file into the workspace, REPLACING whatever recording (and its '
        'runs/labels/viewport) is currently loaded. Use only when the clinician names or points at a '
        'file to open/load/import — e.g. "open /data/pt07.edf", "load this EDF", "switch to the '
        'fast-ripple case file". requiredPayload input_path — must be an absolute file path '
        "(EDF/BDF/etc.); no path -> validated 'missing input_path' and nothing loads. DESTRUCTIVE and "
        'confirm-gated: this discards the active workspace, so under review autonomy it stages for the '
        "clinician's Apply and the desktop first runs its unsaved-work guard (save/discard/cancel) — say "
        '"staged" / "this will replace the current recording, Apply to confirm", never "loaded", until '
        'get_ui_state.recording_path shows the new file. Note recording.open is NOT auto-applied even '
        'under auto-run autonomy (destructive risk requires full autonomy). It runs an async load op; '
        'wait_for_ui_command(command_id) before reporting the recording is open. DISTINCT FROM '
        'project.open (which restores a saved project case with its runs/labels/action-log, not a raw '
        'signal file) and from analysis.prepare_recording (which derives a cleaned COPY of the '
        'ALREADY-loaded recording — it does not open a new file). If a recording is already loaded and '
        'the user only wants to look at it, do NOT re-open it; use recording.inspect_metadata / '
        'waveform.* instead.'
    ),
    'recording.select_channel': (
        'Select/highlight ONE named channel of the loaded recording and bring it to the front of the '
        'waveform. Use for "select POL ST1", "pick the LHH2 channel", "highlight channel A1". '
        'requiredPayload channel — must be an EXACT loaded channel name (call get_ui_state for the '
        "channels list); an unknown name is validated to 'missing channel'/rejected, and a name already "
        'focused comes back noop. Instant view-class action (applies immediately, no Apply). Effect: '
        'moves that channel to the top of the plotted set, sets the annotation channel, and switches '
        "waveform focus mode to 'highlight'. If you omit start_seconds/duration_seconds it does not move "
        'the time window; to also jump in time prefer waveform.focus_channel (which reads an optional '
        'start_seconds/duration_seconds in the SAME command) or pair with waveform.set_viewport. '
        'DISTINCT FROM recording.set_channel_visibility (restricts the visible channel SUBSET / count, '
        'e.g. {"channels":[...]} or {"visible_channels":8} — a multi-channel filter, not a '
        'single-channel highlight) and from waveform.center_event (which centers on a specific event, '
        'not a channel).'
    ),
    'waveform.set_amplitude_scale': (
        'Change the vertical amplitude scale (display gain) of the waveform so traces look '
        'taller/shorter — e.g. "increase the amplitude", "make the traces 2x taller", "zoom in '
        'vertically", "scale down the gain". Payload: {"amplitude_scale":2} (aliases amplitudeScale / '
        'scale are also accepted). The value must be a POSITIVE number; a missing/zero/negative value '
        'comes back noop and nothing changes. Instant view-class action (applies immediately, no Apply); '
        'a value already in effect also returns noop. This is purely a DISPLAY gain multiplier — it does '
        'not filter, re-reference, or alter the underlying signal or any detection. DISTINCT FROM '
        'waveform.set_viewport (horizontal/time navigation — start_seconds/duration_seconds), from '
        'waveform.set_display normalize_vertically (per-channel auto-normalization toggle rather than a '
        'fixed gain factor — note set_display can ALSO carry amplitude_scale, so use this command when '
        'gain is the only change), and from workspace.reset_waveform_view (which returns display toggles '
        'to defaults but does NOT touch the amplitude-scale factor).'
    ),
    'events.select_event': (
        'Select a single loaded review event by id — sets it as the current review-cursor event (updates '
        "the selected event and moves the backend event cursor via a 'select' action) WITHOUT touching "
        'the waveform viewport. Use it as the lightweight "make this event the current one" primitive: '
        'pick a specific event from a ranked/loaded list so a follow-up read or annotation targets it. '
        'requiredPayload event_id. Example: {"event_id":"evt-0042"}. Instant view-class command (applies '
        "immediately, no Apply gate). Validated to 'missing event'/noop if the event_id is not in the "
        'loaded set — call get_ui_state for valid event_ids rather than guessing. DISTINCT FROM '
        'review.focus_event: select_event ONLY selects the row/cursor and leaves the waveform where it '
        'is; review.focus_event does everything select_event does AND recenters the waveform time window '
        'on the event (bringing its channel to front). DISTINCT FROM events.move_cursor: select_event '
        'jumps to an explicit event_id you already know; move_cursor steps relative (next/prev) through '
        'the loaded events from the current selection. DISTINCT FROM events.stage_annotation: selecting '
        'an event does NOT label it — no review_write, nothing is staged for Apply.'
    ),
    'events.clear_staged_annotation': (
        'Remove/undo a human-review annotation (label + notes) previously staged on an event — the '
        'inverse of events.stage_annotation. Use it for "clear the label on this event", "un-mark / undo '
        'the annotation", "remove the accepted/artifact/rejected tag". requiredPayload event_id (if '
        'omitted the handler falls back to the currently selected event, but pass the explicit event_id '
        'when you know it). Example: {"event_id":"evt-0042","notes":"cleared — reconsidering on '
        'review"}. This is a review_write: it is STAGED and only takes effect after the clinician clicks '
        'Apply (the human-review gate), so say "staged for Apply", not "cleared", until a later '
        "get_ui_state/observation confirms it. Internally it clears the event's staged label (the "
        "'clear' branch of the review handler). DISTINCT FROM events.stage_annotation: stage_annotation "
        'WRITES a label (accepted/artifact/rejected/uncertain); clear_staged_annotation REMOVES whatever '
        'label is there and needs no label field. DISTINCT FROM review.accept_run: that is a run-level '
        "acceptance of the whole detection run of record, not a per-event label. Don't use clear to "
        'change a label — stage the new label directly (stage_annotation overwrites).'
    ),
    'review.focus_event': (
        'Focus a loaded event across BOTH the review list and the waveform: it selects the event (moves '
        'the review cursor, like events.select_event) AND recenters the main waveform time window on '
        "that event, bringing the event's channel to the front and switching channel-focus to the events "
        'view. Use it whenever your answer refers to a specific event and you want the workspace to "go '
        'look at it" — e.g. "show me event evt-0042", "take me to that HFO". requiredPayload event_id. '
        'Example: {"event_id":"evt-0042"}. Instant view-class command (no Apply gate). Validated to '
        "'missing event'/noop if the event_id is not loaded — read get_ui_state for valid ids first. "
        'DISTINCT FROM events.select_event: select_event only sets the current event and does NOT move '
        'the waveform; focus_event also navigates the waveform to it (same recentering as '
        'waveform.center_event, plus the review-cursor selection). DISTINCT FROM waveform.center_event: '
        'center_event recenters the waveform but is not the review-cursor primitive; focus_event does '
        'both. DISTINCT FROM review.open_event: open_event ALSO opens the Event Review dialog (the full '
        'evidence packet as a modal); focus_event just navigates the existing panes without popping a '
        'dialog. DISTINCT FROM events.stage_annotation: focusing an event is read-only navigation — it '
        'stages no label.'
    ),
    'batch.create': (
        'Create a resumable batch manifest that enumerates every recording under a folder so a whole '
        'cohort can be processed in one pass — the SCAN/ENROLL half of batch processing. It writes a '
        'manifest file (one entry per discovered case) but runs NOTHING; it is the prerequisite that '
        'produces the manifest_path that batch.run later consumes. Use it for "set up a batch over '
        '/data/cohort", "scan this folder of EDFs for batch detection", or "enroll every recording in '
        'this directory". requiredPayload input_dir (the folder to scan; no input_dir -> validated '
        "'missing input_dir' and it fails). Optional: output_dir (where the manifest/results land; "
        'defaults next to input_dir) and recursive (bool, defaults TRUE — subfolders are included unless '
        'set false; the handler treats recursive!==false as true). Example: {"input_dir":"/data/cohort"} '
        'or {"input_dir":"/data/cohort","output_dir":"/data/cohort_out","recursive":false}. This is an '
        "artifact_write — STAGED for the clinician's Apply, not instant. On Apply it returns the "
        'manifest_path and a case count. DISTINCT FROM batch.run: batch.create only builds the manifest '
        '(no detection is executed); batch.run takes that manifest_path and actually runs the pipeline '
        'over every case. Also DISTINCT FROM detection.run, which detects on the single loaded '
        'recording, not a folder of files. If the user gives a folder AND asks to process it in one '
        'turn, create the manifest first, then batch.run its manifest_path.'
    ),
    'batch.run': (
        'Execute a previously-created batch manifest — the RUN half of batch processing, running the '
        'detection pipeline over every case the manifest enumerates. Use it for "run the batch", '
        '"process the cohort now", or "run detection on all cases in this manifest". requiredPayload '
        'manifest_path (the file batch.create produced; the alias manifest is also accepted). Detection '
        'settings are folded by the renderer into a nested detection block — you may pass '
        'biomarker/detector/filter/n_jobs FLAT and the handler nests them; but the backend reads them '
        'ONLY from detection, so never rely on top-level keys surviving on their own, and if a case '
        'seems to fall back to the HFO/STE default it is because the nesting was bypassed. Example: '
        '{"manifest_path":"/data/cohort_out/batch_manifest.json","biomarker":"HFO","detector":"STE","filt'
        'er":{"fp":80,"fs":250},"n_jobs":1}. Optional flags: retry_failed (bool — re-run only cases that '
        'previously failed; the manifest is resumable) and fail_fast (bool — stop at the first failure). '
        "Risk is COMPUTE (not artifact_write) — STAGED for the clinician's Apply; on Apply it reports "
        'complete/total/failed counts. DISTINCT FROM batch.create: batch.create scans a folder and '
        'writes the manifest but runs nothing; batch.run consumes that manifest_path and does the actual '
        'work — you cannot batch.run a folder path, only a manifest. DISTINCT FROM detection.run, which '
        'detects on the one loaded recording rather than a manifest of many files. If no manifest_path '
        'exists yet, call batch.create first (or ask the user for the manifest path) rather than '
        'inventing one.'
    ),
}

# Intent/clinical synonyms folded into the search haystack so a goal phrased in a clinician's words
# ("which channel has the most ripples", "clean and notch the recording") still finds the right command.
# Keys that aren't in the loaded catalog are simply ignored. Include common plurals/abbreviations.
SEARCH_KEYWORDS = {
    'workspace.open_panel': 'open panel dialog window show view tab detect classify review stats artifacts actions',
    'workspace.reset_waveform_view': 'reset clear default restore waveform view zoom out start over normal default view clear filters clear montage back to default',
    'recording.open': 'open load import file path edf bdf recording dataset switch recording replace recording load case load file open recording',
    'recording.inspect_metadata': 'metadata info recording info header details sampling rate frequency fs duration length channels channel count about recording show info file details',
    'recording.infer_roi': 'roi region of interest brain signal channels electrodes relevant which channels include exclude scope non-brain reference technical channel selection default exclusions grey out pick channels to detect on',
    'recording.select_channel': 'select choose pick highlight channel electrode contact single channel focus one channel bring to front',
    'recording.set_channel_visibility': 'hide show visibility channel toggle',
    'analysis.run_qc': 'qc quality control check bad channels flat noisy outlier amplitude saturation nan artifacts technical',
    'analysis.compute_spectral_profile': 'spectral spectrum frequency power band psd fft nyquist profile line noise 50hz 60hz sampling rate too low feasibility power spectral density notch high frequency band',
    'analysis.prepare_recording': 'prepare preprocess clean cleaned filter bandpass notch line noise 60hz 50hz reref re-reference montage bipolar resample downsample drop bad flat outlier channels derived copy prepared fif artifact stage for detection make ready produce cleaned file',
    'detection.plan': 'plan recommend suggest advise detector settings parameters config configuration which detector what settings to use starting point nyquist safe filter band notch recommendation propose best detector goal profile sensitivity specificity',
    'detection.run': 'detect detection run hfo hfos ripple ripples fast ripple spindle spindles spike spikes biomarker ste mni hil rms linelength yasa molle a7 lsm',
    'detection.set_parameters': 'set update change adjust parameter parameters filter band fp fs lowpass highpass cutoff bandpass notch line noise hz resample n_jobs njobs threshold rms epoch window configure tune detector ste mni without running',
    'detection.rank_candidates': 'rank ranking candidate channels most events rate count top busiest channels which channel',
    'detection.select_run': 'select choose switch set active run detection run change current pick activate load run switch runs multiple runs work with run make active another run different run second run',
    'detection.show_candidate_ranking': 'show display view surface candidate channel ranking table list ranked channels which channels most events rate count refresh ranking evidence per minute top channels channel table candidate list see ranking',
    'detection.focus_top_candidate_channel': 'show channel most events top candidate highest rate busiest hotspot which channel has the most',
    'detection.create_consensus_run': 'consensus combine merge runs agreement multiple detectors stable',
    'classification.run': 'classify classification artifact spike ehfo predict label events run classifier',
    'classification.set_parameters': 'classifier parameter parameters mode device batch size threshold set update configure without running spike ehfo sub-classifier subclassifier enable disable toggle turn on off preset models',
    'severity.run': 'severity severe severity score how bad how severe abnormal abnormality grade grading rate the eeg overall score based model scalp eeg whole recording 0-5 encephalopathy background severity',
    'waveform.set_viewport': 'viewport scroll move time window go to navigate jump waveform seconds',
    'waveform.focus_channel': 'focus channel show channel zoom channel waveform trace bring up channel highlight channel at time channel window around time',
    'waveform.center_event': 'center centre event show waveform around event jump to event go to event focus event ripple hfo spike show me event',
    'waveform.set_amplitude_scale': 'amplitude scale gain vertical zoom taller shorter microvolt uv magnify traces bigger smaller display gain',
    'waveform.set_display': 'display show filtered filter 60hz 50hz normalize montage amplitude scale channels',
    'waveform.focus_hotspot_channels': 'hotspot top channels most events busiest show event dense',
    'events.select_event': 'select event choose pick highlight set current event by id target event cursor loaded event',
    'events.move_cursor': 'cursor move next previous event navigate',
    'events.stage_annotation': 'annotate label mark tag accept reject artifact uncertain physiological pathological review event confirm',
    'events.clear_staged_annotation': 'clear remove undo delete unstage unmark reset revert discard staged annotation',
    'review.focus_event': 'focus event show go to navigate center waveform on event highlight event review pane jump to event look at event',
    'review.open_event': 'open event review dialog evidence inspect snippet detail packet feature summary event detail open review view event evidence',
    'review.open_comparison': 'compare comparison compare runs run statistics stats run stats difference between runs overlap difference open comparison run summary',
    'review.accept_run': 'accept approve finalize run sign off',
    'review.group_overlaps': 'overlap overlapping cross channel group co-occur co-occurring simultaneous concurrent events cluster overlap groups grouping',
    'artifacts.open_report': 'artifact artifacts open report open file output html pdf view report open artifact show report existing report',
    'export.session': 'export session save session reproducible checkpoint bundle snapshot pybrain npz handoff archive reload resume portable state export everything',
    'export.workbook': 'export workbook excel xlsx csv spreadsheet table events per channel stats data dump download events tabular analysis pandas',
    'export.report': 'export report html pdf summary document case write up narrative clinical summary case report generate report sign off document',
    'batch.create': 'batch create scan enroll cohort folder directory manifest set up multiple recordings edfs prepare batch build manifest list cases recursive subfolders',
    'batch.run': 'batch run process cohort execute manifest resume resumable retry failed fail fast multiple recordings folder detect all cases run detection over cohort',
    'project.save': 'save project persist store case workspace save my work save session file keep progress checkpoint project write project file',
    'project.open': 'open load project resume case workspace file',
}


_DETECTORS_BY_BIOMARKER = {
    "HFO": {"ste", "mni", "hil", "rms", "linelength", "line length", "ll"},
    "Spindle": {"yasa", "lsm", "kramer lsm", "a7", "molle", "fasst", "spindle rms"},
    "Spike": {"rms/ll", "rmsll", "ll", "rms", "linelength", "line length"},
}


def _text(value) -> str:
    return str(value or "").strip()


def _normalize_biomarker(value) -> str:
    raw = _text(value).lower()
    aliases = {
        "hfo": "HFO",
        "hfos": "HFO",
        "ripple": "HFO",
        "ripples": "HFO",
        "spindle": "Spindle",
        "spindles": "Spindle",
        "spike": "Spike",
        "spikes": "Spike",
    }
    return aliases.get(raw, raw)


def _normalized_detector_key(value) -> str:
    return _text(value).lower().replace("_", " ").replace("-", " ")


def _nonempty_mapping(value) -> bool:
    return isinstance(value, dict) and any(item not in (None, "", []) for item in value.values())


def _nonempty_sequence_or_text(value) -> bool:
    if isinstance(value, (list, tuple, set)):
        return len(value) > 0
    return bool(_text(value))


def _has_confirmed_default_contract(payload: dict) -> bool:
    return payload.get("confirmed_defaults") is True or payload.get("use_defaults") is True


def _has_protocol_contract(payload: dict) -> bool:
    if _has_confirmed_default_contract(payload):
        return True
    return any(_text(payload.get(key)) for key in ("protocol", "detection_protocol", "protocol_name"))


def _has_parameter_contract(payload: dict) -> bool:
    if _has_protocol_contract(payload):
        return True
    if any(_text(payload.get(key)) for key in ("parameter_preset", "preset")):
        return True
    return _nonempty_mapping(payload.get("detector_params")) or _nonempty_mapping(payload.get("ui_values"))


def _has_filter_contract(payload: dict) -> bool:
    if _has_protocol_contract(payload):
        return True
    return _nonempty_mapping(payload.get("filter"))


def _has_scope_contract(payload: dict) -> bool:
    if _has_protocol_contract(payload):
        return True
    if payload.get("all_channels") is True or payload.get("allChannels") is True:
        return True
    if any(_text(payload.get(key)) for key in ("scope", "channel_scope", "channelScope")):
        return True
    return any(_nonempty_sequence_or_text(payload.get(key)) for key in ("include_channels", "exclude_channels", "channels", "channel_names"))


def _detection_clarification_question(biomarker: str) -> str:
    if biomarker == "HFO":
        return "Which HFO detector/protocol and result-shaping settings should I use: filter band, detector parameters or preset/defaults, and channel scope?"
    if biomarker == "Spindle":
        return "Which spindle detector/protocol and result-shaping settings should I use: spindle band or preset/defaults, filter band, and channel scope?"
    if biomarker == "Spike":
        return "Which spike detector/protocol and result-shaping settings should I use: parameters or preset/defaults, filter band, and channel scope?"
    return "Which detector/protocol and result-shaping settings should I use: parameters or preset/defaults, filter band, and channel scope?"


def _detection_run_payload_policy_error(payload) -> dict | None:
    if not isinstance(payload, dict):
        return {
            "error": "detection.run payload must be an object.",
            "question": "Which detector/protocol, parameters or preset/defaults, filter band, and channel scope should I use?",
        }
    biomarker = _normalize_biomarker(payload.get("biomarker"))
    detector = _text(payload.get("detector") or payload.get("method"))
    missing = []
    if biomarker not in _DETECTORS_BY_BIOMARKER:
        missing.append("supported biomarker")
    if not detector:
        missing.append("detector/protocol")
    if detector and biomarker in _DETECTORS_BY_BIOMARKER:
        detector_key = _normalized_detector_key(detector)
        squashed = detector_key.replace(" ", "").replace("/", "")
        allowed = _DETECTORS_BY_BIOMARKER[biomarker]
        if detector_key not in allowed and squashed not in {item.replace(" ", "").replace("/", "") for item in allowed}:
            return {
                "error": f"detection.run was not staged because detector {detector!r} is not a supported {biomarker} detector.",
                "question": _detection_clarification_question(biomarker),
            }
    if detector:
        if not _has_parameter_contract(payload):
            missing.append("detector parameters, a preset, or confirmed defaults")
        if not _has_filter_contract(payload):
            missing.append("filter band")
        if not _has_scope_contract(payload):
            missing.append("channel scope")
    if missing:
        return {
            "error": f"detection.run was not staged because the payload did not specify {', '.join(missing)}.",
            "question": _detection_clarification_question(biomarker),
        }
    return None


def _command_payload_policy_error(command_type: str, payload) -> dict | None:
    if command_type == "detection.run":
        return _detection_run_payload_policy_error(payload)
    return None


def _catalog_hint() -> str:
    lines = []
    for t in sorted(CATALOG):
        spec = CATALOG[t]
        req = spec.get("required_payload") or []
        payload = f" payload:{{{', '.join(req)}}}" if req else ""
        staged = " [STAGED write — human Apply]" if (spec.get("requires_confirmation") or spec.get("risk") in WRITE_RISKS) else ""
        lines.append(f"- {t}{payload}{staged}")
    return "\n".join(lines)


def _usage_hint() -> str:
    return "\n".join(f"- {name}: {text}" for name, text in COMMAND_USAGE.items())


# ── broker client ─────────────────────────────────────────────────────────────
def _broker(method: str, path: str, body: dict | None = None) -> dict:
    headers = {"content-type": "application/json"}
    if BROKER_TOKEN:
        headers["authorization"] = f"Bearer {BROKER_TOKEN}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{BROKER}{path}", data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode() or "{}")


# ── tool implementations ────────────────────────────────────────────────────────
def tool_get_ui_state() -> str:
    try:
        state = _broker("GET", "/ui/state").get("ui_state", {})
    except Exception as exc:
        # Broker unreachable (desktop UI disconnected / still starting). Return a CLEAR,
        # model-actionable failure instead of letting a cryptic urlopen error bubble up —
        # otherwise the model reads "empty state" as a normal sparse read.
        return json.dumps({
            "success": False,
            "connected": False,
            "error": f"Could not read the desktop UI state — the UI broker is unreachable ({exc}). "
                     "The desktop UI is not connected (or still starting); treat live panel/viewport/"
                     "selection/channels as UNKNOWN, not as empty.",
        }, ensure_ascii=False)
    image = state.pop("waveform_image", None)
    state["waveform_image_available"] = bool(image)
    return json.dumps(state, ensure_ascii=False)


def tool_emit_ui_command(args: dict) -> str:
    command_type = _text(args.get("type"))
    payload = args.get("payload") or {}
    policy_error = _command_payload_policy_error(command_type, payload)
    if policy_error is not None:
        return json.dumps({
            "success": False,
            "staged": False,
            "clarification_required": True,
            "blocked_by_policy": "detection_run_payload_validation",
            "command_type": command_type,
            **policy_error,
            "agent_message_policy": (
                "Do not call emit_ui_command(detection.run) again until the user/protocol has specified "
                "detector/protocol, detector parameters or preset/defaults, filter band, and channel scope. "
                "Ask the clarification question instead of claiming the run is staged."
            ),
        }, ensure_ascii=False)
    emit_body = {"type": command_type, "payload": payload, "reason": args.get("reason")}
    # This field is intentionally absent from the model-visible tool schema.  The runtime adapter
    # injects its trusted per-turn scope after model argument generation; accepting it here merely
    # transports that binding to the broker, which validates it against the current renderer state.
    if "authority_scope" in args:
        emit_body["authority_scope"] = args.get("authority_scope")
    idempotency_key = _text(args.get("idempotency_key"))
    if idempotency_key:
        emit_body["idempotency_key"] = idempotency_key
    try:
        res = _broker("POST", "/ui/emit", emit_body)
    except Exception as exc:
        # Broker unreachable => the command never reached the UI: it is NOT staged and no Apply
        # button will appear. Make that unmistakable so the model does not narrate success
        # ("I've staged ... click Apply") off a bare connection error.
        return json.dumps({
            "success": False,
            "staged": False,
            "error": f"The command was NOT delivered to the desktop UI — the UI broker is unreachable "
                     f"({exc}). Nothing was staged and no Apply button will appear. Do NOT tell the user "
                     "the action is staged or to click Apply; report that it could not be sent to the UI "
                     "(the desktop may be disconnected or still starting).",
        }, ensure_ascii=False)
    if isinstance(res, dict):
        res = dict(res)
        command = res.get("command") if isinstance(res.get("command"), dict) else {}
        command_type = str(command.get("type") or args.get("type") or "")
        risk = str((CATALOG.get(command_type) or {}).get("risk") or "")
        needs_callback = risk in CALLBACK_RISKS
        res.setdefault("completion_unknown", needs_callback)
        res.setdefault("requires_completion_callback", needs_callback)
        res.setdefault(
            "agent_message_policy",
            "This only confirms delivery to the desktop UI. Do not claim the command completed or that an Apply "
            "button is waiting unless get_ui_state or visible command history shows it is still staged; desktop "
            "auto-run/full autonomy may start commands immediately. For commands with requires_completion_callback=true "
            "or risks analysis/compute/review_write/artifact_write/destructive, call wait_for_ui_command with command.command_id "
            "before giving a final result.",
        )
        # The broker's success only means ENQUEUED. The renderer re-validates against live state and may
        # reject/noop quickly; poll briefly so the agent does not narrate a no-op as success.
        command_id = str(command.get("command_id") or "")
        if command_id and res.get("success"):
            outcome = _poll_apply_outcome(command_id)
            if outcome is None:
                res["apply_outcome"] = "pending"
            else:
                res["apply_outcome"] = outcome
                raw_status = str(outcome.get("status") or "").lower()
                status = ACK_STATUS_ALIASES.get(raw_status, raw_status)
                reason = outcome.get("reason")
                if status in FAILURE_ACK_STATUSES:
                    res["success"] = False
                    res["applied"] = False
                    res["error"] = (
                        f"The desktop UI did NOT apply this command ({status}): "
                        f"{reason or 'nothing changed'}. Do NOT tell the user it was done. "
                        "Call get_ui_state to see the real loaded channels/events/runs and fix "
                        "the payload/target, then retry."
                    )
                elif status == "applied":
                    res["applied"] = True
                elif _is_renderer_staged_ack(outcome):
                    res["staged"] = True
    return json.dumps(res, ensure_ascii=False)


def _poll_apply_outcome(command_id: str):
    """Poll GET /ui/ack for the renderer's immediate apply/stage outcome."""
    if _ACK_POLL_BUDGET_MS <= 0:
        return None
    deadline = time.monotonic() + (_ACK_POLL_BUDGET_MS / 1000.0)
    while time.monotonic() < deadline:
        try:
            ack = _broker("GET", f"/ui/ack?command_id={quote(command_id)}").get("ack")
        except Exception:
            return None
        if ack:
            raw_status = str(ack.get("status") or "").lower()
            status = ACK_STATUS_ALIASES.get(raw_status, raw_status)
            # A durable receipt exists from enqueue time. Keep polling past that broker-local
            # `queued` marker so emit can still surface the renderer's immediate applied/noop/rejected
            # outcome. A renderer's staged callback remains observable through the canonical
            # queued -> queued renderer_ack transition recorded by the broker.
            if status != "queued" or _is_renderer_staged_ack(ack):
                return ack
        time.sleep(0.12)
    return None


def tool_wait_for_ui_command(args: dict) -> str:
    command_id = str(args.get("command_id") or "").strip()
    if not command_id:
        return json.dumps({"success": False, "error": "command_id is required."}, ensure_ascii=False)
    try:
        raw_timeout = args.get("timeout_seconds")
        timeout_seconds = 120.0 if raw_timeout is None else max(0.0, min(float(raw_timeout), 300.0))
    except (TypeError, ValueError):
        timeout_seconds = 120.0
    deadline = time.monotonic() + timeout_seconds
    last: dict | None = None
    while True:
        try:
            res = _broker("GET", f"/ui/ack?command_id={quote(command_id)}")
        except Exception as exc:
            return json.dumps({"success": False, "command_id": command_id, "error": f"Could not read UI command callback ({exc})."}, ensure_ascii=False)
        ack = res.get("ack") if isinstance(res, dict) else None
        if isinstance(ack, dict) and ack:
            last = ack
            raw_status = str(ack.get("status") or "").lower()
            status = ACK_STATUS_ALIASES.get(raw_status, raw_status)
            if status in FAILURE_ACK_STATUSES:
                return json.dumps({
                    "success": False,
                    "command_id": command_id,
                    "ack": ack,
                    "terminal": True,
                    "failure_status": status,
                    "error": f"The UI command ended with {status}; no successful postcondition was proved.",
                }, ensure_ascii=False)
            if status == "complete":
                return json.dumps({"success": True, "command_id": command_id, "ack": ack, "terminal": True}, ensure_ascii=False)
            if _is_renderer_staged_ack(ack):
                # Preserve the historical MCP response while carrying the canonical durable status.
                compatible_ack = {**ack, "receipt_status": "queued", "status": "staged"}
                return json.dumps({"success": True, "command_id": command_id, "ack": compatible_ack, "terminal": False}, ensure_ascii=False)
            if status == "applied":
                command_type = str(ack.get("command_type") or "")
                terminal_statuses = set((CATALOG.get(command_type) or {}).get("terminal_statuses") or [])
                if status in terminal_statuses:
                    return json.dumps({"success": True, "command_id": command_id, "ack": ack, "terminal": True}, ensure_ascii=False)
        if time.monotonic() >= deadline:
            return json.dumps({"success": False, "command_id": command_id, "timeout": True, "last_ack": last}, ensure_ascii=False)
        time.sleep(0.5)


def tool_inspect_waveform(args: dict) -> str:
    state = _broker("GET", "/ui/state").get("ui_state", {})
    image = state.get("waveform_image")
    if not image:
        return json.dumps({"success": False, "error": "No waveform image attached. Move the viewport / load a recording so the waveform is on screen, then retry."})
    api_key = os.getenv("IEEG_UI_VLM_API_KEY")
    base_url = (os.getenv("IEEG_UI_VLM_BASE_URL") or "").rstrip("/")
    model = os.getenv("IEEG_UI_VLM_MODEL")
    if not (api_key and base_url and model):
        return json.dumps({"success": False, "error": "Vision model not configured (set IEEG_UI_VLM_API_KEY/BASE_URL/MODEL)."})
    body = {"model": model, "messages": [{"role": "user", "content": [
        {"type": "text", "text": args.get("query") or "Describe this iEEG waveform window."},
        {"type": "image_url", "image_url": {"url": image}},
    ]}]}
    req = urllib.request.Request(f"{base_url}/chat/completions", data=json.dumps(body).encode(),
                                 method="POST", headers={"content-type": "application/json", "authorization": f"Bearer {api_key}"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            out = json.loads(r.read().decode())
        return json.dumps({"success": True, "result": out["choices"][0]["message"]["content"]}, ensure_ascii=False)
    except Exception as exc:
        return json.dumps({"success": False, "error": f"waveform inspection failed: {exc}"})


_STOPWORDS = frozenset(
    # fillers only — keep domain verbs like run/set/show/open/rank as searchable signals.
    # NB: short fillers like "as"/"at" MUST be here — otherwise "as" substring-matches the TYPE
    # "clASSification.run" (+3) and mis-ranks a compute run above events.stage_annotation.
    "a an and or the to of for with in on is are be can do i you it this that my our me please "
    "as at by want need how what which where".split()
)

# Internal/system commands that are never clinician-facing UI goals. They stay valid emit types and
# still appear in list_tool_categories, but are filtered out of search_tools so the agent can't pick
# one (e.g. agent.show_trace_step) for a real UI request like "show the filtered trace".
SEARCH_EXCLUDE = frozenset({"agent.show_trace_step", "workspace.show_toast"})


def _search_risk_rank(risk: object) -> int:
    """Tie-break weight: on equal score prefer the lighter command so an ambiguous intent never
    auto-escalates to a compute/write action (view < analysis < everything write-class)."""
    if risk == "view":
        return 0
    if risk == "analysis":
        return 1
    return 2


def _command_search_text(command_type: str, spec: dict) -> str:
    """CURATED keyword haystack (type words + risk + payload + SEARCH_KEYWORDS) — the STRONG search
    signal. Deliberately EXCLUDES the verbose COMMAND_USAGE prose: those entries cross-reference
    sibling commands ("distinct from stage_annotation…") for the model's benefit, and folding that
    prose in here let a look-alike tie the real target on an incidental mention. Usage prose is a
    weaker secondary signal via _command_usage_text."""
    parts = [command_type, command_type.replace(".", " ").replace("_", " "), str(spec.get("risk") or "")]
    parts.extend(str(field) for field in (spec.get("required_payload") or []))
    parts.append(SEARCH_KEYWORDS.get(command_type, ""))
    return " ".join(parts).lower()


def _command_usage_text(command_type: str) -> str:
    """Verbose playbook prose — a WEAK secondary search signal (it mentions siblings for the model's
    disambiguation, so an incidental hit here must never outweigh a curated-keyword hit)."""
    return str(COMMAND_USAGE.get(command_type, "")).lower()


def _command_tool_card(command_type: str, spec: dict) -> dict:
    """Render a catalog command as a discoverable, callable-from-emit tool card."""
    staged = bool(spec.get("requires_confirmation")) or spec.get("risk") in WRITE_RISKS
    return {
        "type": command_type,
        "name": command_type.replace(".", "_"),
        "risk": spec.get("risk"),
        "owner": spec.get("owner"),
        "effect": spec.get("effect"),
        "effect_class": spec.get("effect_class"),
        "research_impact": spec.get("research_impact"),
        "idempotency": spec.get("idempotency"),
        "retry": spec.get("retry"),
        "timeout_seconds": spec.get("timeout_seconds"),
        "approval_role": spec.get("approval_role"),
        "affected_resources": spec.get("affected_resources") or [],
        "postcondition": spec.get("postcondition"),
        "data_sensitivity": spec.get("data_sensitivity"),
        "staged": staged,
        "required_payload": spec.get("required_payload") or [],
        "requires": {
            "recording": bool(spec.get("requires_recording")),
            "run": bool(spec.get("requires_run")),
            "event": bool(spec.get("requires_event")),
        },
        "usage": COMMAND_USAGE.get(command_type, ""),
    }


def _search_catalog(query: str, limit: int) -> list[dict]:
    """Rank catalog commands against a free-text goal. Type matches weigh more than usage matches.

    Empty query → catalog-order listing (a browse fallback). This is the progressive-disclosure path:
    the agent searches by intent instead of being handed the whole command surface up front.
    """
    tokens = [tok for tok in re.split(r"[^a-z0-9]+", query.lower()) if tok and tok not in _STOPWORDS]
    scored: list[tuple[int, int, str, dict]] = []
    for command_type in sorted(CATALOG):
        if command_type in SEARCH_EXCLUDE:
            continue
        spec = CATALOG[command_type]
        matched = 0
        if tokens:
            type_l = command_type.lower()
            haystack = _command_search_text(command_type, spec)   # curated keywords — strong signal
            usage = _command_usage_text(command_type)              # playbook prose — weak signal
            score = 0
            for tok in tokens:
                if tok in type_l:
                    score += 3
                    matched += 1
                elif tok in haystack:
                    score += 2
                    matched += 1
                elif tok in usage:
                    score += 1
                    matched += 1
            if score <= 0:
                continue
        else:
            score = 0
        scored.append((score, matched, command_type, spec))
    # Tie-break order: score desc; then lighter risk (never escalate an ambiguous intent to a
    # compute/write command); then MORE distinct query words matched (a 3-keyword match beats a
    # single generic type-name hit like "channels"); then type name for determinism.
    scored.sort(key=lambda item: (-item[0], _search_risk_rank(item[3].get("risk")), -item[1], item[2]))
    return [_command_tool_card(command_type, spec) for _, _matched, command_type, spec in scored[: max(1, limit)]]


def tool_search_tools(args: dict) -> str:
    query = str(args.get("query") or "").strip()
    try:
        limit = int(args.get("limit") or 8)
    except (TypeError, ValueError):
        limit = 8
    matches = _search_catalog(query, limit)
    return json.dumps(
        {
            "query": query,
            "count": len(matches),
            "tools": matches,
            "hint": "Call emit_ui_command with one of these `type` values + a payload. Writes (staged:true) are held for the clinician to Apply.",
        },
        ensure_ascii=False,
    )


def tool_list_tool_categories(_args: dict) -> str:
    """Browse fallback: the whole command surface grouped by namespace, for when search misses."""
    categories: dict[str, list[str]] = {}
    for command_type in CATALOG:
        namespace = command_type.split(".")[0]
        categories.setdefault(namespace, []).append(command_type)
    out = [{"category": namespace, "count": len(types), "commands": sorted(types)} for namespace, types in sorted(categories.items())]
    return json.dumps(
        {
            "categories": out,
            "total": len(CATALOG),
            "hint": "Pick a category to see its commands, then search_tools(query) for the exact one, then emit_ui_command.",
        },
        ensure_ascii=False,
    )


def _tool_defs() -> list[dict]:
    defs = [
        {
            "name": "search_tools",
            "description": (
                "Search the iEEG desktop UI command catalog for the command(s) that accomplish a goal "
                "(e.g. 'run STE detection', 'set MNI detector params', 'rank candidate channels', 'open "
                "review panel'). Returns matching command `type`s with risk, required payload, and usage. "
                "Use this FIRST to find the exact command type, then call emit_ui_command with it. Prefer "
                "searching over guessing a type."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "What you want to do in the UI, in plain words."},
                    "limit": {"type": "integer", "description": "Max matches to return (default 8).", "default": 8},
                },
                "required": ["query"],
            },
        },
        {
            "name": "list_tool_categories",
            "description": (
                "List every UI command category (namespace) and the command types in each — a browse "
                "fallback for when search_tools doesn't surface what you need, or to see the whole UI "
                "surface at a glance. Then search_tools(query) for the exact command, or emit_ui_command."
            ),
            "inputSchema": {"type": "object", "properties": {}},
        },
        {
            "name": "emit_ui_command",
            "description": (
                "Operate the iEEG desktop UI — emit ONE command for the renderer to execute. `type` MUST be "
                "EXACTLY one of the allowlisted types below (do not invent types). VIEW/READ commands apply "
                "immediately; [STAGED write] commands are held for the clinician to Apply under review autonomy, "
                "but desktop auto-run/full autonomy may start compute commands immediately. "
                "For commands that return requires_completion_callback=true, call wait_for_ui_command(command_id) "
                "before giving a final result. Move/resize the waveform with waveform.set_viewport "
                "payload:{start_seconds, duration_seconds}.\n\n"
                "OUTCOME — the result includes a durable receipt. queued/staged means delivered but not terminal; "
                "compute-class applied is also non-terminal and must reach complete. success:false means it did NOT "
                "prove the requested postcondition: "
                "'rejected' = the target (channel/event/run) is not loaded — call get_ui_state for valid targets; "
                "'noop' = nothing changed, almost always because the payload keys were wrong/missing or the value "
                "was already in effect — re-read this playbook for the exact keys and retry. Never report a "
                "rejected/noop command as done. Use the EXACT payload keys shown below (mis-keyed fields are "
                "silently ignored and come back 'noop').\n\nCommand playbook:\n" + _usage_hint() + "\n\nValid types:\n" + _catalog_hint()
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "type": {"type": "string", "enum": sorted(CATALOG.keys()), "description": "Allowlisted UI command type."},
                    "payload": {"type": "object", "description": "Command-specific fields documented in the tool description, e.g. {\"start_seconds\":30,\"duration_seconds\":5}, {\"channel\":\"A1\"}, or {\"detector_params\":{\"rms_thres\":2}}."},
                    "reason": {"type": "string", "description": "Short human-facing note for the action trace."},
                    "idempotency_key": {"type": "string", "description": "Optional caller-generated retry key. Reuse only for the exact same command type and payload; the durable receipt returns the original command_id."},
                },
                "required": ["type"],
            },
        },
        {
            "name": "get_ui_state",
            "description": (
                "Read the clinician's current desktop UI state — use it to target emit_ui_command AND to VERIFY "
                "what a command did. Fields: viewport, channels, selected_channel/event/run, events, runs, "
                "waveform (display controls), and the panels/results you set: `prepare` (Prepare filter/notch/"
                "resample/n_jobs), `classify` (mode/device/batch_size/sub-classifiers), `analysis` (ROI/QC/spectral/"
                "candidate_ranking results), `runs_detail` (per-run detector/biomarker/events/accepted/active/"
                "visible), `operation` (a running op's status/progress — poll it to confirm an async analysis "
                "completed), `messages` (last status/review text), `active_dialog`/`active_tab`/`agent_tab` (what is "
                "open), `project` (path/dirty), and waveform_image_available. After a set_parameters / analysis / "
                "run command, read these back to confirm it took instead of assuming success."
            ),
            "inputSchema": {"type": "object", "properties": {}},
        },
        {
            "name": "wait_for_ui_command",
            "description": (
                "Wait for the renderer callback/ack for a previously emitted UI command. Use this after "
                "emit_ui_command for commands whose emit result has requires_completion_callback=true, and for "
                "analysis/compute/review_write/export/destructive commands before giving a final result. It models queued, "
                "applied, running, complete, failed, rejected, and noop; legacy staged/dismissed/error callbacks are mapped "
                "to canonical receipts. failed/rejected/noop are failures. A compute applied callback is not terminal; only "
                "its complete callback proves success. View/review commands may have terminal applied status by contract."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "command_id": {"type": "string", "description": "The command.command_id returned by emit_ui_command."},
                    "timeout_seconds": {"type": "number", "description": "How long to wait for a UI callback (default 120, max 300).", "default": 120},
                },
                "required": ["command_id"],
            },
        },
        {
            "name": "inspect_waveform",
            "description": "LOOK at the waveform the clinician is viewing (a vision model reads the live image). Use when asked what's on screen or whether a window looks like an HFO/spike/artifact. Signal-derived visual impression, not a diagnosis.",
            "inputSchema": {"type": "object", "properties": {"query": {"type": "string", "description": "What to look for."}}, "required": ["query"]},
        },
    ]
    return defs


_DISPATCH = {"search_tools": tool_search_tools, "list_tool_categories": tool_list_tool_categories, "get_ui_state": lambda a: tool_get_ui_state(), "emit_ui_command": tool_emit_ui_command, "wait_for_ui_command": tool_wait_for_ui_command, "inspect_waveform": tool_inspect_waveform}


# ── MCP JSON-RPC over stdio ─────────────────────────────────────────────────────
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
            _result(req_id, {"content": [{"type": "text", "text": json.dumps({'success': False, 'error': str(exc)})}], "isError": True})
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
            sys.stderr.write(f"[ieeg-ui-mcp] handler error: {exc}\n")
            sys.stderr.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
