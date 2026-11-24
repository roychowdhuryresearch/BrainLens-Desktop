# Recording and session contract

Status: Canonical
Contract: IC-SESSION

The recording fingerprint, not a display filename, is the stable data identity.
All derived state carries that fingerprint and a state revision. Opening a new
recording invalidates stale run/event selections and receipts. Channel labels,
sample rate, duration and units come from the loaded recording or a cited
sidecar; they are never inferred from prompt text.

| ID | Requirement | Proof |
| --- | --- | --- |
| IC-SESSION-001 | Recording-scoped actions fail when no matching recording is loaded. | `tests/test_ui_command_context.py` |
| IC-SESSION-002 | Derived runs and artifacts carry recording fingerprint and state revision. | `tests/test_clinical_evidence_contract.py` |
| IC-SESSION-003 | Recording changes invalidate stale run/event/action state. | `desktop/tests/agent-command-policy.test.js` |
| IC-SESSION-004 | Clinical identifiers and raw local paths are redacted from telemetry. | `tests/test_history_redaction_contract.py` |
