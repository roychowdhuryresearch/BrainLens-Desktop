#!/usr/bin/env python3
"""Outcome eval: drive the agent end-to-end on real EDFs and score the EXECUTED result vs SOZ gold.

Unlike the trajectory eval (which scores tool CHOICE on simulated state), this lets the agent actually
run the HFO pipeline headlessly on a real recording, captures the candidate channels it surfaces, and
scores them against the BIDS SOZ/resection ground truth (reward.py) — OUT OF BAND, so the agent never
sees the labels. This is the reward signal an optimization loop needs.

Run (repo root), needs a real model key + PyHFO env:
    PYHFO_AGENT_EXECUTION_PROFILE=authorized_headless IEEG_AGENT_SKIP_MCP=1 \
      python -m evals.optimize.run_outcome_eval [--limit N] [--model qwen3.5-plus] [--dry-run]

--dry-run lists the scorable recordings (with gold) and exits — no model/PyHFO needed.
Emits evals/optimize/outcome_eval_report.json (consumed by loop.py for trend + trajectory export).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
from pathlib import Path
from typing import Any, Optional
from uuid import uuid4

from evals.optimize.reward import load_soz_gold, score_candidates, SozGold

REPO_ROOT = Path(__file__).resolve().parents[2]
DATA_ROOT = REPO_ROOT / "data" / "Omni-iEEG"
REPORT = Path(__file__).parent / "outcome_eval_report.json"

PIPELINE_PROMPT = (
    "You are operating HEADLESSLY on a real iEEG recording for a research evaluation (no human in the "
    "loop, so actually execute the tools — do not stage and wait for Apply).\n"
    "Recording: {path}\n\n"
    "Run the standard HFO localization pipeline end to end:\n"
    "1. Inspect recording metadata.\n"
    "2. Infer the label-free brain-signal ROI.\n"
    "3. Run an HFO detection (STE is fine; use a Nyquist-safe filter, n_jobs=1, export csv + summary-json).\n"
    "4. Rank the candidate channels by HFO rate.\n"
    "Finish with a short list of the top candidate channels (signal-derived, not a clinical claim)."
)


def _safe_id_part(value: Any) -> str:
    text = re.sub(r"[^A-Za-z0-9_.-]+", "-", str(value or "")).strip("-._")
    return text[:80] or "run"


def new_conversation_namespace(label: str = "outcome") -> str:
    """Create a clean-room conversation namespace for one eval run or variant."""
    return f"opt-{_safe_id_part(label)}-{uuid4().hex[:8]}"


def conversation_id_for_recording(recording_path: str | Path, conversation_namespace: str) -> str:
    return f"{_safe_id_part(conversation_namespace)}-{_safe_id_part(Path(recording_path).stem)}"


def discover_scorable(limit: Optional[int]) -> list[SozGold]:
    """Find real recordings that have an EDF on disk AND SOZ/resection gold labels."""
    out: list[SozGold] = []
    for tsv in sorted(DATA_ROOT.rglob("*_channels.tsv")):
        edf = tsv.with_name(tsv.name.replace("_channels.tsv", "_ieeg.edf"))
        if not edf.exists():
            continue
        gold = load_soz_gold(edf)
        if gold.has_labels:
            out.append(gold)
            if limit and len(out) >= limit:
                break
    return out


def _looks_like_channel(value: Any) -> Optional[str]:
    text = str(value or "").strip()
    return text or None


def extract_candidates(tool_results: dict[str, Any], content: str, known: list[str]) -> tuple[list[str], str]:
    """Best-effort: pull the ranked candidate channels the agent produced.

    Tries the rank tool result first (ranked list), then the detection result's top channels, then the
    final answer text scanned for known channel names. Returns (channels_best_first, source_label).
    """
    # 1. pyhfo_rank_candidate_channels -> a ranked list somewhere in the result tree.
    rank = tool_results.get("pyhfo_rank_candidate_channels")
    ranked = _find_ranked_channels(rank)
    if ranked:
        return ranked, "rank_tool_result"
    # 2. detection result top channels / per-channel counts.
    det = tool_results.get("pyhfo_detect_events")
    ranked = _find_ranked_channels(det)
    if ranked:
        return ranked, "detect_tool_result"
    # 3. scan the final answer for known channel tokens (order of appearance).
    if content and known:
        low = content
        found: list[str] = []
        for ch in sorted(known, key=len, reverse=True):
            if not ch or ch in found:
                continue
            # Token-boundary match, not raw substring: overlapping BIDS names (A1 vs A10 vs RA1)
            # made `ch in low` extract phantom channels the agent never named, poisoning the F1 reward.
            if re.search(r"(?<![A-Za-z0-9])" + re.escape(ch) + r"(?![A-Za-z0-9])", low):
                found.append(ch)
        if found:
            return found, "final_answer_scan"
    return [], "none"


def _find_ranked_channels(tree: Any, _depth: int = 0) -> list[str]:
    """Recursively locate the first list of channel records and return names best-first.

    Handles unknown nesting by looking for a list whose items carry a channel-like key (channel/name/
    label/ch) plus optionally a rate/count to sort by. Defensive against shape drift in the tool output.
    """
    if _depth > 6 or tree is None:
        return []
    if isinstance(tree, dict):
        # Prefer obviously-named keys.
        for key in ("ranked_channels", "ranking", "candidates", "candidate_channels", "channels", "by_channel", "rows"):
            if key in tree:
                got = _channels_from_list(tree[key])
                if got:
                    return got
        for value in tree.values():
            got = _find_ranked_channels(value, _depth + 1)
            if got:
                return got
        return []
    if isinstance(tree, list):
        return _channels_from_list(tree)
    return []


def _channels_from_list(items: Any) -> list[str]:
    if not isinstance(items, list) or not items:
        return []
    # list of plain strings
    if all(isinstance(it, str) for it in items):
        return [it.strip() for it in items if it.strip()]
    # list of dicts -> sort by rate/count desc if present, take channel name
    rows: list[tuple[float, str]] = []
    for it in items:
        if not isinstance(it, dict):
            continue
        name = None
        for nk in ("channel", "name", "label", "ch", "channel_name"):
            if it.get(nk):
                name = _looks_like_channel(it[nk])
                break
        if not name:
            continue
        rate = 0.0
        for rk in ("rate", "rate_per_min", "events_per_min", "count", "n_events", "events", "score"):
            if isinstance(it.get(rk), (int, float)):
                rate = float(it[rk])
                break
        rows.append((rate, name))
    if not rows:
        return []
    has_rate = any(r != 0.0 for r, _ in rows)
    if has_rate:
        rows.sort(key=lambda rn: -rn[0])
    return [name for _, name in rows]


async def run_one(svc, gold: SozGold, uc, top_k: Optional[int], conversation_namespace: str) -> dict:
    from runtime.agent_runtime import pyhfo_tools  # bound active recording fallback

    conv_id = conversation_id_for_recording(gold.recording_path, conversation_namespace)
    msg = PIPELINE_PROMPT.format(path=gold.recording_path)
    ui_state = {"recording": {"loaded": True, "path": gold.recording_path}}
    trajectory: list[str] = []
    tool_results: dict[str, Any] = {}
    content_parts: list[str] = []
    error: Optional[str] = None
    try:
        async for ev in svc.stream_message(
            message=msg, conversation_id=conv_id, user_id=uc.user_id, user_role=uc.role,
            skill_environment="prod", user_context=uc, ui_state=ui_state, recording_path=gold.recording_path,
        ):
            e, d = ev.get("event"), (ev.get("data") or {})
            if e == "tool_call" and d.get("name"):
                trajectory.append(d["name"])
            elif e == "tool_result" and d.get("name"):
                tool_results[d["name"]] = d.get("result")
            elif e == "content":
                content_parts.append(str(d.get("text") or d.get("content") or ""))
            elif e == "error":
                error = str(d.get("message") or d.get("error") or "stream error")
    except Exception as exc:  # noqa: BLE001
        error = f"{type(exc).__name__}: {exc}"
    content = "".join(content_parts)
    candidates, source = extract_candidates(tool_results, content, gold.all_channels)
    # Score top-K where K defaults to the SOZ-or-resection size (did the top picks hit the SOZ?).
    k = top_k or max(1, len(gold.soz_or_resection))
    scored = score_candidates(candidates, gold, top_k=k)
    return {
        "recording": Path(gold.recording_path).name,
        "recording_path": gold.recording_path,
        "conversation_id": conv_id,
        "trajectory": trajectory,
        "candidate_channels": candidates[:k],
        "candidate_source": source,
        "reward": scored.get("reward"),
        "score": scored,
        "error": error,
    }


async def evaluate(
    limit: Optional[int] = 3,
    model: str = "qwen3.5-plus",
    top_k: Optional[int] = None,
    conversation_namespace: Optional[str] = None,
) -> dict:
    """Drive the agent over the scorable recordings and return an outcome report dict.

    Importable so the optimization loop can run A/B variants. Selects the explicit process-level
    authorized-headless profile so the isolated eval worker actually runs instead of staging. Caller
    may set env overrides (e.g. a prompt variant) before calling.
    """
    scorable = discover_scorable(limit)
    conversation_namespace = conversation_namespace or new_conversation_namespace("outcome")
    if not scorable:
        return {"model": model, "conversation_namespace": conversation_namespace, "n_recordings": 0, "n_scored": 0, "mean_reward": None, "results": []}

    os.environ.setdefault("PYHFO_AGENT_EXECUTION_PROFILE", "authorized_headless")
    from runtime.agent_history.db import init_db
    from runtime.core.config import config_manager
    from runtime.models.user_context import UserContext
    from runtime.runtime_bootstrap import get_agent_service
    from runtime.services.storage_service import get_storage_service
    from runtime.skills.skill_registry import skill_registry

    init_db(); get_storage_service(); config_manager.load_config(); skill_registry.scan_skills()
    uc = UserContext(user_id="opt-eval", username="doctor", role="USER")
    svc = get_agent_service(model)

    results = []
    for g in scorable:
        print(f"\n--- {Path(g.recording_path).name} ---")
        res = await run_one(svc, g, uc, top_k, conversation_namespace)
        results.append(res)
        print(f"  reward(f1 vs SOZ∪resection)={res['reward']}  candidates({res['candidate_source']})={res['candidate_channels']}"
              + (f"  ERROR={res['error']}" if res["error"] else ""))

    scored = [r for r in results if isinstance(r.get("reward"), (int, float))]
    mean_reward = round(sum(r["reward"] for r in scored) / len(scored), 4) if scored else None
    return {"model": model, "conversation_namespace": conversation_namespace, "n_recordings": len(results), "n_scored": len(scored),
            "mean_reward": mean_reward, "results": results}


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=3, help="max recordings to evaluate (each is a slow real run)")
    ap.add_argument("--model", default="qwen3.5-plus")
    ap.add_argument("--top-k", type=int, default=0, help="score top-K candidates (0 = #SOZ-or-resection)")
    ap.add_argument("--dry-run", action="store_true", help="list scorable recordings and exit")
    args = ap.parse_args()

    scorable = discover_scorable(args.limit)
    print(f"=== outcome eval: {len(scorable)} scorable recording(s) (limit={args.limit}) ===")
    for g in scorable:
        print(f"  {Path(g.recording_path).name}: {len(g.soz)} SOZ, {len(g.resection)} resection")
    if args.dry_run:
        print("(dry-run) not driving the agent.")
        return
    if not scorable:
        print("No SOZ-labelled recordings found. Nothing to score.")
        return

    report = await evaluate(limit=args.limit, model=args.model, top_k=args.top_k or None)
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n=== mean reward (F1 vs SOZ∪resection) over {report['n_scored']} scored: {report['mean_reward']} ===\nreport: {REPORT}")


if __name__ == "__main__":
    asyncio.run(main())
