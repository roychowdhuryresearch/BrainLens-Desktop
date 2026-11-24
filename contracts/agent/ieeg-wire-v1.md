# XLP-IEEG-WIRE-V1

Status: Canonical

Schema: [schemas/ieeg-wire-v1.schema.json](schemas/ieeg-wire-v1.schema.json)

## Purpose

This contract defines the strict Agent request/response envelope, UI command envelope, UI state snapshot, and actor-bound user-input submission. It is the identity and scope boundary shared by the runtime, MCP broker, and desktop.

## Required context

Every Agent turn identifies:

- `contract_version`, `request_id`, and `conversation_id`;
- the actor's `user_id`, role, and `session_id`;
- an explicit `resource_scope.state_revision` and, when applicable, recording fingerprint, run ID, event ID, and project ID;
- the permission set and the requested response language.

Blank or malformed identifiers, stale state revisions, unrecognized command types, and missing actor/session scope fail closed. `null` and `[]` retain different meanings for skill/MCP allowlists: `null` delegates to service policy while `[]` allows none.

## UI commands

`UICommandType` mirrors `contracts/ui-command-catalog.json` exactly. The current v1 command contains the turn identity, unpredictable command ID, reason, explicit payload, confirmation requirement, source, and any resolved broker policy/deduplication metadata actually returned by the broker. The broker validates supplied issuance identity and binds it to the renderer's current session and state revision. Confirmation-gated commands require request, response-message, conversation, session, and resource-state scope before they can be queued; a gateway may project the active request scope but must reject conflicts and must not fabricate resource identity. View/read compatibility commands may omit issuance enrichments.

For compatibility with existing desktop consumers, `session_id` and `state_revision` may be repeated at the command top level. `resource_scope.state_revision` is canonical and, when both forms are present, they must be identical. The broker receipt freezes request, message, conversation, state revision, recording fingerprint, and a hash of the issuance session before renderer acknowledgement; later successful acknowledgements must match that scope.

The desktop validates the command against current UI state and the catalog before execution. It returns an `XLP-ACTION-RECEIPT-V1` receipt. Command presence in an Agent response or `done.ui_commands` is compatibility delivery state, not evidence of execution.

## Response

A synchronous response uses one of `completed`, `cancelled`, or `failed`. Non-completed outcomes require a public, sanitized error. Completed responses may include a research output and must include every known action receipt, including explicit non-success receipts.

## Compatibility rule

Unknown fields and enum values are rejected in v1. New fields require a contract revision and coordinated producer/validator/consumer proof. A compatibility adapter must not invent missing conversation, actor, recording, run, event, or state-revision scope.

During migration of legacy desktop requests only, the internal gateway may derive a missing `response_language` deterministically from the current message (`zh-CN` when it contains CJK ideographs, otherwise `en-US`). An explicit supported value always wins, and the resolved value is carried into the final-step prompt and every public content/terminal event; no prior-conversation or shared default is consulted.
