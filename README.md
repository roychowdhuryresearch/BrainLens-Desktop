# BrainLens Desktop

BrainLens Desktop is a desktop app for reviewing EEG, iEEG and SEEG with a built-in agent. It opens recordings and runs HFO, spike and spindle detection, event classification and scalp-EEG severity scoring on the PyHFO engine.

- **Desktop app** (`desktop/`): an Electron app. It succeeds the PyHFO PyQt desktop app; [PyHFO v3.0.2](https://github.com/roychowdhuryresearch/pyHFO/releases/tag/v3.0.2) is the last PyQt release.
- **Agent** (`runtime/`): a ReAct agent runtime built into the app. It drives the same backend through MCP and built-in tools.
- **PyHFO engine** (`pyhfo/`): PyHFO 4, maintained in this repository.

[BrainLens](https://github.com/zyp5511/BrainLens) is the companion workbench for reviewing with your own agent (Claude Code, Codex, Cursor, Antigravity) over MCP. BrainLens Desktop has its agent built in.

## Agent runtime

The agent runtime is a generic ReAct runtime. The core remains domain-neutral: it executes conversations, calls MCP/built-in tools, loads Skills, and records runtime history. EEG/iEEG/PyHFO behavior is injected through the `eeg-ieeg-pyhfo` Skill rather than hard-coded into the global system prompt.

## Responsibilities

- Initialize MCP servers.
- Scan and load executable Skills.
- Run the conversation orchestrator.
- Manage tool calls, Skill routing, and user-input follow-up flow.
- Record conversation, turn, summary, and telemetry data.

The agent is an execution service and does not expose public browser-facing APIs.

## Stack

- FastAPI
- Uvicorn
- Pydantic
- SQLAlchemy
- httpx
- watchdog

## Layout

```text
BrainLens-Desktop/        # monorepo root (this repository)
├─ runtime/               # ReAct agent runtime (FastAPI service)
│  ├─ agent_history/      # conversation history and telemetry
│  ├─ agent_runtime/      # runtime tools, verification, follow-up input, orchestration
│  ├─ api/                # internal_agent / internal_history / internal_observability
│  ├─ context/            # context management
│  ├─ core/               # configuration and MCP clients
│  ├─ models/             # schemas / user_context / durable-memory model
│  ├─ prompts/            # Markdown prompt templates (runtime / language / context / postprocess)
│  ├─ services/           # agent_service / ai_service / vlm_service / memory_service / router_model
│  ├─ skills/             # Skill registry, runtime, and offline keyword matcher
│  ├─ runtime_bootstrap.py
│  └─ main.py
├─ pyhfo/                 # bundled PyHFO engine + agent-callable CLI/sidecar
├─ desktop/               # Electron desktop app (React/TS) over the same backend
├─ skills/                # domain Skills (eeg-ieeg-pyhfo, eeg-classification, ...)
├─ ui_mcp/                # zero-dependency MCP connector exposing the desktop UI
├─ evals/                 # agent trajectory evaluation harness
├─ contracts/             # shared UI command catalog
├─ docs/                  # design notes and audits
├─ tests/                 # runtime (Python) test suite
├─ data/                  # local recordings + databases (gitignored)
├─ logs/                  # runtime logs (gitignored)
├─ requirements.txt
├─ Dockerfile
├─ start.bat
└─ README.md
```

## Skill entry point: EEG/iEEG + PyHFO

Domain behavior lives in focused Skills under `skills/skills/`. When those Skills are active, the agent calls the bundled `pyhfo` through built-in research tools:

- `pyhfo_get_recording_info` — inspect EDF, BrainVision, FIF, or FIF.GZ metadata.
- `pyhfo_prepare_recording` — create a PyHFO-ready cleaned FIF/FIF.GZ copy with bad-channel handling, flat-channel removal, optional line-noise notch, broad filtering, resampling, and a JSON cleaning report.
- `pyhfo_detect_events` — run HFO, spindle, or spike detection and return structured artifact metadata.
- `pyhfo_batch_create` / `pyhfo_batch_run` — create and run resumable batch manifests.

The intended workflow is:

1. inspect the recording and format;
2. identify obvious data-quality issues such as file-declared bad channels, flat channels, sampling-rate mismatch, and optional line-noise concerns;
3. prepare a reproducible cleaned copy when needed;
4. run PyHFO detection on the original or prepared copy;
5. return artifact paths, warnings, and assumptions for human research review.

The PyHFO code is now part of this repository under `pyhfo/`, but it still runs behind a separate JSON/process boundary so the ReAct runtime stays generic and lightweight. By default no extra path configuration is required. To override the bundled PyHFO app, configure:

```bash
export PYHFO_AGENT_APP_ROOT=/path/to/alternate/pyHFO-agent-callable-app
export PYHFO_AGENT_PYTHON=/path/to/pyhfo/python  # optional, defaults to a PyHFO venv or current Python
export PYHFO_AGENT_TIMEOUT_SECONDS=900           # optional
```

Install the bundled PyHFO dependencies separately from the agent runtime when running real EEG/iEEG analysis:

```bash
cd pyhfo
python -m venv .venv
. .venv/bin/activate
python -m pip install -e ".[spindle,severity,gpu]"
```

For a frozen Electron backend, build on the target OS with Python 3.11.
From `pyhfo/`, install `requirements-release-macos.txt` and run
`python -m PyInstaller --noconfirm --clean pyhfo_backend_macos.spec` on macOS.
On Windows, install `requirements-release-windows.txt` and run
`python windows_package.py`. Both produce `pyhfo/dist/pyhfo-backend/`.
Electron starts the bundled executable and supplies its own HTTP token. To reuse
locally provisioned severity weights, set `PYHFO_SEVERITY_MODEL_DIR` to the
directory containing the real weights and their configuration before launching.

Returned PyHFO outputs are research artifacts for human review, not clinical diagnosis or treatment guidance.

## Internal APIs

The agent currently exposes internal APIs only:

- `/internal/agent/v1/chat`
- `/internal/agent/v1/chat/stream`
- `/internal/agent/v1/chat/cancel/{conversation_id}`
- `/internal/agent/v1/chat/user-input`
- `/internal/history/*`
- `/internal/observability/*`

Calls to these endpoints must include the internal token configured by the backend.

Durable memory has moved out of local agent storage and is centralized in the backend. The agent runtime accesses backend `/internal/api/memories/*` through `runtime.services.memory_service` using `AGENT_BACKEND_TOKEN` as a shared-secret credential.

## Startup flow

When the agent starts, it:

1. initializes the `agent_history` database through `runtime.agent_history.db.init_db()` for `data/agent_history.db` only;
2. loads configuration;
3. initializes MCP servers;
4. scans Skills.

The entry point is `runtime/main.py`.

Notes:

- `init_db()` creates only history / turn / message / telemetry tables; it no longer manages durable memory.
- Durable-memory reads/writes go through backend HTTP. The agent process keeps a 30-second read cache and invalidates the relevant user cache on writes.

## Runtime path

Main entry points:

- `runtime/api/internal_agent.py`
- `runtime/runtime_bootstrap.py`
- `runtime/services/agent_service.py`

Execution path:

1. validate the backend internal token;
2. convert the payload to `user_context`;
3. filter capabilities by `allowed_mcp_servers` and `allowed_skill_names`;
4. retrieve durable memory as needed and build request-scoped memory context;
5. call `AgentService.stream_message()` or `process_message()`;
6. check the simple-QA fast path first;
7. if fast path does not match, let runtime bootstrap choose the first step, then loop through `continue / select_skill / replan / finish`;
8. if fast path matches, create a one-step `general_assistant` plan and skip bootstrap LLM / post-step agent control / verification;
9. record turn, message, summary, and telemetry;
10. return SSE events to the backend.

The fast path is intended to:

- cover short direct-answer questions;
- avoid weather, news, prices, search, files, commands, images, and other requests that obviously need tools or external information;
- still enter the step loop, persist the turn, and emit `plan_created` / `content` / `done` events.

## Context / state / memory boundaries

These concepts are separate:

- `context`: temporary context assembled for one model call, including recent history, summary, Skill context, and retrieval results.
- `ConversationRuntimeState`: conversation-local working memory, including open goals, pending actions, shared handoff, and pending user input.
- `durable memory`: long-term memory that remains valid across conversations, including user preferences, long-term context, team decisions, and organization-level artifacts.

Durable memory is fetched only at bootstrap, controller decision boundaries, and selected step-prompt injection points. It is not injected wholesale into every step.

## Prompt organization

Runtime prompts live under `runtime/prompts/*.md`:

- `runtime/prompts/system_prompt.md` — main system prompt template.
- `runtime/prompts/runtime/` — controller, verifier, repair, and empty-response templates.
- `runtime/prompts/language/` — language detection and translation templates.
- `runtime/prompts/context/` / `runtime/prompts/postprocess/` — context summarization and reasoning compression templates.

`runtime/prompts/loader.py` centralizes prompt loading and variable substitution. Long prompts should not be hard-coded in Python unless there is a clear runtime reason.

## Routing entry point

The runtime turn entry point is `AgentController.bootstrap()`. It combines routing and first-step planning in one LLM call and outputs one initial step. Later steps are added dynamically by `AgentController.decide()`.

There is no separate static `SkillRouter` / planner layer. `RouterModelResolver` (`runtime/services/router_model.py`) only provides an optional lower-cost AI service for controller / memory-writer / postprocess calls when configured; it does not make routing decisions itself.

## Permissions and execution

The agent enforces backend-provided constraints:

- MCP server allow-list filtering.
- Skill-name allow-list filtering.
- Durable-memory scope visibility filtering.
- Durable-memory write-permission filtering.

The agent does not own authorization policy; it executes according to backend-provided permissions.

## Data and logs

Main data:

- Conversation runtime database: `data/agent_history.db`, initialized by `runtime.agent_history.db.init_db()`.
- Durable memory: moved to the configured memory service and accessed through `runtime.services.memory_service`.

Logs:

- `logs/agent.log`
- `logs/skills.log`
- `logs/verification_issues.log`

## Run locally

From the repository root, create the local configuration files. Supply the model key from your environment and generate a service token shared by the runtime and its clients.

```bash
cp config.example.yaml config.yaml
cp user_config.example.yaml user_config.yaml
export AGENT_SERVICE_TOKEN="$(python -c 'import secrets; print(secrets.token_urlsafe(32))')"
# Set DASHSCOPE_API_KEY for the example model configuration.
```

`config.yaml`, `user_config.yaml`, `data/`, and runtime logs are local private files and should not be committed.

```bash
python -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
python -m uvicorn runtime.main:app --reload --host 127.0.0.1 --port 8001
```

On Windows, set the same configuration in PowerShell and start the runtime from your Python environment.

```powershell
Copy-Item config.example.yaml config.yaml
Copy-Item user_config.example.yaml user_config.yaml
$env:AGENT_SERVICE_TOKEN = python -c "import secrets; print(secrets.token_urlsafe(32))"
.\start.bat
```

### Docker

Run these commands from the repository root with `AGENT_SERVICE_TOKEN` and
`DASHSCOPE_API_KEY` set in the shell. The image includes the example
configuration. To use your own configuration, mount the directory containing
both YAML files at `/app/config`.

```bash
docker build -t brainlens-desktop .
docker run --rm -p 127.0.0.1:8001:8001 -e AGENT_SERVICE_TOKEN -e DASHSCOPE_API_KEY \
  -v ieeg-data:/app/data brainlens-desktop
```

## Backend-only CLI

For integrations that want the backend without the Electron desktop UI, use the
top-level CLI module. See [Backend-only CLI](docs/backend-cli.md) for the full
operator guide.

```bash
python -m runtime.cli serve
```

This starts the agent runtime and the bundled PyHFO local sidecar. The agent
runtime defaults to headless mode for faster backend-only startup: configured MCP
servers are skipped unless `--enable-mcp` is passed, while built-in PyHFO tools
remain available.

Useful backend-only commands:

```bash
# Start only the agent runtime.
python -m runtime.cli serve --no-pyhfo

# Check the agent and PyHFO sidecar.
python -m runtime.cli health

# Send one non-streaming chat request to a running backend.
python -m runtime.cli chat --recording /path/to/case.edf "Inspect this recording and propose a detection plan."

# Use the bundled PyHFO analysis CLI through the same product entry point.
python -m runtime.cli pyhfo info --input /path/to/case.edf
python -m runtime.cli pyhfo parameters recommend --goal-profile smoke --biomarker HFO --detector STE --sample-freq 1000
python -m runtime.cli pyhfo quick-detect --input /path/to/case.edf --output runs/case --biomarker HFO --detector STE
python -m runtime.cli pyhfo detect --input /path/to/case.edf --output runs/case
python -m runtime.cli pyhfo classify --session runs/case/session.pybrain --output runs/case-classified
python -m runtime.cli pyhfo manifest --callable-only
```

Set `AGENT_SERVICE_TOKEN` or `PYHFO_AGENT_SERVICE_TOKEN` for authenticated
agent API calls. PyHFO can use a separate Python environment:

```bash
python -m runtime.cli serve --pyhfo-python pyhfo/.venv/bin/python
python -m runtime.cli pyhfo --pyhfo-python pyhfo/.venv/bin/python info --input /path/to/case.edf
```

## Related projects

- [pyHFO](https://github.com/roychowdhuryresearch/pyHFO) — PyHFO 3.x, the original PyQt desktop app. The PyHFO 4 engine is maintained here under `pyhfo/`.
- [BrainLens](https://github.com/zyp5511/BrainLens) — AI co-review for EEG: a review workbench that connects your own agent over MCP and uses the PyHFO engine.

## License

This repository is mixed-licensed:

- Everything outside `pyhfo/` is released under the MIT License — see [LICENSE](LICENSE).
- The PyHFO engine under `pyhfo/` is distributed under the UCLA Academic Software License — see [pyhfo/LICENSE.txt](pyhfo/LICENSE.txt). It is free for academic and non-profit research use; commercial use requires a license from UCLA (contacts are listed in that file).
