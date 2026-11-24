#!/usr/bin/env python3
"""Objective outcome reward: do the agent's signal-derived candidate channels localize the SOZ?

The clinical point of HFO detection is to localize the seizure-onset zone (SOZ). So the reward for an
autonomous agent run is NOT "did it call the right tools" — it's "did the channels it surfaced actually
match the SOZ/resection ground truth". Gold lives in the BIDS ``*_channels.tsv`` next to every recording
(columns ``soz`` / ``resection``, values 1/0/-1), the same file PyHFO's gated
``compare_candidate_channels_to_bids_labels`` reads — we mirror its semantics here as a standalone,
dependency-free scorer so the harness can score OUT OF BAND (the agent never sees the labels).

This module is pure (stdlib only) and unit-checkable without a model or PyHFO:
    python -m evals.optimize.reward            # self-test on a real channels.tsv
    python -m evals.optimize.reward <edf_path> <ch1> <ch2> ...   # score an explicit candidate list
"""
from __future__ import annotations

import csv
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Optional


# ----- gold (BIDS channels.tsv) -------------------------------------------------------------------

def candidate_channels_tsv(recording_path: str | Path) -> Optional[Path]:
    """Locate the BIDS ``*_channels.tsv`` beside a recording (mirrors PyHFO's _candidate_channels_tsv)."""
    path = Path(str(recording_path)).expanduser()
    name = path.name
    candidates: list[Path] = []
    for suffix in ("_ieeg.edf", "_ieeg.fif", "_ieeg.fif.gz"):
        if name.endswith(suffix):
            candidates.append(path.with_name(name[: -len(suffix)] + "_channels.tsv"))
    # generic <stem>_channels.tsv (handles _ieeg already stripped, or non-_ieeg names)
    stem = path.name
    for ext in (".edf", ".fif.gz", ".fif"):
        if stem.endswith(ext):
            stem = stem[: -len(ext)]
            break
    candidates.append(path.with_name(f"{stem}_channels.tsv"))
    candidates.append(path.with_name(f"{path.stem}_channels.tsv"))
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return None


@dataclass
class SozGold:
    recording_path: str
    channels_tsv: Optional[str]
    all_channels: list[str] = field(default_factory=list)
    soz: list[str] = field(default_factory=list)
    resection: list[str] = field(default_factory=list)

    @property
    def soz_or_resection(self) -> list[str]:
        seen, out = set(), []
        for ch in [*self.soz, *self.resection]:
            low = ch.lower()
            if low not in seen:
                seen.add(low)
                out.append(ch)
        return out

    @property
    def has_labels(self) -> bool:
        return bool(self.soz or self.resection)


def load_soz_gold(recording_path: str | Path) -> SozGold:
    """Read SOZ / resection ground truth from the BIDS channels.tsv next to a recording.

    A channel is positive when its column value is exactly "1" (1=yes, 0=no, -1=unknown), matching
    PyHFO's reader. Returns empty label lists (has_labels=False) when no tsv / no labels are present.
    """
    tsv = candidate_channels_tsv(recording_path)
    gold = SozGold(recording_path=str(recording_path), channels_tsv=str(tsv) if tsv else None)
    if tsv is None:
        return gold
    with tsv.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle, delimiter="\t")
        rows = list(reader)
    fields = {f.lower(): f for f in (reader.fieldnames or [])}
    name_col = fields.get("name")
    soz_col = fields.get("soz")
    res_col = fields.get("resection")
    for row in rows:
        ch = str(row.get(name_col, "") if name_col else "").strip()
        if not ch:
            continue
        gold.all_channels.append(ch)
        if soz_col and str(row.get(soz_col, "")).strip() == "1":
            gold.soz.append(ch)
        if res_col and str(row.get(res_col, "")).strip() == "1":
            gold.resection.append(ch)
    return gold


# ----- reward (candidate channels vs gold) --------------------------------------------------------

def _norm(channels: Iterable[str]) -> dict[str, str]:
    """Case-insensitive lookup: lowercased -> original. Mirrors PyHFO's case-insensitive matching."""
    out: dict[str, str] = {}
    for ch in channels:
        key = str(ch).strip().lower()
        if key and key not in out:
            out[key] = str(ch).strip()
    return out


def _prf(tp: int, n_pred: int, n_gold: int) -> dict[str, float]:
    precision = tp / n_pred if n_pred else 0.0
    recall = tp / n_gold if n_gold else 0.0
    f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) else 0.0
    return {"precision": round(precision, 4), "recall": round(recall, 4), "f1": round(f1, 4)}


def score_candidates(candidate_channels: Iterable[str], gold: SozGold, top_k: Optional[int] = None) -> dict:
    """Score a (ranked) candidate channel list against SOZ/resection gold.

    candidate_channels should be ordered best-first; top_k truncates to the top K before scoring
    (use the count of SOZ channels, or a fixed K, to evaluate "did the top picks hit the SOZ").
    Reward = F1 against soz_or_resection (the headline number); soz-only metrics are also returned.
    """
    ranked = [str(c).strip() for c in candidate_channels if str(c).strip()]
    if top_k is not None:
        ranked = ranked[:top_k]
    pred = _norm(ranked)
    result: dict = {
        "candidate_count": len(pred),
        "top_k": top_k,
        "has_labels": gold.has_labels,
        "label_counts": {"soz": len(gold.soz), "resection": len(gold.resection), "soz_or_resection": len(gold.soz_or_resection)},
        "channels_tsv": gold.channels_tsv,
    }
    if not gold.has_labels:
        result["reward"] = None
        result["note"] = "no SOZ/resection labels for this recording — not scorable"
        return result
    for key, gold_list in (("soz", gold.soz), ("resection", gold.resection), ("soz_or_resection", gold.soz_or_resection)):
        gset = _norm(gold_list)
        hits = sorted(pred[k] for k in pred if k in gset)
        m = _prf(len(hits), len(pred), len(gset))
        m["matches"] = hits
        result[key] = m
    # Headline reward = F1 vs soz_or_resection (clinically the union doctors care about).
    result["reward"] = result["soz_or_resection"]["f1"]
    return result


def _self_test() -> int:
    """Find a real channels.tsv with SOZ labels and sanity-check the scorer."""
    root = Path(__file__).resolve().parents[2]
    data = root / "data" / "Omni-iEEG"
    sample = None
    for tsv in data.rglob("*sourcesink*_channels.tsv"):
        edf = tsv.with_name(tsv.name.replace("_channels.tsv", "_ieeg.edf"))
        g = load_soz_gold(edf)
        if g.has_labels:
            sample = (edf, g)
            break
    if not sample:
        print("self-test: no SOZ-labelled recording found under data/Omni-iEEG")
        return 1
    edf, gold = sample
    print(f"gold: {Path(edf).name}\n  channels_tsv={gold.channels_tsv}")
    print(f"  {len(gold.all_channels)} channels, {len(gold.soz)} SOZ, {len(gold.resection)} resection")
    # perfect prediction = exactly the SOZ-or-resection set -> recall 1.0, precision 1.0
    perfect = score_candidates(gold.soz_or_resection, gold)
    # half prediction -> recall ~0.5
    half = score_candidates(gold.soz_or_resection[: max(1, len(gold.soz_or_resection) // 2)], gold)
    # polluted prediction = gold + 3 non-SOZ channels -> precision < 1.0
    non = [c for c in gold.all_channels if c.lower() not in _norm(gold.soz_or_resection)][:3]
    polluted = score_candidates([*gold.soz_or_resection, *non], gold)
    print(f"  perfect:  reward(f1)={perfect['reward']} P={perfect['soz_or_resection']['precision']} R={perfect['soz_or_resection']['recall']}")
    print(f"  half:     reward(f1)={half['reward']} R={half['soz_or_resection']['recall']}")
    print(f"  polluted: reward(f1)={polluted['reward']} P={polluted['soz_or_resection']['precision']}")
    ok = (perfect["reward"] == 1.0 and half["soz_or_resection"]["recall"] < 1.0 and polluted["soz_or_resection"]["precision"] < 1.0)
    print("SELF-TEST:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args:
        raise SystemExit(_self_test())
    rec = args[0]
    cands = args[1:]
    gold = load_soz_gold(rec)
    import json
    print(json.dumps(score_candidates(cands, gold), ensure_ascii=False, indent=2))
