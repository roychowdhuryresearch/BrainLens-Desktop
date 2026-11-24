---
name: eeg-classification
version: 0.1.0
description: Classify detected EEG/iEEG events as real biomarker vs artifact (PyHFO artifact / spike / eHFO classifiers), either as part of a fresh detection or on an existing saved run.
category: neuroscience
keywords: [classify, classification, classifier, artifact, real vs artifact, artifact rejection, filter artifacts, remove artifacts, clean events, junk events, eHFO, spike classifier]
triggers: [classify, classification, classifier, artifact, artefact, real vs artifact, filter out artifact, remove artifact, clean up the events, clean those up, junk, ehfo, reject artifact]
allowed_tools: [get_ui_state, emit_ui_command, wait_for_ui_command, pyhfo_detect_events, pyhfo_rank_candidate_channels]
priority: 90
when_to_use: Use when the user wants to classify detected events as real vs artifact, filter/remove artifacts, or run the artifact/spike/eHFO classifier — on a fresh detection or an already-saved run.
do_not_use: Do not turn artifact-rejected/kept counts into clinical diagnoses; these are signal-derived candidates. Do not re-run the detector when a run already exists.
output_format: How classification was run (fresh vs existing run), kept (real candidate) vs rejected (artifact) event counts, and the next step.
---

## Workflow

### Desktop workstation mode

When `ui_state.recording.loaded` is true or the request comes from the Electron desktop, prefer staging a UI command instead of calling backend classification tools directly. The classifier action should be visible in Actions and applied from the workspace.

1. Use `get_ui_state` if needed to verify that a detection run exists (`selected_run`, `runs`, or `review.event_count > 0`).
2. If a run exists, call `emit_ui_command` with type `classification.run`, then call `wait_for_ui_command` using the returned `command_id` before giving a final result. Use payload fields such as `biomarker`, `mode`, `classifier`, and `classifier_label` only when the user specified them; otherwise let the desktop's visible Classify controls supply defaults.
   - `mode` must be one of the desktop classifier modes: `HF CPU`, `HF GPU`, `Custom`, or `Review only`.
   - Do not set `mode: "artifact"` for artifact-vs-real requests; omit `mode` or use the visible default (`HF CPU`) and describe the intent in `reason`.
3. Do not re-run detection for "classify these detected HFOs" when a run exists. Stage classification of the active run.
4. If no run exists and the user asks for detect+classify, first stage `detection.run` with classifier settings included, or clearly explain that detection must be run first.
5. After `wait_for_ui_command`, report the callback state: if staged, say it is waiting for Apply; if complete/failed, report that result. Do not claim kept/rejected counts until the desktop reports classification complete.

### Direct backend mode

1. First check whether a detection run already exists by consulting the session context (`last_detection_summary` / `candidate_analysis`). Classification works on a SAVED SESSION file (a `.pybrain` / `.npz` session), not a bare run id — so note the session/artifact path the run was exported to.
2. **If a detection run ALREADY exists**: do NOT re-detect. In the desktop, locate the run via the session context and select it with `emit_ui_command` type `detection.select_run`, then trigger classification with `emit_ui_command` type `classification.run` (passing `classifier: { "enabled": true }` in the payload). If the run has no saved session file yet, first export/re-run it WITH the session export so a session file exists, then classify that file.
3. **If there is NO run yet** and the user wants detection that already excludes artifacts: call `pyhfo_detect_events` with the classifier enabled AND a `session` export (so the cleaned run is saved and can be re-read), in one pass.
4. Only enable a classifier when the user asks for it (artifact/real-vs-artifact/clean). If the classifier or a saved session genuinely cannot be produced, say so plainly and report the raw detection instead — do not loop re-detecting.
5. Report how many events were KEPT as real candidates vs REJECTED as artifact (do not invent these counts — read them from the tool result).
6. If the user wants the channel answer, hand to `pyhfo_rank_candidate_channels` on the cleaned run.
7. Keep wording signal-derived: "events the classifier kept as candidate HFOs", not clinical labels.
