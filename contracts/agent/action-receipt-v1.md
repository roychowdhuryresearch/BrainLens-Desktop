# XLP-ACTION-RECEIPT-V1

Status: Canonical

Schema: [schemas/action-receipt-v1.schema.json](schemas/action-receipt-v1.schema.json)

## Purpose

This contract closes the loop from Agent intent to an observed UI/PyHFO effect.
The broker, not the language model, produces the transport ACK and its observed
effect proof. The trusted runtime adapter is the sole producer of a canonical
terminal `review_write` receipt: it promotes that ACK only when the command was
freshly issued in the active turn and binds it to the exact recording bytes,
request, assistant message, conversation, and workspace state revision.
Until that promotion, an unbound terminal callback is explicitly versioned
`ieeg-agent.review-ack.transport.v1`; it is not an XLP-ACTION-RECEIPT-V1 object
and generic consumers must not treat it as canonical evidence.

## Lifecycle

The status enum deliberately matches the current UI catalog lifecycle:

| Status | Meaning | Terminal | Success |
| --- | --- | --- | --- |
| `queued` | issued by the broker and waiting for renderer handling or explicit approval | no | no claim yet |
| `applied` | handler accepted the command | conditional | only terminal for synchronous `view` or `read`; review writes remain non-terminal |
| `running` | asynchronous analysis/write is executing | no | no claim yet |
| `complete` | asynchronous effect finished and postcondition was verified | yes | yes |
| `failed` | execution failed | yes | no |
| `rejected` | policy or precondition blocked execution | yes | no |
| `noop` | handler produced no state/evidence change | yes | no |

For `analysis`, `compute`, `artifact_write`, `review_write`, and `destructive`, `applied` is non-terminal and must be followed by `running` or a terminal status. Adapter inputs may canonicalize legacy `staged` to `queued`, `dismissed` to `rejected`, and `error` to `failed`; aliases are never persisted as receipt statuses.

## Success requirements

A successful terminal receipt includes a non-empty observed result and verified postcondition. Evidence must be supplied by the renderer or backend acknowledgement. Renderer lifecycle markers such as an operation identifier, `finished_at`, or free-text detail are sufficient only for non-research UI effects; they are not compute or artifact proof. The broker must not synthesize an empty or circular proof. Research-output `ClinicalProvenance` remains governed by XLP-RESEARCH-OUTPUT-V1 and must not be fabricated inside this transport receipt.

Every confirmation-gated command is issued with a broker-validated request,
assistant message, conversation, workspace session, and state revision. A
recording-bound command additionally requires the lowercase SHA-256 of the
recording bytes. The queued receipt persists those authority fields as well as
`issuance_session_sha256` and `issuance_resource_scope_sha256`. These fixed
digests survive bounded transition-history trimming. A retry can recover
the same command only when payload, command type, and all issuance authority
match; an ACK can verify but never add or replace issuance scope.

Successful `compute` receipts require a `backend_readback` proof with backend
status `complete` and a result digest. `analysis.prepare_recording` additionally
binds the input fingerprint, output recording fingerprint, and effective
parameter digest. `detection.run` additionally binds the input fingerprint,
run identifier, parameter digest, non-negative event count, and non-negative
event-bearing channel count (both may be zero for a valid zero-event run). Successful
`artifact_write` receipts require backend existence read-back,
an artifact digest, and a result digest. `failed`, `rejected`, and `noop` remain
valid terminal outcomes without fabricated success proof.

`review_write` success additionally requires `complete` plus command-specific
proof bound to the exact in-memory issued payload. Annotation proof must come
from backend read-back and match event, run, requested label, and observed
label/clear state; run acceptance must match the issued run. Inert markers such
as `diff_state: unchanged` are never postcondition evidence.

Every terminal `review_write` receipt, including `failed`, `rejected`, and
`noop`, requires non-empty `request_id`, `message_id`, `conversation_id`, and
`state_revision`, a lowercase SHA-256 `recording_fingerprint`, and a lowercase
`scope_sha256`. The scope digest covers those five authority fields together
with receipt/command identity, issued-payload digest, terminal status,
clinician actor binding, and observed postcondition evidence. Missing or
conflicting scope is not canonical terminal evidence and cannot be persisted as
proof of a reviewed claim.

`noop`, `rejected`, and `failed` include a safe canonical reason; `failed` additionally carries a typed, sanitized error. Free-text failure details and privacy-sensitive identifiers are hashed before persistence. Failure receipts are never converted into success by the Agent's prose layer.

## Idempotency and actor binding

Replaying the same idempotency key returns the same broker command and must not
repeat a non-idempotent effect. A deduplicated command is never rebound to a
later request/message scope. Write-success transitions require the catalog
approval role plus actor ID, session ID, and source. The broker stores
actor/session hashes and rejects callbacks from a different actor,
conversation, command, session, or previously bound review scope. Each accepted
execution transition records its state revision.

Desktop autonomy preferences do not satisfy an approval role. A
clinician-authorized command remains `queued` until an explicit Apply action
adds an unpredictable human-interaction nonce. The renderer must await the
broker's durable, non-terminal `applied` receipt before invoking the command
handler or backend; an authorization error cannot be swallowed after execution.
The renderer compares the command's captured session, conversation, and
canonical state revision with the live workspace before authorization and again
after the awaited broker ACK, immediately before dispatch. A mismatch rejects
the card without execution and terminally rejects an already-applied receipt;
old commands are never rebound to a new recording merely because event/run
identifiers collide.

The adapter fingerprints recording contents when a new review command is
issued, fingerprints them again when terminal evidence is captured, and
revalidates immediately before final-answer evaluation. Replaying a receipt
against another recording, another turn, or changed bytes at the same path
fails closed.

## Durability and transition history

Receipt mutation and persistence are one fail-closed transaction: if the configured durable store cannot commit, emit/ACK fails and the in-memory mutation is rolled back. ACKs for unknown command IDs are rejected.

The transition ledger is append-only for accepted transitions. A receipt retains the newest 64 entries while `transition_count` remains monotonic, so bounded retention does not rewrite the history that remains.
