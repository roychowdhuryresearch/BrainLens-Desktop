---
name: eeg-qc-cleaning
version: 0.1.0
description: EEG/iEEG signal quality and cleaning skill for flat channels, noisy/outlier channels, and bad-channel handling.
category: neuroscience
keywords: [QC, quality control, bad channel, flat channel, noisy channel, artifact, outlier, data cleaning, auto cleaning]
triggers: [qc, quality, bad channel, flat channel, noisy, artifact, outlier, data cleaning, clean data, auto cleaning, 坏道, 伪迹, 预处理]
allowed_tools: [pyhfo_get_recording_info, pyhfo_infer_brain_signal_roi, pyhfo_compute_channel_qc, pyhfo_compute_spectral_profile, pyhfo_detect_line_noise, pyhfo_prepare_recording]
priority: 89
when_to_use: Use when the task is about data quality, bad-channel handling, artifact screening, or conservative auto-cleaning.
do_not_use: Do not call outliers pathological; they are technical QC candidates unless supported by event evidence.
output_format: QC evidence, cleaning action/plan, conservative defaults, warnings, and next analysis step.
---

## Workflow

1. Confirm metadata and brain ROI first.
2. Call `pyhfo_compute_channel_qc` for RMS/std/peak-to-peak/flat/NaN/outlier evidence.
3. Call `pyhfo_compute_spectral_profile` when filter planning matters; for line-noise questions MEASURE with `pyhfo_detect_line_noise` rather than guessing 50/60 Hz.
4. Conservative policy: drop file-declared bad channels and flat channels when preparing a cleaned copy; flag amplitude outliers rather than dropping unless explicitly requested.
5. Use `pyhfo_prepare_recording` only with explicit output paths and stated cleaning choices.
6. Report all dropped, flagged, and retained channels separately.
