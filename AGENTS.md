# iEEG Agent engineering contract

This repository is a clinical/iEEG research co-pilot. Production behavior is
governed by the capability contracts in `runtime/docs/contracts/`, the versioned
protocols in `contracts/agent/`, and `contracts/ui-command-catalog.json`.

## Contract-impact declaration

Any change under `runtime/`, `ui_mcp/`, `desktop/src/`, `desktop/electron/`,
`pyhfo/src/`, or `contracts/` must include exactly one changed implementation
note that applies to each impacted module. Notes live in
`docs/implementation-notes/` and contain:

```text
Modules: runtime, ui_mcp
Contract-Impact: none|changed
Contract-Impact-Reason: substantive explanation of compatibility
Contract-Owners-Changed: IC-RUNTIME, IC-ACTION  # required only for changed
Contract-Proof: tests/test_specific_behavior.py
```

Proofs must be ordinary executable tests in the same change set. Supplemental
E2E and screenshots cannot replace a regular proof. `Contract-Impact: changed`
requires the named canonical owner documents to change in the same change set;
`none` forbids that combination. Invalid declarations fail closed.

Run the local gate on the exact index before handoff:

```bash
python -m contract_gate --staged --run-proofs
```

Production symlinks, unowned new files, unsupported protocol versions, missing
scope, terminal-less streams, actor-mismatched approvals, and false completion
claims are gate failures.

## Research-integrity invariants

- Detector outputs are candidates until a terminal clinician review receipt.
- QC describes technical signal quality, not diagnosis.
- Channel labels alone do not establish anatomy, pathology, or SOZ.
- Rankings bind to explicit run IDs and may not silently re-run analysis.
- Claims and artifacts carry recording fingerprint, software/algorithm version,
  complete effective parameters, warnings, and provenance.
- Compute, annotation, accepted-run, project, and export writes require the
  catalog approval and terminal-proof semantics.
