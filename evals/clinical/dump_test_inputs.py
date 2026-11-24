#!/usr/bin/env python3
"""Dump the exact INPUT given to the agent for every clinical test scenario, into one file.

For each scenario this is the `message=` string the eval passes to the agent under test (the
desktop/session context block + the clinician's request, built by rubric.build_agent_input). The
runtime additionally prepends the system prompt + routed skill; this file is the part the TEST
authors and feeds in. Generated from clinical_scenarios.json so it never drifts.

Regenerate after editing scenarios:  PYTHONPATH=. python evals/clinical/dump_test_inputs.py
"""
from __future__ import annotations

from pathlib import Path

from evals.clinical.rubric import load_scenarios, build_agent_input

OUT = Path(__file__).resolve().parents[2] / "docs" / "clinical-eval-agent-inputs.md"
GENERATED_ON = "2026-06-16"


def main() -> None:
    scenarios = load_scenarios()
    parts = [
        "# iEEG Clinical Eval — Agent Inputs (the test prompts fed to the agent)\n\n"
        f"> Generated {GENERATED_ON} by `evals/clinical/dump_test_inputs.py` from "
        "`evals/clinical/clinical_scenarios.json` (via `rubric.build_agent_input`).\n"
        "> Each block below is the EXACT `message=` string the eval sends to the agent under test for "
        "that scenario. At runtime the agent ALSO receives the system prompt + the routed skill body "
        "(see `docs/clinical-copilot-prompt.md`); this document is only the per-turn input the test "
        "authors. Read-only snapshot — `clinical_scenarios.json` stays canonical.\n\n"
        f"{len(scenarios)} scenarios.\n"
    ]
    for sc in scenarios:
        meta = f"kind: {sc.kind}"
        if sc.expected_verdict:
            meta += f"  ·  expected verdict: {sc.expected_verdict}"
        parts.append(
            f"\n---\n\n## {sc.id}\n\n"
            f"_{meta}_\n\n"
            + (f"> Scenario note: {sc.note}\n\n" if sc.note else "")
            + "```text\n" + build_agent_input(sc) + "\n```\n"
        )
    OUT.write_text("".join(parts) + "\n", encoding="utf-8")
    print(f"wrote {OUT}  ({OUT.stat().st_size} bytes, {len(scenarios)} scenarios)")


if __name__ == "__main__":
    main()
