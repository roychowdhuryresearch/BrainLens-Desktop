---
name: eeg-result-interpretation
version: 0.1.0
description: Interpret EEG/iEEG QC and PyHFO outputs as signal-derived research evidence, including candidate channel ranking.
category: neuroscience
keywords: [interpret results, candidate channels, pathological channels, abnormal channels, event counts, HFO count, spike count, ranking]
triggers: [interpret, results, rank, ranking, candidate channel, pathological channel, abnormal channel, event counts, hfo count, spike count]
allowed_tools: [get_ui_state, emit_ui_command, pyhfo_rank_candidate_channels]
priority: 90
when_to_use: Use after QC/detection artifacts exist or when the user asks what the results mean.
do_not_use: Do not turn algorithmic candidates into clinical labels or diagnoses.
output_format: A colleague-style read in plain prose — the ranked candidate channels and their rates, which detection run they came from (in plain words, no file paths), and the key uncertainty. No labeled "decision trace" sections.
---

## Workflow

1. Read available state/artifacts and tool guidance.
2. In the Electron desktop, use `get_ui_state` first. If loaded review events already include channel counts and the user asks to see the most active channel or candidates, emit a view command: `detection.focus_top_candidate_channel` for one channel or `waveform.focus_hotspot_channels` for the top-N channels. This is a screen action, not a new detector run.
3. When the session context shows a last detection or candidate analysis, or the user refers to "my run / the results / which channels", call `pyhfo_rank_candidate_channels` to produce the ranked candidates — do NOT answer "which channels" from the session context alone. The session context locates the run; `pyhfo_rank_candidate_channels` is the only valid source of the ranked result.
4. Report event counts/rates, ROI exclusions, detector/filter settings, and warnings in plain words. Do not print artifact file paths or run directories to the clinician.
5. Clearly separate technical QC flags from candidate epileptiform/pathology-related signal evidence.
6. Use wording such as “signal-derived candidate channels” or “candidate epileptiform activity by algorithmic detection,” never definitive “pathological channels” from EDF alone.
7. For comparing/combining runs in the desktop: to fuse several detector runs into one agreement run emit `emit_ui_command` type `detection.create_consensus_run` ("combine the runs", "where do the detectors agree"); to group cross-channel events that co-occur in time for review without hiding or deleting any, emit `review.group_overlaps` ("group the simultaneous events"). To save or resume the whole case (recording, runs, labels, action log), use `project.save` / `project.open`. These are staged writes — report them as staged for Apply.
