---
name: eeg-clinical-label-evaluation
version: 0.1.0
description: Optional evaluation-only skill for comparing signal-derived EEG/iEEG candidates to clinical labels when label loading is explicitly enabled by system configuration.
category: neuroscience
keywords: [SOZ, resection, ground truth, channels.tsv, BIDS labels, evaluation, benchmark]
triggers: [soz, resection, ground truth, channels.tsv, bids labels, evaluate labels, benchmark]
allowed_tools: [pyhfo_get_recording_info, pyhfo_rank_candidate_channels]
priority: 60
when_to_use: Use only when the runtime explicitly enables clinical/BIDS label loading for evaluation.
do_not_use: Do not use in ordinary doctor-side EDF analysis; labels are disabled by default.
output_format: State label-loading status, what comparison is possible, and why labels are or are not available.
---

## Policy

Clinical/BIDS labels such as SOZ, resection, pathology labels, ground truth, and doctor annotations are disabled by default. Ordinary EDF-only analysis must use signal-derived evidence instead.

If label loading is not enabled by system configuration, explain that labels are unavailable and route to `eeg-result-interpretation` for signal-derived candidate evidence.
