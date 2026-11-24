# Runtime orchestration contract

Status: Canonical
Contract: IC-RUNTIME

## Authority and state

The authenticated caller owns user and conversation identity. The runtime owns
transient route, plan, step, budget, cancellation, stream and finalization
state. A missing conversation identity may be rejected or mapped to a unique
ephemeral scope, but never to a shared global literal.

One accepted turn progresses through validation, scoped bootstrap, execution,
optional HITL, verification, durable finalization, success-only post-turn work,
and one terminal outcome. `done` is the only successful stream terminal. EOF,
`error`, content-only output, or malformed events without `done` are failures.

Durable success is irreversible. Observer, post-turn or delivery failures after
that boundary may fail transport but cannot invoke failure finalization or
rewrite the completed turn. Provider reasoning remains private; public progress
is sanitized and language-aligned.

## Requirements

| ID | Requirement | Proof |
| --- | --- | --- |
| IC-RUNTIME-001 | Request, user, conversation, skill, MCP and permission scope is stable and fail-closed. | `tests/test_internal_agent_contract_strong.py` |
| IC-RUNTIME-002 | Sync and stream projections require exactly one authoritative `done` for success. | `tests/test_agent_process_response.py` |
| IC-RUNTIME-003 | Replanning never replays completed side effects and all turn/tool budgets are bounded. | `tests/test_replan_guard.py` |
| IC-RUNTIME-004 | Cancellation and HITL are request/conversation/actor scoped. | `tests/test_user_input_state_machine.py` |
| IC-RUNTIME-005 | Success-only state, summary and memory work starts after durable finalization. | `tests/test_agent_orchestrator.py` |
| IC-RUNTIME-006 | Public failures and progress never expose raw provider errors or reasoning. | `tests/test_route_exception_sanitization.py` |
| IC-RUNTIME-007 | Response language follows the user's current natural language or explicit locale. | `tests/test_agent_process_response.py` |
| IC-RUNTIME-008 | A declared step `output_schema` is machine-validated; invalid or unsupported schemas cannot complete a step or survive the retry budget as success. | `tests/test_completion_contract.py` |

## Failure, retry and observability

Malformed scope, unsupported protocol versions, malformed HITL decisions and
terminal-less streams fail closed. Read-only operations may retry within a
budget; non-idempotent operations require an idempotency key or a new approval.
Trace data records route, plan, tool, receipt, provenance and terminal status,
with secrets and clinical identifiers redacted.

## Known gaps

- IC-RUNTIME-GAP-001: distributed cancellation requires a durable shared store.
- IC-RUNTIME-GAP-002: universal request replay suppression is not yet promised.
