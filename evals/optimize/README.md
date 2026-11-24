# Agent optimization loop

Turns the agent from "evaluate the proposal" into "optimize the executed outcome". Autonomy is the
prerequisite: to optimize you must let the agent run end to end and score the **result**, not the clicks.

```
real EDFs + SOZ gold (channels.tsv)
        │
        ▼  agent runs the HFO pipeline headlessly (detect → rank), agent BLIND to labels
   run_outcome_eval.py  ──►  trajectory + candidate channels  ──►  reward.py (P/R/F1 vs SOZ)
        │                                                              (scored OUT OF BAND)
        ▼
   loop.py:  record (version + trend) · export (RL tuples) · ab (variant comparison)
        │
        ▼  use the reward to change prompts/skills/params → re-run → did reward go up?
```

## The reward (objective signal)
`reward.py` — the clinical point of HFO detection is to localize the seizure-onset zone. So the reward is
**precision/recall/F1 of the agent's candidate channels vs the BIDS `soz`/`resection` ground truth** in
`*_channels.tsv` (the same file PyHFO's gated `compare_candidate_channels_to_bids_labels` reads). The
headline reward = F1 vs `soz ∪ resection`. The agent never sees the labels — the harness scores out of band.

```bash
python -m evals.optimize.reward                      # self-test on a real channels.tsv
python -m evals.optimize.reward <edf> CH1 CH2 ...    # score an explicit candidate list
```

## The autonomous runner
`run_outcome_eval.py` — drives the real agent over SOZ-labelled recordings, captures the executed
trajectory + candidate channels, scores each vs gold, writes `outcome_eval_report.json`.

```bash
python -m evals.optimize.run_outcome_eval --dry-run            # list scorable recordings (no model)
PYHFO_AGENT_EXECUTION_PROFILE=authorized_headless IEEG_AGENT_SKIP_MCP=1 \
  python -m evals.optimize.run_outcome_eval --limit 5 --model qwen3.5-plus
```
`PYHFO_AGENT_EXECUTION_PROFILE=authorized_headless` grants direct execution to that isolated evaluator
process instead of staging for desktop Apply (the renderer's HITL gate). Never put this authority in a
tool payload or normal desktop process. Needs a model key + the PyHFO env. Each recording is a slow real
run; keep `--limit` small. Non-deterministic with weak models — average over runs.

## The loop
`loop.py` — wraps the eval with the pieces that make it *optimization*:
```bash
python -m evals.optimize.loop record --label baseline     # append reward to history.jsonl (+ Δ vs previous)
python -m evals.optimize.loop trend                       # mean reward over time, attributed to a version
python -m evals.optimize.loop export -o trajectories.jsonl# (recording, trajectory, candidates, reward) for RL
python -m evals.optimize.loop ab \                        # compare variants; accept a change only if reward ↑
  --variant base= --variant promptB=PYHFO_AGENT_SYSTEM_PROMPT=/path/to/variantB.md --limit 3
```
`record` fingerprints each run with the git SHA + system-prompt hash + skills hash, so a reward change is
attributable to a real change. `ab` runs the outcome eval under each variant's env overrides and compares
mean reward — the basis for prompt/skill iteration or, via `export`, offline RL / preference tuning.

## Notes
- Ground truth available: channel-level SOZ/resection (`channels.tsv`). No event-level `events.tsv`, so
  the objective is SOZ **localization**, not per-event HFO precision.
- This is the same headless surface the trajectory eval (`evals/run_trajectory_eval.py`) uses; that one
  scores tool CHOICE + response quality (a complementary signal), this one scores the executed OUTCOME.
- Agent-blind-to-labels is load-bearing: never feed `soz`/`resection` into the agent's context, or the
  reward becomes cheatable. The harness reads the tsv directly; the agent's path stays label-free.
