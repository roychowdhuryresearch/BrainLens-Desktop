---
name: eeg-preprocessing
version: 0.1.0
description: EEG/iEEG preprocessing decisions for notch, bandpass, resampling, reference, and bipolar montage before PyHFO analysis.
category: neuroscience
keywords: [preprocessing, notch, 50 Hz, 60 Hz, bandpass, resample, bipolar montage, rereference, reference, montage]
triggers: [preprocess, preprocessing, notch, 60 hz, 50 hz, bandpass, resample, bipolar, montage, reference, rereference]
allowed_tools: [pyhfo_get_recording_info, pyhfo_infer_brain_signal_roi, pyhfo_compute_channel_qc, pyhfo_compute_spectral_profile, pyhfo_detect_line_noise, pyhfo_prepare_recording]
priority: 89
when_to_use: Use when creating a reproducible prepared recording or deciding filters/montage before detection.
do_not_use: Do not decide detector-specific HFO filter parameters here; hand off to pyhfo-detection.
output_format: Preprocessing settings, assumptions, output artifact path, and limitations.
---

## Workflow

1. Inspect metadata and ROI before preprocessing.
2. To decide notch: MEASURE first with `pyhfo_detect_line_noise` (and/or `pyhfo_compute_spectral_profile`) — never guess 50/60 Hz from geography. Do not notch unless the measurement, header `line_freq`, user, or site policy supports it; if `line_freq` is missing and nothing is measured, say so.
3. Do not re-bipolarize already-bipolar labels such as `A1-A2`. Use `bipolar_montage=auto_adjacent` only for clear monopolar sequential contacts. Use explicit `bipolar_pairs` when supplied by protocol/user.
4. Keep broad preprocessing bandpass separate from detector-specific HFO filters.
5. Call `pyhfo_prepare_recording` for reproducible cleaned FIF/FIF.GZ artifacts.
6. Once a prepared copy exists, downstream detection runs on that prepared artifact, not the raw recording — a later "detect ripples" still detects, but on the cleaned copy. Hand off detector-specific bands and parameters to pyhfo-detection.
