#!/usr/bin/env python3
"""Assemble the FULL validated prompt surface into one file.

The runtime never stores the prompt as a single document — it sends system_prompt.md plus
whichever SKILL.md body routes for the turn plus a per-turn desktop/session context block.
This concatenates those live source files into one human-readable artifact so the exact prompt
we validated (qwen3.5-plus, clinical eval det 6/6 / judge 6/6 on 2026-06-16) can be read,
reviewed, versioned, and shared in one place.

Reference artifact — the source files stay canonical. Regenerate after any prompt/skill edit:
    PYTHONPATH=. python evals/clinical/build_tested_prompt.py
"""
from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SYSTEM_PROMPT = REPO / "runtime" / "prompts" / "system_prompt.md"
SKILLS_ROOT = REPO / "skills" / "skills"
OUT = REPO / "docs" / "clinical-copilot-prompt.md"

GENERATED_ON = "2026-06-16"  # bump when regenerating (no Date.now() in this env by policy)


def parse_skill(md: str) -> dict:
    """Split a SKILL.md into frontmatter fields (flat) + body."""
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n(.*)$", md, re.S)
    fm_raw, body = (m.group(1), m.group(2)) if m else ("", md)
    fields: dict = {}
    for line in fm_raw.splitlines():
        km = re.match(r"^([a-zA-Z_]+)\s*:\s*(.*)$", line)
        if km:
            fields[km.group(1)] = km.group(2).strip()
    return {"fields": fields, "body": body.strip()}


def main() -> None:
    skills = []
    for d in sorted(SKILLS_ROOT.iterdir()):
        sk = d / "SKILL.md"
        if d.is_dir() and sk.exists():
            p = parse_skill(sk.read_text(encoding="utf-8"))
            try:
                prio = int(p["fields"].get("priority", "0"))
            except ValueError:
                prio = 0
            skills.append((prio, p["fields"].get("name", d.name), p))
    skills.sort(key=lambda t: (-t[0], t[1]))  # priority desc, then name

    parts = []
    parts.append(
        "# iEEG Clinical Co-pilot — Full Validated Prompt Surface\n\n"
        f"> Generated {GENERATED_ON} by `evals/clinical/build_tested_prompt.py` from the live source files "
        "(`runtime/prompts/system_prompt.md` + `skills/skills/*/SKILL.md`).\n"
        "> This is the exact prompt content validated against **qwen3.5-plus** "
        "(clinical-register eval `evals/clinical/`: deterministic **6/6**, LLM-judge **6/6**).\n"
        ">\n"
        "> At runtime the model receives, per turn: **(1)** the system prompt below, **(2)** the body of "
        "whichever skill(s) route for the request (descriptions drive routing — see each skill's "
        "`when_to_use`), and **(3)** a desktop/session context block (template in §3). This document is a "
        "READ-ONLY snapshot for review/sharing — the source files remain canonical. Regenerate after edits."
    )

    parts.append("\n\n---\n\n## 1. System prompt\n\n_Source: `runtime/prompts/system_prompt.md` "
                 "(`${current_date}` is substituted at runtime)._\n\n" + SYSTEM_PROMPT.read_text(encoding="utf-8").strip())

    parts.append("\n\n---\n\n## 2. Skills\n\nThe routed skill's workflow body is appended to the system prompt. "
                 "Listed by routing priority (high → low).\n")
    for prio, name, p in skills:
        f = p["fields"]
        parts.append(
            f"\n### {name}  ·  priority {prio}\n\n"
            f"_Source: `skills/skills/{name}/SKILL.md`_\n\n"
            f"- **description:** {f.get('description', '')}\n"
            f"- **when_to_use:** {f.get('when_to_use', '')}\n"
            f"- **do_not_use:** {f.get('do_not_use', '')}\n"
            f"- **allowed_tools:** {f.get('allowed_tools', '')}\n"
            f"- **output_format:** {f.get('output_format', '')}\n\n"
            f"{p['body']}\n"
        )

    parts.append(
        "\n---\n\n## 3. Desktop / session context block (injected per turn)\n\n"
        "Built from `get_ui_state` + session context and prepended to the doctor's message so the agent "
        "reasons over real loaded state instead of guessing. Validated template (from "
        "`evals/clinical/run_clinical_eval.py`):\n\n"
        "```\n"
        "[Desktop context: a recording is loaded and a detection run is complete.]\n"
        "recording: 18 iEEG channels, fs=2000 Hz, 600 s, line freq 60 Hz.\n"
        "active run: HFO ripple (STE, 80-250 Hz), artifacts removed.\n"
        "get_ui_state.analysis.candidate_ranking (events/min, kept events only) — present session context:\n"
        "  1. RA2 = 14.2/min\n  2. RA1 = 13.6/min\n  3. LH2 = 12.9/min\n  ...\n"
        "(RA*/RAH*/RB* are right temporal depth contacts; LH* is left hippocampal.)\n\n"
        "Doctor request:\n<the clinician's message>\n"
        "```\n"
    )

    parts.append(
        "\n---\n\n## 4. How it was validated\n\n"
        "- **Model:** qwen3.5-plus, temperature 0 (judge: qwen3.5-flash).\n"
        "- **Probe:** `evals/_realmodel_d2_d5_probe.py` — concordance + summary turns; calibration / "
        "single-modality / boundary / no-overclaim all held.\n"
        "- **Eval:** `evals/clinical/run_clinical_eval.py` over `clinical_scenarios.json` (concordance "
        "agree/partial/conflict, summary, boundary over-reach + over-refusal traps), full ReAct via "
        "`stream_message`; scored on calibration / evidence_attribution / boundary(two-sided) / concordance "
        "/ register (`rubric.py`). Baseline: deterministic 6/6, judge 6/6.\n"
        "- **No-key gate:** `evals/clinical/selftest.py` + `tests/test_clinical_eval_selftest.py` lock the "
        "rubric against the two verified-good real outputs plus crafted negatives.\n"
        "- See `docs/agent-doctor-channel-repositioning-2026-06-16.md` for the why.\n"
    )

    OUT.write_text("".join(parts) + "\n", encoding="utf-8")
    print(f"wrote {OUT}  ({OUT.stat().st_size} bytes, {len(skills)} skills)")


if __name__ == "__main__":
    main()
