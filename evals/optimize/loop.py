#!/usr/bin/env python3
"""The optimization loop around the outcome reward: version, track trend, A/B variants, export for RL.

The pieces that turn a one-off eval into optimization:
  record  — fingerprint what produced the scores (git SHA + system-prompt/skills hash) and append the
            run's mean reward to history.jsonl, printing the delta vs the previous run.
  trend   — show mean reward over time (did a prompt/skill change actually help?).
  export  — emit (recording, trajectory, candidate_channels, reward) tuples as JSONL for offline RL /
            preference tuning.
  ab      — run the outcome eval under >=2 variants (env/model overrides, e.g. a prompt variant) and
            compare mean reward, so a change is accepted only if the objective signal improves.

record / trend / export are pure (operate on a report JSON) and need no model. ab drives the real agent.

    python -m evals.optimize.loop record [report.json] --label "baseline"
    python -m evals.optimize.loop trend
    python -m evals.optimize.loop export [report.json] -o trajectories.jsonl
    python -m evals.optimize.loop ab --variant base= --variant promptB=PYHFO_AGENT_SYSTEM_PROMPT=/path/b.md --limit 3
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

HERE = Path(__file__).parent
REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REPORT = HERE / "outcome_eval_report.json"
HISTORY = HERE / "history.jsonl"


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]


def _path_sha(path: Path) -> str:
    try:
        return _sha(path.read_text(encoding="utf-8"))
    except OSError:
        return "missing"


def _git_sha() -> str:
    try:
        return subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=str(REPO_ROOT),
                              text=True, capture_output=True, timeout=10).stdout.strip() or "unknown"
    except Exception:  # noqa: BLE001
        return "unknown"


def version_tag() -> dict[str, str]:
    """Fingerprint what produced a score so the trend is attributable to a real change."""
    skills_dir = REPO_ROOT / "runtime" / "skills"
    skills_blob = ""
    if skills_dir.exists():
        for f in sorted(skills_dir.rglob("*.md")):
            skills_blob += f.read_text(encoding="utf-8", errors="ignore")
    return {
        "git_sha": _git_sha(),
        "system_prompt_sha": _path_sha(REPO_ROOT / "runtime" / "prompts" / "system_prompt.md"),
        "skills_sha": _sha(skills_blob) if skills_blob else "none",
    }


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _load_report(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _read_history() -> list[dict]:
    if not HISTORY.exists():
        return []
    return [json.loads(line) for line in HISTORY.read_text(encoding="utf-8").splitlines() if line.strip()]


def cmd_record(report_path: Path, label: str) -> None:
    report = _load_report(report_path)
    prev = _read_history()
    entry = {
        "timestamp": _now(),
        "label": label,
        "version": version_tag(),
        "model": report.get("model"),
        "mean_reward": report.get("mean_reward"),
        "n_scored": report.get("n_scored"),
        "n_recordings": report.get("n_recordings"),
    }
    with HISTORY.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
    prev_scored = [e for e in prev if isinstance(e.get("mean_reward"), (int, float))]
    delta = None
    if prev_scored and isinstance(entry["mean_reward"], (int, float)):
        delta = round(entry["mean_reward"] - prev_scored[-1]["mean_reward"], 4)
    arrow = "" if delta is None else f"  (Δ {'+' if delta >= 0 else ''}{delta} vs '{prev_scored[-1]['label']}')"
    print(f"recorded '{label}': mean_reward={entry['mean_reward']} over {entry['n_scored']} scored{arrow}")
    print(f"  version: git={entry['version']['git_sha']} prompt={entry['version']['system_prompt_sha']} skills={entry['version']['skills_sha']}")


def cmd_trend() -> None:
    history = _read_history()
    if not history:
        print("no history yet. run `record` after an outcome eval.")
        return
    print(f"=== optimization trend ({len(history)} run(s)) ===")
    print(f"{'when':20} {'label':18} {'reward':>7} {'scored':>6}  version(prompt/skills)")
    best = None
    for e in history:
        rw = e.get("mean_reward")
        if isinstance(rw, (int, float)) and (best is None or rw > best[0]):
            best = (rw, e.get("label"))
        v = e.get("version") or {}
        print(f"{e.get('timestamp',''):20} {str(e.get('label',''))[:18]:18} {str(rw):>7} "
              f"{str(e.get('n_scored','')):>6}  {v.get('system_prompt_sha','?')}/{v.get('skills_sha','?')}")
    if best:
        print(f"\nbest: {best[1]} @ reward={best[0]}")


def cmd_export(report_path: Path, out_path: Path) -> None:
    """Emit (state, trajectory, candidates, reward) tuples — the substrate for offline RL / preference tuning."""
    report = _load_report(report_path)
    n = 0
    with out_path.open("w", encoding="utf-8") as handle:
        for r in report.get("results", []):
            if not isinstance(r.get("reward"), (int, float)):
                continue  # only export scored (rewarded) trajectories
            handle.write(json.dumps({
                "recording": r.get("recording"),
                "trajectory": r.get("trajectory"),
                "candidate_channels": r.get("candidate_channels"),
                "reward": r.get("reward"),
                "score": r.get("score"),
                "model": report.get("model"),
                "version": version_tag(),
            }, ensure_ascii=False) + "\n")
            n += 1
    print(f"exported {n} scored trajectory tuple(s) -> {out_path}")


def _parse_variant(spec: str) -> tuple[str, dict[str, str]]:
    """'label=KEY=VAL,KEY2=VAL2' -> (label, {KEY:VAL,...}); 'label=' = baseline (no overrides)."""
    label, _, rest = spec.partition("=")
    env: dict[str, str] = {}
    for pair in rest.split(",") if rest else []:
        if "=" in pair:
            k, _, v = pair.partition("=")
            env[k.strip()] = v.strip()
    return label.strip() or "variant", env


async def cmd_ab(variants: list[str], limit: int, model: str) -> None:
    from evals.optimize.run_outcome_eval import evaluate, new_conversation_namespace

    results = []
    base_env = dict(os.environ)
    for spec in variants:
        label, env = _parse_variant(spec)
        print(f"\n===== A/B variant '{label}' (env overrides: {env or 'none'}) =====")
        os.environ.clear(); os.environ.update(base_env); os.environ.update(env)
        report = await evaluate(limit=limit, model=model, conversation_namespace=new_conversation_namespace(f"ab-{label}"))
        cmd_record_inline(report, f"ab:{label}")
        results.append((label, report.get("mean_reward"), report.get("n_scored")))
    os.environ.clear(); os.environ.update(base_env)
    print("\n=== A/B comparison ===")
    ranked = sorted(results, key=lambda lr: (lr[1] if isinstance(lr[1], (int, float)) else -1), reverse=True)
    for label, reward, n in ranked:
        print(f"  {label:18} mean_reward={reward} (n={n})")
    if len(ranked) >= 2 and isinstance(ranked[0][1], (int, float)):
        print(f"\nwinner: {ranked[0][0]} (reward={ranked[0][1]})")


def cmd_record_inline(report: dict, label: str) -> None:
    entry = {"timestamp": _now(), "label": label, "version": version_tag(), "model": report.get("model"),
             "mean_reward": report.get("mean_reward"), "n_scored": report.get("n_scored"),
             "n_recordings": report.get("n_recordings")}
    with HISTORY.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, ensure_ascii=False) + "\n")


def main() -> None:
    ap = argparse.ArgumentParser(description="Optimization loop around the SOZ outcome reward.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p_rec = sub.add_parser("record", help="append a run's reward to history.jsonl (+ delta vs previous)")
    p_rec.add_argument("report", nargs="?", default=str(DEFAULT_REPORT))
    p_rec.add_argument("--label", required=True)
    sub.add_parser("trend", help="show mean reward over time")
    p_exp = sub.add_parser("export", help="export scored trajectories as JSONL for RL")
    p_exp.add_argument("report", nargs="?", default=str(DEFAULT_REPORT))
    p_exp.add_argument("-o", "--out", default=str(HERE / "trajectories.jsonl"))
    p_ab = sub.add_parser("ab", help="run >=2 variants and compare reward (drives the real agent)")
    p_ab.add_argument("--variant", action="append", required=True, dest="variants",
                      help="label=ENVKEY=VAL,...  (repeatable; 'label=' = baseline)")
    p_ab.add_argument("--limit", type=int, default=3)
    p_ab.add_argument("--model", default="qwen3.5-plus")
    args = ap.parse_args()

    if args.cmd == "record":
        cmd_record(Path(args.report), args.label)
    elif args.cmd == "trend":
        cmd_trend()
    elif args.cmd == "export":
        cmd_export(Path(args.report), Path(args.out))
    elif args.cmd == "ab":
        asyncio.run(cmd_ab(args.variants, args.limit, args.model))


if __name__ == "__main__":
    main()
