from __future__ import annotations

import argparse
import json
from contextlib import nullcontext
from pathlib import Path

from .audit import (
    audit_change_set,
    collect_changed_paths,
    run_proofs,
    staged_index_snapshot,
)


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit iEEG Agent contract ownership and proofs")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--staged", action="store_true", help="audit the exact Git index")
    mode.add_argument("--base", help="audit changes from BASE...HEAD")
    parser.add_argument("--run-proofs", action="store_true", help="execute selected proof files")
    parser.add_argument("--no-declarations", action="store_true", help="skip impact-note checks")
    parser.add_argument("--json", action="store_true", help="emit JSON")
    args = parser.parse_args()

    root = Path.cwd().resolve()
    paths = collect_changed_paths(root, staged=args.staged, base=args.base)
    execution_root = staged_index_snapshot(root) if args.staged else nullcontext(root)
    with execution_root as audit_root:
        result = audit_change_set(
            audit_root,
            paths,
            require_declarations=not args.no_declarations,
        )
        if args.run_proofs and result.ok:
            result.errors.extend(run_proofs(audit_root, result.selected_proofs))

    payload = {
        "ok": result.ok,
        "changed_paths": list(result.changed_paths),
        "impacted_modules": sorted(result.impacted_modules),
        "candidate_owners": sorted(result.candidate_owners),
        "selected_proofs": list(result.selected_proofs),
        "errors": result.errors,
    }
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print("contract gate: PASS" if result.ok else "contract gate: FAIL")
        for error in result.errors:
            print(f"- {error}")
        if result.selected_proofs:
            print("proofs:")
            for proof in result.selected_proofs:
                print(f"- {proof}")
    return 0 if result.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
