---
name: eeg-format-understanding
version: 0.1.0
description: EEG/iEEG recording format and metadata understanding for EDF/BDF/BrainVision/FIF/BIDS-like files.
category: neuroscience
keywords: [EDF, BDF, BrainVision, VHDR, FIF, metadata, sampling rate, duration, channel names, line frequency, lowpass, highpass]
triggers: [edf, bdf, brainvision, vhdr, fif, metadata, sampling rate, sample rate, duration, channels, line frequency, file format]
allowed_tools: [pyhfo_get_recording_info, document_read_by_attachment]
priority: 88
when_to_use: Use when the task asks what a recording is, whether it is readable, or what metadata constrains downstream EEG/iEEG analysis.
do_not_use: Do not use for event interpretation after detection; hand off to eeg-result-interpretation.
output_format: Metadata summary, constraints, and next safe workflow step.
---

## Workflow

1. Call `pyhfo_get_recording_info` for file paths when metadata is unknown.
2. Report sample frequency, duration, channel count/names, highpass/lowpass, line frequency, format, and declared bads.
3. Explain constraints for downstream work: short duration, low sampling rate, missing line frequency, or unclear channel labels.
4. Do not infer clinical labels from metadata. Clinical labels are disabled by default.
