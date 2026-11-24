# Doctor Hero Prompt Eval Runbook

This runbook explains how to verify the doctor-facing PyHFO agent prompts without
hardcoding any service or LLM credentials.

## What Is Verified

- `tests/test_doctor_hero_prompt_catalog.py` validates the 30 long doctor hero
  prompts, safety invariants, current sidecar action availability, detector
  availability, and disabled-by-default label access/comparison gates.
- `pyhfo/tests/test_doctor_hero_workflow_eval.py` runs a deterministic
  doctor workflow on synthetic signal data without any LLM dependency.
- `tests/test_real_llm_doctor_hero_eval.py` is an opt-in live model gate. It
  checks representative first moves for metadata inspection, spindle detector
  availability, batch manifest creation, line-noise handling, and HFO feasibility.

## Deterministic Eval

Run this when no real LLM key is available:

```bash
python -m pytest -q \
  tests/test_doctor_hero_prompt_catalog.py \
  pyhfo/tests/test_doctor_hero_workflow_eval.py \
  pyhfo/tests/test_agent_api_sidecar.py \
  pyhfo/tests/test_agent_api_detection.py \
  tests/test_pyhfo_tools.py
```

This proves the catalog and PyHFO sidecar capabilities are internally consistent.
It does not prove a live model will choose the correct tool.

## Live LLM Eval

Set a real model key through the environment, not in source code:

```bash
export IEEG_REAL_LLM_EVAL=1
export IEEG_REAL_LLM_API_KEY=...
```

DashScope-compatible defaults are used when provider/model/base are omitted:

```bash
export IEEG_REAL_LLM_PROVIDER=qianwen
export IEEG_REAL_LLM_MODEL=qwen3.5-flash
export IEEG_REAL_LLM_API_BASE=https://dashscope.aliyuncs.com/compatible-mode/v1
```

Then run:

```bash
python -m pytest -q tests/test_real_llm_doctor_hero_eval.py
```

If no live key is set, this test is skipped by design.

## NLP Service Token

For a standalone evaluation, share one service token between the runtime and its clients.

```bash
export PYHFO_AGENT_SERVICE_TOKEN="$(python -c 'import secrets; print(secrets.token_urlsafe(32))')"
```

`PYHFO_AGENT_SERVICE_TOKEN` takes precedence over `AGENT_SERVICE_TOKEN`. Configure one of them for a standalone runtime and pass the same value to its clients.

## Label Gate

BIDS/channel clinical labels and candidate-vs-label comparison remain disabled by
default. Only enable them for an explicit evaluation study:

```bash
export PYHFO_AGENT_ENABLE_LABEL_LOADING=1
```

Normal EDF chat and doctor review workflows must stay label-free and signal-derived.
When the gate is enabled, use `compare_candidate_channels_to_bids_labels` only to
report agreement/disagreement between signal-derived candidate channels and BIDS
labels. Do not use labels to create or alter the candidate ranking.
