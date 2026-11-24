#!/usr/bin/env python3
"""Real-model clinical-register eval (D1-D6): drive the FULL agent and score the REPLY.

For each clinical scenario we inject the candidate_ranking as present session context, drive the
real agent via stream_message (full ReAct loop + real skill routing), then score the final reply
with BOTH the deterministic heuristic (rubric.score_deterministic) and an LLM judge that refines
the nuanced calls (e.g. is the concordance verdict actually right). The trajectory (which tools it
called) is captured but is a SUB-metric — the primary verdict is the clinical-register score.

Run (repo root):  IEEG_AGENT_SKIP_MCP=1 python evals/clinical/run_clinical_eval.py [scenario_substr] [model]
Needs a real model key. NOT a deterministic CI test — the no-key gate is evals/clinical/selftest.py.
"""
import asyncio
import json
import os
import sys
import urllib.request
from pathlib import Path

from runtime.agent_history.db import init_db
from runtime.core.config import config_manager
from runtime.models.user_context import UserContext
from runtime.runtime_bootstrap import get_agent_service
from runtime.services.storage_service import get_storage_service
from runtime.skills.skill_registry import skill_registry

from evals.clinical.rubric import load_scenarios, score_deterministic, judge_prompt, aggregate, build_agent_input

_ARGS = sys.argv[1:]
MODEL = next((a for a in _ARGS if a.startswith(("qwen", "glm"))), "qwen3.5-plus")
FILTER = next((a for a in _ARGS if not a.startswith(("qwen", "glm"))), "")
JUDGE_MODEL = "qwen3.5-flash"


def build_message(sc) -> str:
    return build_agent_input(sc)  # single source of truth in rubric.py


async def run_turn(svc, conv_id, message, uc) -> tuple[list, str]:
    tools, content = [], []
    try:
        async for ev in svc.stream_message(
            message=message, conversation_id=conv_id, user_id=uc.user_id, user_role=uc.role,
            skill_environment="prod", user_context=uc, recording_path="/tmp/clinical_eval_case.edf",
        ):
            e, d = ev.get("event"), ev.get("data") or {}
            if e == "tool_call" and d.get("name"):
                tools.append(d["name"])
            elif e == "content":
                content.append(str(d.get("text") or d.get("content") or ""))
    except Exception as exc:  # noqa: BLE001
        return tools, f"[stream error: {exc}]"
    return tools, "".join(content)


def judge(sc, answer: str) -> dict:
    cfg = next((m for m in config_manager.config.ai_models if m.model == JUDGE_MODEL), config_manager.config.ai_models[0])
    body = {"model": cfg.model, "messages": [{"role": "user", "content": judge_prompt(sc, answer)}],
            "temperature": 0, "max_tokens": 400}
    for _ in range(3):
        try:
            req = urllib.request.Request(
                f"{cfg.api_base.rstrip('/')}/chat/completions", data=json.dumps(body).encode(), method="POST",
                headers={"content-type": "application/json", "authorization": f"Bearer {cfg.api_key}"})
            with urllib.request.urlopen(req, timeout=90) as r:
                txt = json.loads(r.read().decode())["choices"][0]["message"]["content"]
            parsed = json.loads(txt[txt.find("{"): txt.rfind("}") + 1])
            dims = {k: (int(v), "llm-judge") for k, v in parsed.items() if k != "issue" and isinstance(v, (int, float))}
            if dims:
                agg = aggregate(dims)
                agg["issue"] = parsed.get("issue", "")
                return agg
        except Exception:  # noqa: BLE001
            continue
    return {"pass": None, "scores": {}, "issue": "judge unavailable"}


async def main():
    init_db(); get_storage_service(); config_manager.load_config(); skill_registry.scan_skills()
    uc = UserContext(user_id="clin-eval", username="doctor", role="USER")
    scenarios = [s for s in load_scenarios() if (not FILTER or FILTER in s.id)]
    print(f"=== clinical-register eval: model={MODEL}, {len(scenarios)} scenario(s) ===\n")
    rows, det_pass, judge_pass = [], 0, 0
    for sc in scenarios:
        svc = get_agent_service(MODEL)
        tools, content = await run_turn(svc, f"clin-{sc.id}", build_message(sc), uc)
        det = score_deterministic(content, sc)
        jdg = judge(sc, content)
        det_pass += int(bool(det["pass"]))
        judge_pass += int(jdg.get("pass") is True)
        rows.append({"id": sc.id, "kind": sc.kind, "deterministic": det, "judge": jdg,
                     "tools": tools, "reply": content[:600]})
        d_ok = "PASS" if det["pass"] else "FAIL"
        j = jdg.get("pass")
        j_ok = "PASS" if j is True else ("n/a" if j is None else "FAIL")
        print(f"[{d_ok}/{j_ok}] {sc.id} ({sc.kind}) det={det['scores']} judge={jdg.get('scores')} "
              f"{'| ' + jdg['issue'] if jdg.get('issue') else ''}")
        print(f"    tools={tools}\n    reply: {content[:240].replace(chr(10), ' ')}...\n")
    n = len(scenarios) or 1
    summary = {"model": MODEL, "n": len(scenarios),
               "deterministic_pass": f"{det_pass}/{len(scenarios)}",
               "judge_pass": f"{judge_pass}/{len(scenarios)}"}
    out = Path(__file__).parent / "clinical_eval_report.json"
    out.write_text(json.dumps({"summary": summary, "rows": rows}, ensure_ascii=False, indent=2), encoding="utf-8")
    print("=== SUMMARY ===\n" + json.dumps(summary, ensure_ascii=False, indent=2) + f"\nreport: {out}")


if __name__ == "__main__":
    asyncio.run(main())
