# XLP-STREAM-EVENT-V1

Status: Canonical

Schema: [schemas/stream-event-v1.schema.json](schemas/stream-event-v1.schema.json)

## Purpose

This contract defines semantic events for one Agent turn independently of SSE, WebSocket, or Electron IPC framing. Each event carries the contract version, request and conversation IDs, a monotonically increasing sequence, an event name, visibility, and typed data.

The internal HTTP gateway requires `X-Contract-Version: ieeg-agent.v1` on chat and control calls. In SSE framing the `event:` line repeats the semantic event name for routing, while the complete semantic envelope is the JSON value on the `data:` line. Consumers validate the envelope rather than treating the SSE event name or EOF as proof.

## Terminal state machine

`done` is the only terminal event. A valid stream therefore obeys all of the following:

1. sequence numbers increase without reuse;
2. exactly one `done` is emitted;
3. no event follows `done`;
4. EOF before `done` is a failed turn;
5. an `error` event is a sanitized diagnostic and must still be followed by `done(outcome=failed|cancelled)`;
6. only `done(outcome=completed)` establishes successful completion.

`done` carries the final visible content, response language, all known action receipts, a compatibility list of emitted UI commands, and optional research output. The command list proves delivery only; receipts prove effects. For failure or cancellation `done` carries the typed public error instead of final content.

## Visibility

Public events are limited to status/progress, authorized attachment references, visible content, UI commands, action receipts, research output, actor-bound input requests, approval results, sanitized errors, and `done`. Planning, tool telemetry, verification internals, provider reasoning, tool arguments, and raw tool results are internal-only. The gateway may derive a typed `ui_command` from a successful `emit_ui_command` result, but it never forwards that raw tool event. A producer cannot mark `thinking` public, and a gateway drops rather than forwards unknown event types.

## Clinical rule

Visible text does not prove an action or claim. A UI effect is supported by an action receipt; an iEEG claim is supported by a research output. Consumers retain these typed records rather than attempting to reconstruct them from prose.
