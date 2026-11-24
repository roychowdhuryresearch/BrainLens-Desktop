# Clinical evidence contract

Status: Canonical
Contract: IC-EVIDENCE

## Boundary

The co-pilot supports research review; it does not diagnose, localize a seizure
onset zone, or replace clinician judgment. Scientific claims must be traceable
to a recording fingerprint, run, algorithm/version, parameters and evidence
artifact or terminal action receipt. Missing evidence lowers or blocks a claim;
model prior knowledge cannot repair missing case evidence.

The runtime captures a bounded, turn-local ledger only from exact built-in
evidence tools. Each entry carries an adapter-owned execution attestation that
binds the exact tool name, canonical result digest, closed allowlist of evidence
kinds, execution scope, provenance, recording lineage and content-hashed
artifacts. Public evidence source, kind, value, recording fingerprint, state
revision, run and event scope must match that ledger (or a verified review
receipt); payload-internal consistency, model-authored arguments and
self-attested provenance are never authority.

The source recording fingerprint identifies the originally loaded bytes. The
input fingerprint identifies the bytes consumed by the tool, and a distinct
derived-input fingerprint records a preparation transform without replacing
the source identity. Public artifacts use content hashes and opaque references,
never a local path as proof.

`reviewed` and `confirmed` claims additionally bind to a terminal successful
`review_write` receipt from the same conversation. The claim actor ID and role,
the hashed workspace session, exact state revision, target, safe command payload
digest and review semantics must match the broker's verified actor scope and
observed postcondition. One receipt proves exactly one event/run target; an HFO
annotation or accepted detector run does not prove anatomy or SOZ.

## Invariants

| ID | Invariant | Proof |
| --- | --- | --- |
| IC-EVIDENCE-001 | A detector candidate is never represented as a confirmed HFO without an explicit clinician review receipt. | `tests/test_clinical_evidence_contract.py` |
| IC-EVIDENCE-002 | QC describes technical signal quality and never asserts a diagnosis. | `tests/test_clinical_evidence_contract.py` |
| IC-EVIDENCE-003 | Channel labels alone never establish anatomy, pathology or SOZ. | `tests/test_clinical_evidence_contract.py` |
| IC-EVIDENCE-004 | Ranking and comparisons bind to explicit run IDs; no silent re-detection or cross-run aggregation. | `tests/test_clinical_evidence_contract.py` |
| IC-EVIDENCE-005 | Numerical claims declare denominator, units, window/channel scope and partial-failure status. | `tests/test_clinical_evidence_contract.py` |
| IC-EVIDENCE-006 | Unsupported or stale claims are omitted or explicitly downgraded, never invented. | `tests/test_clinical_evidence_contract.py` |
| IC-EVIDENCE-007 | Model-authored evidence cannot self-attest execution, recording, run, event, state revision, or message scope. | `tests/test_clinical_evidence_contract.py` |
| IC-EVIDENCE-008 | One review receipt confirms exactly one event/run target; multi-target claims require exhaustive independent proof. | `tests/test_clinical_evidence_contract.py` |
| IC-EVIDENCE-009 | All nested public research values reject PHI, secrets and raw local paths before delivery. | `tests/test_clinical_evidence_contract.py` |
| IC-EVIDENCE-010 | Execution evidence requires an adapter-owned exact-tool attestation whose result digest and evidence kinds match the observed result and that tool's closed allowlist. | `tests/test_execution_attestation.py`, `tests/test_clinical_evidence_contract.py` |
| IC-EVIDENCE-011 | Claim kind, assertion semantics and numeric values project from compatible referenced evidence; coincidental scalar equality, relabeled evidence and invented channel/finding terms fail closed. | `tests/test_clinical_evidence_contract.py` |
| IC-EVIDENCE-012 | Source and analysis-input fingerprints remain distinct across preparation, and public artifacts exactly match content-hashed opaque adapter attestations. | `tests/test_execution_attestation.py`, `tests/test_clinical_evidence_contract.py` |
| IC-EVIDENCE-013 | Review proof matches the exact state, actor, command digest, single target and clinical label; a receipt cannot be repurposed for a different semantic conclusion. | `tests/test_clinical_evidence_contract.py` |

## Required provenance

Research output records the recording fingerprint, selected channels, sample
rate, algorithm and software version, complete effective parameters, run ID,
artifact hashes, QC/Nyquist/notch evidence, warnings, exclusions, approval
identity where applicable, and timestamps. Direct patient identifiers and raw
paths are not copied into public telemetry.

The final step binds the canonical research-output schema as soon as the first
trusted case-tool result enters the ledger, even when the step began without
case material. Safe missing-input and inconclusive replies stay prose-only;
substantive case findings cannot. Validated output and terminal receipts are
committed and recovered atomically with the assistant message and completed
turn under the history contract. Recursive public validation rejects sensitive
values, while observability/history redaction covers nested aliases, inline
secret signatures, and absolute, relative, and UNC clinical paths.
