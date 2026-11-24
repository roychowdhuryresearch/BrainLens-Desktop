# Debug plan: co-pilot agent hangs / 答非所问 on "set detector params"

## What happened
A deep co-pilot E2E (`npm run qa:copilot-deep`) was run on a locally supplied EDF. It drives a multi-turn clinician session through the real Electron app + PyHFO
backend + LLM agent runtime, with the real model. Result: **FAILED on one turn.**

| Turn | Prompt (abridged) | Result |
|---|---|---|
| investigate-waveform | "what stands out… move the viewport" | ✅ on-topic, acted (viewport + QC) |
| qc-and-spectral | "run QC, line noise, Nyquist; usable channels; notch?" | ✅ on-topic, real QC numbers (from the headless QC tool — correct, not fabricated) |
| **set-detector-params** | **"Set the detection filter band to fp 80 and fs 250 Hz, and set the line-noise notch to 60 Hz."** | ❌ **timed out at 120 s — EMPTY reply, ZERO UI commands** |

Failure message: `co-pilot turn "set-detector-params" failed: page.waitForFunction: Timeout 120000ms exceeded`.
The user also observed the agent answering 答非所问 (off-topic / non-responsive) during the live run.
The harness writes the following local artifacts:
- `desktop/artifacts/electron-copilot-deep-e2e.json` — per-turn `prompt` / `reply` / `commands` / `note`.
- `desktop/artifacts/copilot-deep/0{1..4}-*.png` — per-turn screenshots.

## Reproduce in isolation (~3 min, just the failing turn)
```bash
cd desktop
PYHFO_ELECTRON_REAL_FIXTURE_RECORDING=/path/to/recording.edf \
  COPILOT_DEEP_ONLY=set-detector-params npm run qa:copilot-deep
```
`COPILOT_DEEP_ONLY` runs only that turn (the "load recording" step always runs first). The model is
**non-deterministic** — run it 2–3× and note the reproduce rate before concluding.

## Hypotheses (investigate in this order)

### H1 — Skill routing/execution (the leading guess)
The "set parameters" request may route into a skill (`skills/skills/*`, e.g. `pyhfo-detection`,
`eeg-*`) whose flow or `allowed_tools` is broken, so the agent enters a skill step that never returns →
hang → 120 s timeout. Check the routing + the skill that should handle param-setting.
- Files: `runtime/agent_runtime/skill_executor.py`, `runtime/agent_runtime/planning_policy.py`,
  `runtime/skills/models.py`, `skills/skills/*/SKILL.md` (look at `allowed_tools` + the flow for
  prepare/detection-parameter intents).

### H2 — `search_tools` / "search-first" prompt regression (recent change, suspect)
The agent uses `search_tools` and `list_tool_categories` in `ui_mcp/mcp_server.py` with a search instruction in `runtime/prompts/system_prompt.md`. The
set-params turn is exactly where "search-first" fires. **Only the discovery half was built** — the
"searched-tools-become-callable" runtime injection was deliberately deferred in that version. If the agent searches, gets a tool card, but can't cleanly act on it, it may loop until
the timeout. The earlier turns trigger "search-first" less, which is why they passed.
- **Quick test:** temporarily revert the "search FIRST" bullet in `runtime/prompts/system_prompt.md`
  and re-run the isolated turn. If it then passes, this is it →
  soften the nudge, or finish the reveal→call mechanism.
- Files: `runtime/prompts/system_prompt.md`, `ui_mcp/mcp_server.py`, `contracts/ui-command-catalog.json`.

### H3 — `detection.set_parameters` payload/handler
The agent should emit `emit_ui_command(type="detection.set_parameters", payload={filter:{fp:80,fs:250},
notch/line-noise…})`, handled in `desktop/src/app/App.tsx` (`detection.set_parameters` →
`prepareControlsFromAgentCommand`, writes the Prepare-panel controls). Verify the agent can construct
that payload and the handler applies it. (Note: that handler is wired but only *view*-class; confirm it
actually applies the three values.)

### H4 — Model flakiness
A single 120 s stall could be the non-deterministic model. Rule out via the repeated runs in step 1.

## Investigation steps
1. Reproduce in isolation 2–3× (above). Record reproduce rate.
2. **Capture the agent's tool trajectory for the turn** (the E2E report's reply is empty — we need WHAT
   the agent did before timing out). Drive the agent runtime directly and capture `tool_call` SSE events:
   POST the prompt to `/internal/agent/v1/chat/stream` with a `recording_path`, or reuse the harness in
   `evals/blackbox/` (`agent_mcp_server.py`, `mcp_client.py`, `run_blackbox_eval.py`) which already
   captures the ordered trajectory. Look for: a repeated tool (loop), a stuck call, a skill that never
   returns, or no tool calls at all.
3. Branch on the trajectory → H1/H2/H3/H4 as above. Apply the fix in the implicated area.
4. Re-run the isolated turn until green, then the full `qa:copilot-deep` (gate needs ≥4 passing turns).

## Key files (quick map)
- Agent prompt: `runtime/prompts/system_prompt.md`  ← H2 suspect (search-first bullet)
- MCP surface: `ui_mcp/mcp_server.py`, `contracts/ui-command-catalog.json`
- Skill engine: `runtime/agent_runtime/skill_executor.py`, `planning_policy.py`, `skills/skills/*/SKILL.md`  ← H1
- Param handler (renderer): `desktop/src/app/App.tsx` (`detection.set_parameters`)  ← H3
- E2E harness: `desktop/scripts/electron-copilot-deep-e2e.mjs` (turn defs, timeouts, `COPILOT_DEEP_ONLY`)
- Trajectory capture: `evals/blackbox/`
