# Doctor Hero Prompt Capability Matrix

Source of truth: `tests/fixtures/doctor_hero_prompts.json`.

This matrix answers whether the current iEEG/PyHFO agent can perform each
doctor-facing hero use case. It separates callable signal workflows from gated
clinical-label evaluation and live LLM acceptance.

## Current Summary

- Total hero prompts: 30
- Callable directly through named PyHFO tools: 18
- Callable through the ieeg_ui MCP (emit_ui_command): 11
- Disabled by default for safety: 1
- Remaining implementation gaps: none for normal signal-derived workflows
- Live LLM eval: opt-in only; requires `IEEG_REAL_LLM_API_KEY` or `DASHSCOPE_API_KEY`

## Safety Rules

- Unknown recordings must start with metadata or capability inspection.
- Clinical/BIDS labels are not loaded in ordinary EDF chat.
- Signal-derived candidates are not diagnosis, SOZ, treatment advice, or definitive pathology.
- Raw recordings are immutable; preprocessing writes explicit derived copies.
- Label comparison is evaluation-only and gated by `PYHFO_AGENT_ENABLE_LABEL_LOADING=1`.

## Matrix

| # | Prompt ID | Status | First Safe Tool | Capability |
|---:|---|---|---|---|
| 1 | `doctor-hero-001-recording-overview` | `callable` | `pyhfo_get_recording_info` | Read-only recording overview: sampling rate, duration, channels, format, line frequency, and readiness limits. |
| 2 | `doctor-hero-002-edf-pathology-label-free` | `callable` | `pyhfo_get_recording_info` | Label-free abnormal/pathology wording handling with ROI, QC, spectral planning, and candidate ranking boundary language. |
| 3 | `doctor-hero-003-roi-channel-triage` | `callable` | `pyhfo_get_recording_info` | Brain-signal ROI triage with auxiliary and uncertain channel exclusions. |
| 4 | `doctor-hero-004-qc-flat-noisy-review` | `callable` | `pyhfo_get_recording_info` | Bounded channel QC: flat channels, NaNs, amplitude outliers, and review-only warnings. |
| 5 | `doctor-hero-005-hfo-nyquist-feasibility` | `callable` | `pyhfo_get_recording_info` | HFO feasibility, spectral profile, Nyquist-safe detector planning, and unsupported-band warnings. |
| 6 | `doctor-hero-006-safe-prepared-copy` | `callable` | `pyhfo_get_recording_info` | Safe FIF/FIF.GZ prepared copy with explicit notch, bad-channel, flat-channel, and montage decisions. |
| 7 | `doctor-hero-007-hfo-smoke-detection` | `callable` | `pyhfo_get_recording_info` | Conservative HFO smoke run with ROI, spectral plan, `n_jobs=1`, summary JSON, and CSV artifacts. |
| 8 | `doctor-hero-008-candidate-channel-ranking` | `callable` | `pyhfo_rank_candidate_channels` | Candidate channel ranking from detector CSVs with rates, exclusions, and non-clinical language. |
| 9 | `doctor-hero-009-event-snippet-review` | `callable_via_mcp` | `review.open_event` | Focused event cursor and bounded waveform/time-frequency review packet. |
| 10 | `doctor-hero-010-staged-annotation` | `callable_via_mcp` | `events.stage_annotation` | Staged annotation flow; persistent labels require explicit `confirmed=true`. |
| 11 | `doctor-hero-011-review-report-export` | `callable_via_mcp` | `export.report` | Review-state and report export with limitations and artifact paths. |
| 12 | `doctor-hero-012-spike-screen` | `callable` | `pyhfo_get_recording_info` | First-pass spike screen with ROI/QC, detector plan, smoke detection, and candidate ranking. |
| 13 | `doctor-hero-013-spindle-review` | `callable` | `pyhfo_get_capability_manifest` | Spindle detector availability check plus supported smoke path; MOLLE/A7 are callable fallbacks when YASA is unavailable. |
| 14 | `doctor-hero-014-batch-manifest` | `callable` | `pyhfo_batch_create` | Cohort scan and resumable batch manifest creation before detection. |
| 15 | `doctor-hero-015-batch-smoke-run` | `callable` | `pyhfo_batch_run` | Fail-fast batch smoke run using an existing manifest and conservative detection config. |
| 16 | `doctor-hero-016-parameter-validation` | `callable_via_mcp` | `detection.plan` | Protocol parameter validation against recording metadata and Nyquist limits. |
| 17 | `doctor-hero-017-parameter-sweep` | `callable_via_mcp` | `detection.plan` | Bounded detector-parameter sweep planning without executing all candidates. |
| 18 | `doctor-hero-018-compare-detector-runs` | `callable_via_mcp` | `review.open_comparison` | Multi-run stability comparison: stable channels, run-specific channels, temporal overlaps, and missing evidence handling. |
| 19 | `doctor-hero-019-line-noise-decision` | `callable` | `pyhfo_get_recording_info` | Line-noise evidence and explicit-notch decision without guessing 50/60 Hz from geography. |
| 20 | `doctor-hero-020-already-bipolar-montage` | `callable` | `pyhfo_get_recording_info` | Prevents re-bipolarizing already bipolar labels and documents montage rationale. |
| 21 | `doctor-hero-021-resampling-safety` | `callable` | `pyhfo_get_recording_info` | Resampling decision tied to intended HFO bandwidth and Nyquist safety. |
| 22 | `doctor-hero-022-long-recording-bounded-qc` | `callable` | `pyhfo_get_recording_info` | Long-recording bounded preview QC and spectral profile with explicit duration limits. |
| 23 | `doctor-hero-023-label-gated-ground-truth` | `disabled_by_default` | `pyhfo_get_recording_info` | Evaluation-only BIDS/SOZ/resection loading and candidate-vs-label comparison behind `PYHFO_AGENT_ENABLE_LABEL_LOADING=1`. |
| 24 | `doctor-hero-024-classifier-existing-run` | `callable_via_mcp` | `classification.run` | Classifies existing saved active runs without rerunning detector discovery. |
| 25 | `doctor-hero-025-cross-channel-overlap` | `callable_via_mcp` | `review.group_overlaps` | Cross-channel overlap grouping for review without hiding/deleting events. |
| 26 | `doctor-hero-026-consensus-run` | `callable_via_mcp` | `detection.create_consensus_run` | Consensus candidate run creation from multiple source runs with support counts. |
| 27 | `doctor-hero-027-project-save-resume` | `callable_via_mcp` | `project.save` | Project save/resume/export with recording paths, artifacts, runs, labels, and action log. |
| 28 | `doctor-hero-028-waveform-overview-navigation` | `callable_via_mcp` | `waveform.set_viewport` | Bounded waveform channel list, overview bins, and focused window payloads. |
| 29 | `doctor-hero-029-failure-explanation` | `callable` | `pyhfo_get_recording_info` | Structured failed-run explanation using summary/state, metadata, parameters, and actionable retry causes. |
| 30 | `doctor-hero-030-real-llm-smoke-gate` | `callable` | `pyhfo_get_recording_info` | Live-model first-move gate for safe metadata inspection before diagnosis, ranking, or detection. |

## Verification Commands

Deterministic representative suite:

```bash
python -m pytest -q \
  tests/test_doctor_hero_prompt_catalog.py \
  pyhfo/tests/test_doctor_hero_workflow_eval.py \
  pyhfo/tests/test_agent_api_sidecar.py \
  pyhfo/tests/test_agent_api_detection.py \
  tests/test_pyhfo_tools.py
```

Live LLM gate, when a key is available:

```bash
IEEG_REAL_LLM_EVAL=1 IEEG_REAL_LLM_API_KEY=... \
  python -m pytest -q tests/test_real_llm_doctor_hero_eval.py
```

The live LLM gate is skipped when no real key is configured.
