---
name: eeg-signal-roi
version: 0.1.0
description: Label-free real brain-signal ROI selection for EEG/iEEG before QC, detection, or candidate channel ranking.
category: neuroscience
keywords: [ROI, brain signal, channel selection, EKG, ECG, EOG, EMG, AUX, STIM, TRIG, X channel, pathological channel, abnormal channel]
triggers: [roi, brain signal, real brain, channel selection, exclude ekg, auxiliary channel, pathological channel, abnormal channel]
allowed_tools: [pyhfo_get_recording_info, pyhfo_infer_brain_signal_roi]
priority: 90
when_to_use: Use before preprocessing/detection/ranking, especially for EDF-only abnormal or pathological channel requests.
do_not_use: Do not use to make clinical localization claims.
output_format: Included brain channels, excluded channels with reasons, uncertain channels, and limits.
---

## Workflow

1. Ensure metadata is known with `pyhfo_get_recording_info` if needed.
2. Call `pyhfo_infer_brain_signal_roi`.
3. Exclude EKG/ECG/EOG/EMG/RESP/PLETH/AUX/STIM/TRIG/DC/SYNC/MARK and uncertain `X*` channels by default.
4. State that ROI is label-free and not clinical pathology localization.
5. Hand off to `eeg-qc-cleaning`, `eeg-preprocessing`, or `pyhfo-detection` depending on the request.
