---
name: eeg-ieeg-pyhfo
version: 0.3.0
description: Legacy compatibility alias for broad EEG/iEEG PyHFO requests; automatic routing should prefer focused EEG/iEEG ReAct skills instead of this alias.
category: neuroscience
keywords: [eeg-ieeg-pyhfo, legacy PyHFO agent, compatibility alias]
triggers: [eeg-ieeg-pyhfo, legacy pyhfo agent, old pyhfo skill]
allowed_tools: [pyhfo_list_capabilities, pyhfo_get_capability_manifest, pyhfo_get_recording_info, pyhfo_infer_brain_signal_roi, pyhfo_compute_channel_qc, pyhfo_compute_spectral_profile, pyhfo_recommend_detector_plan, pyhfo_prepare_recording, pyhfo_detect_events, pyhfo_rank_candidate_channels, pyhfo_batch_create, pyhfo_batch_run, document_read_by_attachment, vl_query]
priority: 20
when_to_use: Use only for legacy clients that explicitly activate eeg-ieeg-pyhfo; new doctor-side and chat requests should let the ReAct runtime select focused skills step by step.
do_not_use: Do not use as the automatic router for normal EEG/iEEG/PyHFO requests; do not use for clinical diagnosis/treatment decisions.
output_format: Evidence read, selected focused workflow steps, tools/artifacts used, signal-derived evidence, warnings, and next research step.
---

## Compatibility intent

This skill is a backward-compatible alias, not a router. The agent is an EEG/iEEG-oriented ReAct assistant: it should reason over the user request and tool outputs, then activate or follow the focused skill that matches the current step.

Do not force every broad request through this alias. Prefer these focused skills directly:

- `eeg-format-understanding` for recording metadata and format constraints.
- `eeg-signal-roi` for label-free real brain-signal ROI selection.
- `eeg-qc-cleaning` for bad-channel and artifact evidence.
- `eeg-preprocessing` for notch/bandpass/resampling/reference/montage preparation.
- `pyhfo-detection` for detector planning and event detection.
- `eeg-result-interpretation` for candidate ranking and uncertainty.
- `eeg-iteration-optimization` for reruns and parameter refinement.
- `eeg-clinical-label-evaluation` only when label loading is explicitly enabled for evaluation.

## EDF-only pathology rule

For EDF-only pathology/abnormal-channel requests, do not load clinical labels. Inspect metadata, infer real brain-signal ROI, run QC/spectral planning, run signal detectors when supported, then report signal-derived candidate evidence only.
