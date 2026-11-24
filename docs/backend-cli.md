# Backend-only CLI

This document explains how to run the iEEG Agent backend without the Electron
desktop app. It is intended for researchers, pipeline developers, and external
integrators who want a scriptable backend surface for agent chat and PyHFO
analysis.

The current entry point is:

```bash
python -m runtime.cli <command>
```

The CLI program name is `ieeg-agent` internally, so a future package entry point
can expose the same commands as `ieeg-agent <command>` without changing the
command model.

## What It Starts

`python -m runtime.cli serve` starts:

- the iEEG agent runtime on `127.0.0.1:8001`;
- the bundled PyHFO local sidecar on `127.0.0.1:8765`;
- no Electron app;
- no UI broker;
- no configured MCP servers by default.

Built-in PyHFO tools remain available to the agent. Pass `--enable-mcp` only
when you deliberately want the configured MCP stack.

## Prerequisites

From the repository root, install the agent runtime dependencies in your Python environment. Configure a service token for the runtime and every client that connects to it.

```bash
python -m pip install -r requirements.txt
export AGENT_SERVICE_TOKEN="$(python -c 'import secrets; print(secrets.token_urlsafe(32))')"
```

For real PyHFO analysis, install the bundled PyHFO dependencies in a PyHFO
environment:

```bash
cd pyhfo
python -m venv .venv
. .venv/bin/activate
python -m pip install -e ".[spindle,severity,gpu]"
```

Then run backend commands from the repository root. Point the CLI at the PyHFO
environment when needed:

```bash
python -m runtime.cli serve --pyhfo-python pyhfo/.venv/bin/python
```

`chat` requires the same model/API key configuration as the agent runtime.
Direct `pyhfo` commands such as `info`, `prepare`, and `detect` do not require an
LLM key.

## Quick Start

Start the backend:

```bash
python -m runtime.cli serve --pyhfo-python pyhfo/.venv/bin/python
```

In another terminal with the same service token in its environment, check health:

```bash
python -m runtime.cli health
```

Inspect a recording:

```bash
python -m runtime.cli pyhfo --pyhfo-python pyhfo/.venv/bin/python info --input /path/to/case.edf
```

Inspect parameter defaults and a smoke-run recommendation:

```bash
python -m runtime.cli pyhfo --pyhfo-python pyhfo/.venv/bin/python \
  parameters defaults --biomarker HFO --detector STE --sample-freq 1000

python -m runtime.cli pyhfo --pyhfo-python pyhfo/.venv/bin/python \
  parameters recommend --goal-profile smoke --biomarker HFO --detector STE --sample-freq 1000
```

Ask the agent for a backend-only analysis plan:

```bash
python -m runtime.cli chat \
  --recording /path/to/case.edf \
  "Inspect this recording and propose a Nyquist-safe HFO detection plan."
```

Run detection:

```bash
python -m runtime.cli pyhfo --pyhfo-python pyhfo/.venv/bin/python \
  detect --input /path/to/case.edf --output runs/case01_hfo \
  --biomarker HFO --detector STE --filter fp=80 --filter fs=250 \
  --export summary-json --export csv --export session
```

Classify an existing saved detection session:

```bash
python -m runtime.cli pyhfo --pyhfo-python pyhfo/.venv/bin/python \
  classify --session runs/case01_hfo/session.pybrain --output runs/case01_classified \
  --biomarker HFO --classifier-param model_type=default_cpu \
  --classifier-param device=cpu --classifier-param batch_size=16 \
  --export summary-json --export csv --export session
```

Run a backend-only Quick Detection workflow:

```bash
python -m runtime.cli pyhfo --pyhfo-python pyhfo/.venv/bin/python \
  quick-detect --input /path/to/case.edf --output runs/case01_quick \
  --biomarker HFO --detector STE --goal-profile smoke \
  --export summary-json --export csv --export session
```

## Command Reference

### `serve`

Starts backend services and prints a JSON startup summary.

```bash
python -m runtime.cli serve [options]
```

Common options:

```text
--host HOST                 Agent bind host. Default: 127.0.0.1
--port PORT                 Agent port. Default: 8001
--token TOKEN               Agent service token
--enable-mcp                Enable configured MCP servers
--no-pyhfo                  Start only the agent runtime
--pyhfo-host HOST           PyHFO sidecar bind host. Default: 127.0.0.1
--pyhfo-port PORT           PyHFO sidecar port. Default: 8765
--pyhfo-token TOKEN         Optional PyHFO sidecar token
--pyhfo-root PATH           Alternate PyHFO app root
--pyhfo-python PATH         Python executable for PyHFO
--startup-timeout SECONDS   Startup health wait. Default: 60
```

Examples:

```bash
# Agent + PyHFO sidecar.
python -m runtime.cli serve --pyhfo-python pyhfo/.venv/bin/python

# Agent only.
python -m runtime.cli serve --no-pyhfo

# Use explicit ports.
python -m runtime.cli serve --port 8101 --pyhfo-port 8865
```

### `health`

Checks:

- agent public `/health`;
- agent authenticated `/internal/agent/v1/health`;
- PyHFO sidecar `/health`, unless skipped.

```bash
python -m runtime.cli health [options]
```

Common options:

```text
--agent-url URL       Default: http://127.0.0.1:8001
--pyhfo-url URL       Default: http://127.0.0.1:8765
--token TOKEN         Agent service token
--pyhfo-token TOKEN   Optional PyHFO sidecar token
--timeout SECONDS     Per-request timeout. Default: 5
```

Skip PyHFO health when the sidecar is not running:

```bash
python -m runtime.cli health --pyhfo-url ""
```

### `chat`

Sends one non-streaming request to a running agent backend.

```bash
python -m runtime.cli chat [options] "message"
```

Common options:

```text
--recording PATH          Recording path made available to PyHFO tools
--conversation-id ID      Reuse a conversation
--request-id ID           External request id
--url URL                 Agent base URL. Default: http://127.0.0.1:8001
--token TOKEN             Agent service token
--model MODEL             Override model for this request
--active-skill NAME       Bias/activate a specific skill
--no-search               Disable search flag in the request payload
--enable-mcp              Allow MCP servers instead of backend-only default
--all-skills              Do not restrict to backend-safe EEG/PyHFO skills
--json                    Print full JSON instead of only response content
```

By default, `chat` uses backend-only constraints:

- `allowed_mcp_servers` is an empty list;
- `allowed_skills` is restricted to EEG/PyHFO skills;
- request source is `backend-cli`.

Example:

```bash
python -m runtime.cli chat \
  --recording /data/case01.edf \
  --conversation-id case01 \
  --json \
  "Summarize metadata, obvious channel quality issues, and safe next PyHFO steps."
```

### `pyhfo`

Passes through to the bundled PyHFO agent CLI:

```bash
python -m runtime.cli pyhfo [wrapper options] <pyhfo command> [pyhfo args...]
```

Wrapper options must come before the PyHFO command:

```text
--pyhfo-root PATH       Alternate PyHFO app root
--pyhfo-python PATH     Python executable for PyHFO
```

Useful PyHFO commands:

```bash
# Recording metadata.
python -m runtime.cli pyhfo --pyhfo-python pyhfo/.venv/bin/python \
  info --input /data/case01.edf

# Label-free ROI/channel-name inference.
python -m runtime.cli pyhfo --pyhfo-python pyhfo/.venv/bin/python \
  roi --input /data/case01.edf

# Bounded QC metrics.
python -m runtime.cli pyhfo --pyhfo-python pyhfo/.venv/bin/python \
  qc --input /data/case01.edf --max-duration-seconds 60

# Detector planning.
python -m runtime.cli pyhfo --pyhfo-python pyhfo/.venv/bin/python \
  detector-plan --input /data/case01.edf

# Parameter defaults/recommendation/validation/sweep.
python -m runtime.cli pyhfo --pyhfo-python pyhfo/.venv/bin/python \
  parameters defaults --biomarker HFO --detector STE --sample-freq 1000
python -m runtime.cli pyhfo --pyhfo-python pyhfo/.venv/bin/python \
  parameters recommend --goal-profile smoke --biomarker HFO --detector STE --sample-freq 1000
python -m runtime.cli pyhfo --pyhfo-python pyhfo/.venv/bin/python \
  parameters validate --biomarker HFO --detector STE --sample-freq 200 --filter fp=80 --filter fs=90
python -m runtime.cli pyhfo --pyhfo-python pyhfo/.venv/bin/python \
  parameters sweep --goal-profile exploratory --biomarker HFO --detector STE --sample-freq 1000

# Prepare a cleaned FIF copy.
python -m runtime.cli pyhfo --pyhfo-python pyhfo/.venv/bin/python \
  prepare --input /data/case01.edf --output runs/case01_clean.fif \
  --line-noise-notch-hz 60 --bandpass-json '{"l_freq":1,"h_freq":300}'

# Run detection.
python -m runtime.cli pyhfo --pyhfo-python pyhfo/.venv/bin/python \
  detect --input runs/case01_clean.fif --output runs/case01_hfo \
  --biomarker HFO --detector STE --filter fp=80 --filter fs=250 \
  --detector-param min_osc=6 --export summary-json --export csv

# Quick Detection: metadata-backed parameter recommendation + detection.
python -m runtime.cli pyhfo --pyhfo-python pyhfo/.venv/bin/python \
  quick-detect --input /data/case01.edf --output runs/case01_quick \
  --biomarker HFO --detector STE --goal-profile smoke \
  --export summary-json --export csv --export session

# Classify a saved detection session without rerunning detection.
python -m runtime.cli pyhfo --pyhfo-python pyhfo/.venv/bin/python \
  classify --session runs/case01_hfo/session.pybrain --output runs/case01_classified \
  --biomarker HFO --run-id run-1 \
  --classifier-param model_type=default_cpu --classifier-param device=cpu \
  --classifier-param batch_size=16 --export summary-json --export csv --export session

# Print callable sidecar manifest.
python -m runtime.cli pyhfo --pyhfo-python pyhfo/.venv/bin/python \
  manifest --callable-only
```

## Parameters

The backend exposes the same parameter planning surface used by the desktop:

```text
parameters defaults    Instantiate PyHFO detector default parameter objects
parameters recommend   Recommend goal-profile-aware run parameters
parameters validate    Validate filter/channel parameters, including Nyquist safety
parameters sweep       Create a bounded local sweep around recommended values
```

### Defaults

Use defaults when you need the raw PyHFO detector parameter object values and UI
field mapping:

```bash
python -m runtime.cli pyhfo --pyhfo-python pyhfo/.venv/bin/python \
  parameters defaults \
  --biomarker HFO \
  --detector STE \
  --sample-freq 1000 \
  --n-jobs 1
```

For LSM spindle presets:

```bash
python -m runtime.cli pyhfo --pyhfo-python pyhfo/.venv/bin/python \
  parameters defaults \
  --biomarker Spindle \
  --detector LSM \
  --sample-freq 200 \
  --preset "Original (Kramer 2021)"
```

### Recommend

Use recommendations before running detection, especially for quick/smoke runs or
Nyquist-sensitive files:

```bash
python -m runtime.cli pyhfo --pyhfo-python pyhfo/.venv/bin/python \
  parameters recommend \
  --goal-profile smoke \
  --biomarker HFO \
  --detector STE \
  --sample-freq 512 \
  --include-channel A1-A2 \
  --exclude-channel EKG1
```

Goal profiles:

```text
qc, smoke, exploratory, specificity, comparison, batch, reproduction, full
```

The output includes:

```text
parameters       Recommended biomarker/detector/filter/n_jobs/channel scope
validation       Valid/invalid status plus warnings/errors
diff             Field-level difference from previous parameters, when supplied
ui_card          Compact confirmation payload for UI/integration layers
```

### Validate

Use validation to catch unsafe filters before running:

```bash
python -m runtime.cli pyhfo --pyhfo-python pyhfo/.venv/bin/python \
  parameters validate \
  --biomarker HFO \
  --detector STE \
  --sample-freq 200 \
  --filter fp=80 \
  --filter fs=120
```

This returns a `nyquist_violation` because `fs=120` is above Nyquist for a
200 Hz recording.

### Sweep

Use sweep for bounded local comparisons around the recommended band:

```bash
python -m runtime.cli pyhfo --pyhfo-python pyhfo/.venv/bin/python \
  parameters sweep \
  --goal-profile exploratory \
  --biomarker Spike \
  --detector RMS/LL \
  --sample-freq 500
```

Unsafe sweep candidates are omitted.

## Detection and Classification

The CLI has two detection/classification paths:

1. Detection-only or detection-with-inline-classification through `pyhfo detect`.
2. Post-hoc classification of an exported session through `pyhfo classify`.

Use post-hoc classification when you want to classify a previously reviewed or
saved run without rerunning detector discovery.

### Detection-only

```bash
python -m runtime.cli pyhfo --pyhfo-python pyhfo/.venv/bin/python \
  detect --input /data/case01.edf --output runs/case01_hfo \
  --biomarker HFO --detector STE \
  --filter fp=80 --filter fs=250 \
  --detector-param min_osc=6 \
  --n-jobs 1 \
  --export summary-json --export csv --export session
```

Important detection options:

```text
--biomarker HFO|Spindle|Spike
--detector STE|MNI|HIL|RMS|LineLength|YASA|LSM|A7|MOLLE|RMS/LL
--filter KEY=VALUE              Repeatable, e.g. fp=80 fs=250
--detector-param KEY=VALUE      Repeatable detector-specific settings
--include-channel CHANNEL       Repeatable explicit channel scope
--exclude-channel CHANNEL       Repeatable channel exclusion
--n-jobs N                      Worker count
--export NAME                   Repeatable: summary-json, csv, excel, session
```

Detector support depends on biomarker:

```text
HFO:     STE, MNI, HIL, RMS, LineLength
Spindle: YASA, LSM/Kramer LSM, A7, MOLLE, FASST, Spindle RMS
Spike:   RMS/LL
```

Treat detection counts as signal-derived candidate events for expert review, not
clinical truth.

### Detection with Inline Classification

`pyhfo detect` can run classifier steps as part of the same pipeline by passing
repeatable `--classifier-param KEY=VALUE` values:

```bash
python -m runtime.cli pyhfo --pyhfo-python pyhfo/.venv/bin/python \
  detect --input /data/case01.edf --output runs/case01_hfo_classified \
  --biomarker HFO --detector STE \
  --filter fp=80 --filter fs=250 \
  --classifier-param enabled=true \
  --classifier-param model_type=default_cpu \
  --classifier-param device=cpu \
  --classifier-param batch_size=16 \
  --classifier-param steps=artifact \
  --classifier-param steps=spike \
  --classifier-param steps=ehfo \
  --export summary-json --export csv --export session
```

Common classifier parameters:

```text
enabled=true
model_type=default_cpu|default_gpu|custom
device=cpu|cuda:0
batch_size=16
steps=artifact
steps=spike
steps=ehfo
artifact_path=/path/to/model
spike_path=/path/to/model
ehfo_path=/path/to/model
```

Repeat `steps=...` for multiple steps. Classifier model availability depends on
the PyHFO environment and local/hosted model configuration.

### Post-hoc Classification

Use `pyhfo classify` when detection has already produced or exported a saved
session and you do not want to rerun detection:

```bash
python -m runtime.cli pyhfo --pyhfo-python pyhfo/.venv/bin/python \
  classify --session runs/case01_hfo/session.pybrain \
  --output runs/case01_classified \
  --biomarker HFO \
  --run-id run-1 \
  --classifier-param model_type=default_cpu \
  --classifier-param device=cpu \
  --classifier-param batch_size=16 \
  --classifier-param steps=artifact \
  --classifier-param steps=spike \
  --export summary-json --export csv --export session
```

Post-hoc classification inputs:

```text
--session PATH                  Required saved .pybrain/.npz session
--output DIR                    Classified artifact output directory
--biomarker HFO|Spindle         Classification biomarker
--run-id ID                     Optional active run id
--classifier-param KEY=VALUE    Repeatable classifier settings
--export NAME                   Repeatable: summary-json, csv, excel, session, clinical_summary
--session-format pybrain|npz    Format for exported classified session
```

The output includes `classifier_metadata` in the summary JSON. For post-hoc
classification, `classifier_metadata.classification_mode` is
`active_run_session`.

## Quick Detection

Desktop Quick Detection is a streamlined workflow: choose a biomarker/detector,
use safe defaults, optionally run classification, and export reviewable
artifacts. The backend-only equivalent is:

```bash
python -m runtime.cli pyhfo --pyhfo-python pyhfo/.venv/bin/python \
  quick-detect --input /data/case01.edf --output runs/case01_quick \
  --biomarker HFO \
  --detector STE \
  --goal-profile smoke \
  --export summary-json --export csv --export session
```

`quick-detect` performs:

1. `info`-style metadata read for the input file;
2. `parameters recommend` with the selected goal profile;
3. validation through the recommendation result;
4. final validation after CLI overrides are merged;
5. `detect` with the recommended filter, channel scope, and `n_jobs`;
6. selected exports.

The response includes both `parameter_plan.validation` and `final_validation`.
Use `final_validation` when you need to audit the exact parameters passed to
detection after `--filter` and `--detector-param` overrides.

Quick Detection with inline classification:

```bash
python -m runtime.cli pyhfo --pyhfo-python pyhfo/.venv/bin/python \
  quick-detect --input /data/case01.edf --output runs/case01_quick_classified \
  --biomarker HFO \
  --detector STE \
  --goal-profile smoke \
  --classifier-param enabled=true \
  --classifier-param model_type=default_cpu \
  --classifier-param device=cpu \
  --classifier-param batch_size=16 \
  --classifier-param steps=artifact \
  --classifier-param steps=spike \
  --export summary-json --export csv --export session
```

Quick Detection is not a separate detector. It is an ergonomic workflow around
parameter recommendation plus `detect`. Use plain `detect` when you need full
manual control of every parameter.

## Typical Workflows

### Scripted PyHFO Batch

```bash
python -m runtime.cli pyhfo --pyhfo-python pyhfo/.venv/bin/python \
  batch-create --input /data/edf --output runs/batch

python -m runtime.cli pyhfo --pyhfo-python pyhfo/.venv/bin/python \
  batch-run --manifest runs/batch/batch_project.json \
  --biomarker HFO --detector STE --filter fp=80 --filter fs=250
```

### Agent-assisted Plan, Human-run Detection

```bash
python -m runtime.cli serve --pyhfo-python pyhfo/.venv/bin/python

python -m runtime.cli chat --recording /data/case01.edf \
  "Inspect metadata and propose a safe detection plan. Do not run detection."

python -m runtime.cli pyhfo --pyhfo-python pyhfo/.venv/bin/python \
  detect --input /data/case01.edf --output runs/case01_hfo \
  --biomarker HFO --detector STE --filter fp=80 --filter fs=250
```

### Detection then Classification

```bash
python -m runtime.cli pyhfo --pyhfo-python pyhfo/.venv/bin/python \
  detect --input /data/case01.edf --output runs/case01_hfo \
  --biomarker HFO --detector STE --filter fp=80 --filter fs=250 \
  --export summary-json --export csv --export session

python -m runtime.cli pyhfo --pyhfo-python pyhfo/.venv/bin/python \
  classify --session runs/case01_hfo/session.pybrain \
  --output runs/case01_classified \
  --biomarker HFO \
  --classifier-param model_type=default_cpu \
  --classifier-param device=cpu \
  --export summary-json --export csv --export session
```

### Backend Service Integration

Use `serve` to run local services, then integrate against the backend via the
CLI or the existing local HTTP endpoints. The CLI is the supported operator
entry point for backend-only use. The current agent chat endpoint is:

```text
POST http://127.0.0.1:8001/internal/agent/v1/chat
Authorization: Bearer <AGENT_SERVICE_TOKEN>
```

For new external clients, prefer calling `python -m runtime.cli chat` unless you
need direct HTTP integration.

## Authentication

The agent runtime validates `Authorization: Bearer <token>` for internal agent
routes. Token resolution order:

1. command-line `--token`;
2. `PYHFO_AGENT_SERVICE_TOKEN`;
3. `AGENT_SERVICE_TOKEN`.

Configure a token before starting the service. Use the same value for client commands.

```bash
export AGENT_SERVICE_TOKEN="$(openssl rand -hex 24)"
python -m runtime.cli serve --token "$AGENT_SERVICE_TOKEN"
python -m runtime.cli health --token "$AGENT_SERVICE_TOKEN"
```

The PyHFO sidecar is local-only by default. If you start it with
`--pyhfo-token`, use the same value for health checks:

```bash
python -m runtime.cli serve --pyhfo-token "$PYHFO_BACKEND_TOKEN"
python -m runtime.cli health --pyhfo-token "$PYHFO_BACKEND_TOKEN"
```

## Safety and Scope

- The backend binds to local loopback addresses by default.
- Returned PyHFO outputs are research artifacts for expert review, not clinical
  diagnosis or treatment guidance.
- BIDS/clinical-label loading remains gated by the PyHFO agent policy and is not
  enabled by ordinary backend-only chat.
- `chat` is non-streaming in this CLI v1. Use the runtime HTTP stream endpoint
  only when a direct integration explicitly needs SSE.

## Troubleshooting

### `ModuleNotFoundError: runtime`

Run commands from the repository root:

```bash
cd ieeg-agent
python -m runtime.cli --help
```

### PyHFO dependencies are missing

Use a PyHFO environment:

```bash
cd pyhfo
python -m venv .venv
. .venv/bin/activate
python -m pip install -e ".[spindle,severity,gpu]"
cd ..
python -m runtime.cli pyhfo --pyhfo-python pyhfo/.venv/bin/python manifest --callable-only
```

### Health fails with `HTTP 401`

The health command is using a different token from the running service. Pass the
same token to both commands or set `AGENT_SERVICE_TOKEN` in the shell.

### Port is already in use

Choose different ports:

```bash
python -m runtime.cli serve --port 8101 --pyhfo-port 8865
python -m runtime.cli health --agent-url http://127.0.0.1:8101 --pyhfo-url http://127.0.0.1:8865
```

### `chat` works but PyHFO tools fail

Check the PyHFO root and Python:

```bash
python -m runtime.cli pyhfo --pyhfo-python pyhfo/.venv/bin/python manifest --callable-only
```

If this fails, fix the PyHFO environment before using agent chat for recording
analysis.
