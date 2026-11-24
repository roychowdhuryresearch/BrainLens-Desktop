# History and observability contract

Status: Canonical
Contract: IC-HISTORY

Product conversation history, runtime state, durable memory and the action ledger
are distinct stores. The action ledger is append-only and links intent, plan step,
command/idempotency key, approval actor, execution receipt, artifact/provenance and
the final claim. Replay is read-only and cannot re-execute tools.

| ID | Requirement | Proof |
| --- | --- | --- |
| IC-HISTORY-001 | Assistant message, validated research output, canonical terminal action receipts, and turn finalization commit in one database transaction under one preallocated message ID and active request/conversation/state scope; either all persist or all roll back. Acknowledgement serialization occurs before commit and no fallible refresh follows it. | `tests/test_history_atomic_completion.py` |
| IC-HISTORY-002 | Action receipts persist across broker/runtime restart. | `tests/test_ui_action_contract.py` |
| IC-HISTORY-003 | Replay and observability do not trigger side effects. | `tests/test_observability_service_final_answer.py` |
| IC-HISTORY-004 | Secrets, patient identifiers and raw paths are redacted before telemetry persistence. | `tests/test_history_redaction_contract.py` |
| IC-HISTORY-005 | History serialization recovers the complete public-safe research output and terminal receipts only when message/request/conversation/state scope remains valid; invalid-scope audit blobs recover to empty evidence, while pre-contract message rows remain readable with empty evidence defaults. | `tests/test_history_atomic_completion.py` |
