# Black-box, MCP-only evaluation of the iEEG agent

Evaluate the agent **the way you'd test any agent you don't own**: as an opaque service reached *only*
over MCP. The agent may be running on another machine — point `IEEG_AGENT_BASE_URL` at it and nothing
else changes. Unlike the in-process evals (`evals/run_trajectory_eval.py`, `evals/optimize/`), nothing
here imports `runtime.*` — the only contact with the agent is MCP tool calls.

```
 evaluator (this dir)                    agent host (local or remote)
 ┌─────────────────────┐   MCP stdio   ┌────────────────────┐  HTTP/SSE  ┌──────────────────┐
 │ run_blackbox_eval   │──────────────▶│ agent_mcp_server   │───────────▶│ agent runtime    │
 │ tester_agent        │  agent_run_   │ (this dir)         │ /chat/stream│ :8001 (FastAPI)  │
 │ (objective + agentic)│   task ...    │ zero-dep, stdlib   │  bearer    │                  │
 └─────────────────────┘◀──────────────└────────────────────┘◀───────────└──────────────────┘
        trajectory + final answer + tool results (JSON)
```

## The three pieces

| File | Role |
|------|------|
| `agent_mcp_server.py` | **Keystone.** Zero-dep stdio MCP server that exposes the agent as MCP tools (`agent_run_task`, `agent_health`, `agent_list_tools`). Thin client of the runtime HTTP API — so the agent can be remote. Mirror image of `ui_mcp/mcp_server.py`. |
| `mcp_client.py` | Tiny MCP stdio client (`AgentMcpClient`) the harness/tester use to spawn + talk to the server. |
| `run_blackbox_eval.py` | **Objective backbone.** Drives scenarios over MCP and scores hard metrics, reusing the existing scorers: `outcome` mode = F1 of candidate channels vs SOZ gold (`evals.optimize.reward`); `trajectory` mode = gold-tool coverage + LLM judge. |
| `../product_agent_scenarios.json` + `../run_product_eval.py` | **Product behavior gate.** Scores tool names, UI command payloads, callback order, MCP policy blocks, and final-answer claims for desktop co-pilot and headless workflows. Fixture mode is deterministic CI; blackbox mode runs the real agent. |
| `tester_agent.py` | **Agentic tester.** An evaluator LLM that probes the agent over MCP (issues tasks, follows up) and submits a behavioral scorecard — the judgment the numbers can't give. |
| `selftest.py` | Deterministic, no-model, no-real-agent proof of the whole path (fake agent + bearer auth). |

## Quick start

```bash
# 0. prove the plumbing (no model, no agent needed)
python evals/blackbox/selftest.py                      # 12/12 PASS
python -m evals.run_product_eval --mode fixture         # deterministic product contract

# 1. start the agent runtime (or point at a remote one)
export AGENT_SERVICE_TOKEN="$(python -c 'import secrets; print(secrets.token_urlsafe(32))')"
export IEEG_AGENT_SERVICE_TOKEN="$AGENT_SERVICE_TOKEN"
python -m runtime.cli serve --no-pyhfo &               # local :8001

# 2a. objective backbone — hard numbers
python -m evals.blackbox.run_blackbox_eval --mode trajectory --filter detect --runs 2
python -m evals.blackbox.run_blackbox_eval --mode outcome   --limit 3

# 2a.5 product behavior — payload/callback/final-claim assertions
python -m evals.run_product_eval --mode blackbox --filter desktop-ambiguous --timeout 120

# 2b. agentic tester — behavioral scorecard
python -m evals.blackbox.tester_agent --recording /data/Omni-iEEG/.../sub-01_ieeg.edf
python -m evals.blackbox.tester_agent --dry-run        # print its plan, no model/agent
```

## Configuration (env)

**Reaching the agent** (read by `agent_mcp_server.py`):

| Var | Default | Meaning |
|-----|---------|---------|
| `IEEG_AGENT_BASE_URL` | `http://127.0.0.1:8001` | Agent runtime — set to a remote host. |
| `IEEG_AGENT_SERVICE_TOKEN` | Required | Same secret as the running agent. |
| `IEEG_EVAL_RECORDING` | Scenario path relative to this checkout | Absolute recording path on the agent host for trajectory replay. Set this for a remote runtime. |
| `IEEG_AGENT_API_PREFIX` | `/internal/agent/v1` | Runtime API prefix. |
| `IEEG_AGENT_TIMEOUT` | `600` | Per-read socket timeout (detection is slow). |
| `IEEG_AGENT_MODEL` | — | Default model override per turn. |

**Judge** (`run_blackbox_eval.py`, trajectory mode): `IEEG_JUDGE_API_BASE` / `IEEG_JUDGE_API_KEY` /
`IEEG_JUDGE_MODEL`; else falls back to local runtime config if importable; `IEEG_JUDGE_DISABLE=1` forces
coverage-only (no judge calls).

**Evaluator** (`tester_agent.py`): `IEEG_TESTER_API_BASE` / `IEEG_TESTER_API_KEY` / `IEEG_TESTER_MODEL`;
else falls back to local runtime config.

## Operational notes

- **`outcome` mode needs the agent to actually execute, not stage.** The agent host must run with
  `PYHFO_AGENT_EXECUTION_PROFILE=authorized_headless` so it runs the pipeline instead of staging for a
  human Apply. This process-level authority is only for an isolated evaluation worker; it lives on the
  **agent host**, not on this harness or in a tool payload.
- **Gold is scored out of band** — the agent never sees the SOZ/resection labels; the harness reads them
  from the BIDS `*_channels.tsv` after the run. Anti-cheat by construction.
- **Reuse, not reinvention** — the MCP-derived trace `{trajectory, tool_results, final_answer}` has the
  same shape as what in-process `stream_message` yields, so the existing `extract_candidates` /
  `score_candidates` / coverage scorers work unchanged (proved by `selftest.py`).
- **Use the product eval when prompts or MCP descriptions change.** Tool-name coverage can miss the real
  failure: the correct tool with the wrong payload, a missing `wait_for_ui_command`, or a final answer
  claiming a compute command finished before the renderer callback.
- These are **real-model, non-deterministic** evals (like the in-process ones). Average over `--runs`.

## Drive it from Claude Code (agent-tests-agent)

Add the connector to a `.mcp.json` and an MCP agent can evaluate the agent directly:

```json
{"mcpServers": {"ieeg-agent": {"command": "python",
   "args": ["/abs/path/evals/blackbox/agent_mcp_server.py"],
   "env": {"IEEG_AGENT_BASE_URL": "http://remote-host:8001"}}}}
```
