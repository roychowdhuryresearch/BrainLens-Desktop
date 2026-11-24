---
name: pyhfo-detection
version: 0.1.0
description: PyHFO HFO/spike/spindle detection skill with Nyquist-safe parameters, smoke-test policy, and artifact export.
category: neuroscience
keywords: [PyHFO, HFO, ripple, spike, spindle, STE, RMS, LineLength, detector, detection, event detection]
triggers: [pyhfo, hfo, ripple, spike, spindle, ste, rms, line length, detector, detect events, event detection]
allowed_tools: [get_ui_state, emit_ui_command, wait_for_ui_command, pyhfo_get_recording_info, pyhfo_infer_brain_signal_roi, pyhfo_compute_spectral_profile, pyhfo_recommend_detector_plan, pyhfo_prepare_recording, pyhfo_detect_events, pyhfo_rank_candidate_channels]
priority: 91
when_to_use: Use when the task requests HFO/spike/spindle detection or detector parameter selection.
do_not_use: Do not interpret final clinical meaning; hand off to eeg-result-interpretation.
output_format: In plain colleague-style prose — which detector and key parameters you used, the event counts/rates, any warnings, and the next step. Do not print artifact file paths or run directories to the clinician.
---

## Workflow

### Desktop workstation mode

When `ui_state.recording.loaded` is true or the request comes from the Electron desktop, prefer staging a UI command instead of calling backend detector tools directly. The physician should see the action in the workspace; depending on autonomy it may wait for Apply or start immediately.

1. Use `get_ui_state` if needed to confirm the loaded recording, selected run/event, viewport, channels, and current desktop autonomy.
2. Before any detector run, confirm the result-shaping choices: detector/protocol, parameter preset or explicit defaults, filter band, and channel scope. If any of those are underspecified, ask one concise clarification before emitting `detection.run`. Do not silently choose STE, MOLLE, YASA, thresholds, filter bands, or all-channel scope from an underspecified request.
3. For a requested detector run with explicit or confirmed result-shaping choices, call `emit_ui_command` with type `detection.run`, then call `wait_for_ui_command` using the returned `command_id` before giving a final result. Preserve explicit user parameters in `payload.detector_params`; do not silently fall back to defaults when the user supplied a value.
4. Use backend parameter keys, not UI labels:
   - STE: `rms_window`, `min_window`, `min_gap`, `min_osc`, `peak_thres`, `rms_thres`, `epoch_len`.
   - MNI: `epoch_time`, `min_win`, `per_CHF`, `thrd_perc`, `min_gap`, `epo_CHF`, `base_seg`, `base_shift`, `base_thrd`, `base_min`.
   - HIL: `pass_band`, `stop_band`, `sd_threshold`, `min_window`, `epoch_time`.
   - RMS: `rms_window`, `min_window`, `max_window`, `min_gap`, `threshold`, `peak_threshold`.
   - LineLength: `ll_window`, `min_window`, `max_window`, `min_gap`, `threshold`, `peak_threshold`.
5. Example: "use RMS = 2 detect STE" means detector `STE` with `detector_params: {"rms_thres": 2}`. It does NOT mean switch to the RMS detector.
6. "Ripples", "fast ripples", "HFOs", "spikes", and "spindles" are STANDARD, well-defined biomarkers — NEVER ask the clinician to define them or what they "refer to". A bare request like **"I want all ripples"**, "find the ripples", "detect all HFOs", "show me the HFOs", or "get the spikes" is a COMPLETE, actionable request — but FIRST check state, do not reflexively re-detect:
   - Call `get_ui_state` and read `runs_detail`. If a run with the SAME biomarker/band already exists, do NOT stage another `detection.run` — surface that run instead (rank/focus per steps 10–11). Re-detecting overwrites context, wastes work, and is not what "I want all ripples" means once they already exist on screen.
   - Stage `detection.run` only when NO matching run exists yet, OR the clinician explicitly asks to iterate/re-run ("run it again", "redo with threshold X", "try MNI instead") — a deliberate new run is fine, a silent duplicate of an existing one is not.
   - When you do run a standard all-HFO/ripple request, stage `detection.run` with `biomarker: "HFO"` (ripples AND fast ripples are HFOs), `scope: "all"`, `all_channels: true`, detector `STE`, a Nyquist-safe filter, `n_jobs: 1`, and exports `["csv", "session", "summary_json"]`, then rank/show the channels so the request actually surfaces them.
7. Band conventions are fixed — encode them, never ask which band:
   - "ripple(s)" ALWAYS = `filter: {"fp": 80, "fs": 250}` (not 80–500).
   - "fast ripple(s)" = `filter: {"fp": 250, "fs": 500}`, but FIRST gate on Nyquist: the fast-ripple band needs the recording's `sample_frequency` ≥ ~1052 Hz (so `0.95 · Nyquist ≥ 500`). On a ≤1024 Hz recording the band exceeds Nyquist and the run yields 0 events silently — explain the recording can't support the fast-ripple band instead of running it to nothing.
   - a bare "HFO" / "high-frequency" with no ripple/fast-ripple qualifier = 80–500 Hz, clamped Nyquist-safe.
8. For confirmed spindle requests, use a real spindle detector such as `MOLLE`, `A7`, `YASA`, or configured `LSM`; never emit `detector: "STE"` with `biomarker: "Spindle"`.
9. Ask for clarification ONLY about a specific PARAMETER VALUE you genuinely cannot map (e.g. an unusual threshold) — NEVER about the biomarker name or its band (ripple / HFO / fast ripple / spike / spindle are unambiguous, run them). When unsure about a parameter value, ask one concise question or use the Nyquist-safe default; never ignore an explicitly supplied value.
10. For "show me the channel with the most HFO", "most active HFO channel", "where are the HFOs", or similar view requests after a run is loaded, do not rerun detection. Use `get_ui_state`; if loaded events exist, emit `detection.focus_top_candidate_channel` with payload like `{"biomarker":"HFO","duration_seconds":2}`. For multiple hotspots, emit `waveform.focus_hotspot_channels` with payload like `{"biomarker":"HFO","top_n":8,"duration_seconds":4}`.
11. If no run/events are loaded and the user asks to show or rank HFO channels, explain that detection must run first, or stage `detection.run` only when the user is clearly asking to run detection. If a prepared copy exists (after `analysis.prepare_recording`), detection runs on that prepared artifact, not the raw recording.
12. After `wait_for_ui_command`, report the callback state: if staged, say it is waiting for Apply; if complete/failed, report that result. Do not claim event counts until the desktop reports the run complete.

### Direct backend mode

1. Ensure metadata, ROI, and basic QC/spectral planning exist.
2. Use `pyhfo_recommend_detector_plan` unless the user/protocol already specifies detectors.
3. For HFO/ripple work, compute Nyquist = sample frequency / 2. Use `fs <= min(500, 0.95 * Nyquist)`. Do not run HFO if Nyquist is below the target band.
4. Treat recordings shorter than 10 seconds as metadata/QC only. Treat 10-60 seconds as smoke-test only.
5. Prefer `n_jobs=1` for first single-case runs. Export `summary-json` and `csv` when ranking is needed.
6. If the request is to FIND / identify / rank the channels (not merely "run detection"), after `pyhfo_detect_events` you MUST call `pyhfo_rank_candidate_channels` to turn the events into the ranked channel answer the clinician asked for — detection alone does not answer "which channels".
7. Detection outputs are algorithmic events requiring expert review.
