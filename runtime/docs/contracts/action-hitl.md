# Action and HITL contract

Status: Canonical
Contract: IC-ACTION

## Authority and state

An Agent may propose an action but cannot enlarge its own authority. Effective
authority is the intersection of authenticated actor permissions, command
policy, recording/run/event scope, request policy and the matching approval.
Every proposal has an unpredictable command identifier. Durable UI receipts use
only `queued|applied|running|complete|failed|rejected|noop`; adapter aliases such
as `staged`, `dismissed`, and `error` are canonicalized before persistence.
Operation approvals separately bind request, session, conversation, actor,
canonical payload digest, and optional state revision for every transition.

A local autonomy preference is not an approval grant. Commands whose catalog
profile requires a clinician always stage. The renderer mints a per-command
human-interaction nonce on Apply, waits for the broker to durably accept the
scoped `applied` transition, and only then starts the backend side effect.
Broker rejection, unavailability, a non-canonical command ID, or malformed ACK
therefore produces zero execution.
The captured session, conversation, and canonical state revision must still
equal the live workspace both before the broker round-trip and again immediately
after its durable ACK. The post-ACK check and handler dispatch share one
synchronous continuation, closing the authorization TOCTOU window. A staged
card is rejected, not rebound, after any scope change—even if the new recording
reuses the same run or event identifier.

`applied` means the renderer accepted the command; for compute/artifact actions
it is not terminal. Only a persisted terminal receipt satisfying the declared
postcondition permits the Agent to claim completion.

A terminal review receipt is authoritative only after the runtime binds the
broker ACK to the freshly issued command and the exact recording fingerprint,
request ID, assistant message ID, conversation ID, and state revision. That
binding is SHA-256 sealed with command/payload/actor/postcondition identity and
is revalidated before final-answer evaluation.

## Requirements

| ID | Requirement | Proof |
| --- | --- | --- |
| IC-ACTION-001 | Every command resolves to a catalog policy with owner, effect, scope, approval and postcondition. | `tests/test_ui_action_contract.py` |
| IC-ACTION-002 | Writes require an exact actor/request/session/conversation/payload/state binding and cannot be confirmed, executed, cancelled or rolled back outside it. | `tests/test_operation_safety_contract.py` |
| IC-ACTION-003 | Command IDs and idempotency keys prevent accidental replay of side effects. | `tests/test_ui_action_contract.py` |
| IC-ACTION-004 | Receipts survive process restart and enforce legal state transitions. | `tests/test_ui_action_contract.py` |
| IC-ACTION-005 | `rejected`, `noop`, `failed`, `cancelled` and `expired` never become success. | `tests/test_ui_mcp_server_contract.py` |
| IC-ACTION-006 | Compute/export completion requires callback proof, not queue or apply acknowledgement. | `tests/test_ui_mcp_server_contract.py` |
| IC-ACTION-007 | Direct PyHFO side effects are disabled in co-pilot mode; only a process-start authorized-headless profile may execute them without UI receipts. | `tests/test_pyhfo_authority_guard.py` |
| IC-ACTION-008 | Terminal review evidence is bound to exact recording bytes and active request/message/conversation/state; missing scope, cross-recording replay, cross-turn replay, and same-path byte replacement fail closed. | `tests/test_agent_orchestrator.py`, `tests/test_ui_action_contract.py` |
| IC-ACTION-009 | No autonomy setting can mint clinician authority; Apply rejects stale session/conversation/state scope and waits for durable broker authorization before any side effect starts. | `desktop/tests/agent-command-policy.test.js`, `desktop/tests/staged-command-authorization.test.js` |

## Retry and compensation

View/read commands may be replayed. Idempotent parameter changes may be retried
with the same key. Compute, annotation, accepted-run, project and export writes
must not be silently retried. Rollback is available only where the catalog names
a compensating action and the receipt records sufficient prior state.
