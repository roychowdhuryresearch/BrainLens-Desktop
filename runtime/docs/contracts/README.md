# iEEG Agent capability contracts

Status: Canonical

These contracts define the safety and research-integrity boundary of the iEEG
research co-pilot. They are normative for runtime code, prompts, MCP tools,
PyHFO integration, and the Electron renderer. Product prose and skill text may
narrow these rules but may not grant authority beyond them.

Every capability contract contains:

- actors and authority;
- state and action semantics;
- failure and idempotency semantics;
- observability and provenance requirements;
- stable requirement IDs with executable proof files;
- explicit gaps that must not be represented as implemented behavior.

## Capability owners

| Contract | Owner | Scope |
| --- | --- | --- |
| IC-RUNTIME | Agent runtime | Request scope, orchestration, stream terminality, cancellation, finalization |
| IC-ACTION | Action/HITL boundary | UI/PyHFO actions, approval, receipts, idempotency, rollback |
| IC-EVIDENCE | Clinical evidence boundary | Research claims, uncertainty, provenance, prohibited inference |
| IC-SESSION | Recording/session boundary | Recording identity, fingerprints, channel/sample metadata, stale-state barriers |
| IC-ANALYSIS | Analysis boundary | QC, detection, classification, ranking and run selection |
| IC-ARTIFACT | Artifact/provenance boundary | Reports, workbooks, projects, export lineage and sensitivity |
| IC-HISTORY | History/observability boundary | Turn history, action ledger, replay, redaction, retention |
| IC-CONTROL | Control/evaluation boundary | HITL control, preview, evals and synthetic execution |

Machine ownership is defined in `ownership-map.json`. Cross-layer ABI contracts
and schemas live in `contracts/agent/`.

## Change rule

Production changes must be attributable to at least one capability owner. A
change set must declare `Contract-Impact: none|changed`, provide a substantive
reason, and name executable proof files. An invalid or missing declaration is a
gate failure; it never weakens owner enforcement.
