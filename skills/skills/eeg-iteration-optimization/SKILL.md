---
name: eeg-iteration-optimization
version: 0.1.0
description: Iteratively improve EEG/iEEG preprocessing and PyHFO analysis by comparing runs and refining parameters from observed evidence.
category: neuroscience
keywords: [optimize, rerun, compare runs, parameter sweep, refine parameters, stable candidate, parameter sensitive]
triggers: [optimize, rerun, compare, parameter sweep, refine, tune, stable, parameter sensitive, improve detection]
allowed_tools: [pyhfo_compute_channel_qc, pyhfo_compute_spectral_profile, pyhfo_recommend_detector_plan, pyhfo_prepare_recording, pyhfo_detect_events, pyhfo_rank_candidate_channels, get_ui_state, emit_ui_command, wait_for_ui_command]
priority: 87
when_to_use: Use after an initial run when the user asks to optimize parameters, rerun, compare, or improve evidence quality.
do_not_use: Do not change many variables at once without stating what changed and why.
output_format: Prior evidence, proposed single-variable changes, rerun artifacts, comparison table, and recommended next action.
---

## Workflow

1. Start from previous tool outputs: warnings, counts, spectral profile, QC flags, and artifact paths.
2. Change one meaningful factor at a time when possible: ROI exclusions, notch, detector band, detector algorithm, preprocessing copy, or export mode.
3. Compare runs by event count/rate, channel stability, artifact warnings, and candidate overlap.
4. Prefer stable candidates across reasonable parameters over one-off high counts.
5. Explain every rerun from observed evidence, not guesses.
6. To classify an EXISTING saved run (e.g. flag artifact vs real events) without re-running the detector, locate the run via the session context (`last_detection_summary` / `candidate_analysis`), then in the desktop select it with `emit_ui_command` type `detection.select_run` and trigger classification with `emit_ui_command` type `classification.run`; call `wait_for_ui_command` for the classification command before summarizing — do not re-run `pyhfo_detect_events`.
