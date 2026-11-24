# iEEG Agent cross-layer contracts

Status: Canonical

Contract family: `ieeg-agent.v1`

Last refreshed: 2026-07-15

This directory is the machine-readable boundary for the clinical/iEEG research copilot. It connects the Agent runtime, the `ieeg_ui` MCP broker, the Electron renderer, and PyHFO without treating a generated sentence, an accepted command, or an algorithmic candidate as proof that a clinical action completed.

## Protocol inventory

| Contract ID | Protocol document | Draft 2020-12 schema |
| --- | --- | --- |
| `XLP-IEEG-WIRE-V1` | [iEEG wire](ieeg-wire-v1.md) | [ieeg-wire-v1.schema.json](schemas/ieeg-wire-v1.schema.json) |
| `XLP-STREAM-EVENT-V1` | [Stream events](stream-event-v1.md) | [stream-event-v1.schema.json](schemas/stream-event-v1.schema.json) |
| `XLP-RESEARCH-OUTPUT-V1` | [Research output](research-output-v1.md) | [research-output-v1.schema.json](schemas/research-output-v1.schema.json) |
| `XLP-ACTION-RECEIPT-V1` | [Action receipt](action-receipt-v1.md) | [action-receipt-v1.schema.json](schemas/action-receipt-v1.schema.json) |

The horizontal protocols above are complemented by [cross-layer feature slices](cross-layer-features.md), the machine-readable [feature map](feature-map.json), and the producer/validator/consumer [ownership map](ownership-map.json).

## Non-negotiable boundary rules

1. Contract versions, event names, command types, receipt statuses, claim kinds, error codes, and epistemic statuses are closed enums. Unknown values are rejected; they are not downgraded to a generic success path.
2. A request always carries a non-empty `request_id`, `conversation_id`, actor identity, session identity, permissions, and an explicit resource-state revision. There is no shared `default` conversation or recording scope in this protocol.
3. A stream has exactly one semantic terminal event: `done`. Transport EOF, `error`, a tool result, or emitted content cannot establish success. No event is valid after `done`.
4. A UI command is not complete when it is merely emitted, staged, or accepted. Success is established only by a terminal action receipt whose postcondition was read back and verified.
5. `noop`, `rejected`, `dismissed`, and `failed` are explicit non-success outcomes. An Agent must not narrate them as completed work.
6. Research claims cite evidence IDs and run IDs. Detector candidates remain candidates; they are not confirmed HFOs. Anatomy and seizure-onset-zone claims require explicit evidence and may not be inferred from channel labels.
7. Reviewed or confirmed claims identify the human review receipt and review actor. Numeric claims identify units, denominator, and scope.
8. Reproducible outputs bind the recording fingerprint, software and algorithm versions, exact parameter payload and digest, run scope, evaluated interval, and artifact checksums.

## Layer responsibilities

| Layer | Owns | Must not assume |
| --- | --- | --- |
| Agent runtime | request scoping, orchestration, event sequencing, finalization, claim assembly | that EOF is success, missing scope can default, or tool text proves an effect |
| `ieeg_ui` MCP | command validation, catalog compatibility, broker delivery, receipt polling | that command emission or `applied` always means an asynchronous operation completed |
| Electron desktop | current UI state, confirmation UX, command execution, read-back, receipt production | that an unknown command is safe or a handler no-op is success |
| PyHFO | signal computation, detector/classifier outputs, reproducibility metadata, artifact digests | that an algorithmic candidate is clinically confirmed or that a channel label establishes anatomy/SOZ |

## Evolution

Breaking changes require a new contract version. Additive fields still require a schema update because the v1 envelopes reject unknown fields. During a migration, adapters may dual-read the old representation, but every new producer writes only the canonical representation and reports its real lifecycle status.

## Proof

`tests/test_ieeg_cross_layer_contracts.py` checks schema validity, local reference resolution, schema examples, command-catalog parity, owner and proof paths, feature references, reverse ownership, terminal semantics, and clinical claim constraints. Existing runtime, MCP, renderer, and PyHFO tests remain the behavioral proof; schema shape checks do not replace them.
