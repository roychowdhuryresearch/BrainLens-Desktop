# XLP-RESEARCH-OUTPUT-V1

Status: Canonical

Schema: [schemas/research-output-v1.schema.json](schemas/research-output-v1.schema.json)

## Purpose

This contract turns an iEEG answer into evidence-linked research output. It is intentionally research-only and does not represent a clinical diagnosis or autonomous clinical decision.

## Top-level identity and provenance

Every output carries `schema_version`, output/request/conversation/message IDs,
the active `state_revision`, the SHA-256 `recording_fingerprint`, the exact
`run_ids`, response language, non-empty claims and evidence, provenance,
guardrails, limitations, and artifacts.

The runtime binds `request_id`, `conversation_id`, `message_id`,
`state_revision`, recording fingerprint, and response language to the active
turn. The message ID is preallocated and reused by durable persistence and the
terminal stream envelope. A case/recording review that reaches a substantive conclusion may
not fall back to prose-only success; missing canonical output fails the turn.
Generic educational questions and explicit requests for missing input remain
outside that case-output requirement.

The final step may begin without a research schema when no case material is
available. After an exact trusted case tool returns admissible evidence, the
runtime late-binds this schema before the next model completion and rebuilds the
prompt from the adapter-owned ledger. Model-authored tool arguments, forged
attestations, or tool-incompatible evidence kinds cannot trigger that binding.
A genuinely missing-input or inconclusive reply remains ordinary prose only
when it contains no case finding, channel assertion, or numeric result.

## Adapter-owned execution attestation

Execution authority comes from a versioned adapter attestation, not from the
model's tool arguments or output JSON. Each admitted ledger entry binds:

- the exact built-in tool name and canonical SHA-256 of its observed result;
- run/event/state scope extracted by the adapter;
- an evidence-kind set that is a non-empty subset of that exact tool's closed
  allowlist;
- software, algorithm/version, public effective parameters and their canonical
  digest, software components, and recording metadata; and
- artifacts discovered and content-hashed by the adapter.

A changed result digest, namespaced or lookalike tool, undeclared parameter,
tool-incompatible evidence kind, or model-supplied scope invalidates that entry
as research authority. Public provenance must exactly match one admitted
attestation, and every public evidence item must match its attested source,
kind, scope, and an observed result value.

Provenance records:

- Agent/PyHFO software version and optional commits/model digests;
- algorithm and algorithm version;
- the exact parameter object and its canonical SHA-256 digest;
- recording fingerprint, sampling frequency, channels, montage/reference, and evaluated interval;
- single-run or explicit multi-run scope and aggregation method;
- opaque/public artifact URI (never a local filesystem path), creator, timestamp, and checksum.

Recording lineage distinguishes the source recording from the bytes actually
consumed by an algorithm. `source_recording_fingerprint` identifies the loaded
source bytes; `input_recording_fingerprint` identifies the concrete analysis
input; and `derived_input_fingerprint` is present when preparation transformed
those bytes. These fields live in the execution attestation. The public
top-level `recording_fingerprint` and `provenance.recording.sha256` retain the
source identity, while derived inputs and outputs remain connected through the
attestation and content-addressed artifacts.

The top-level `recording_fingerprint` must equal `provenance.recording.sha256`,
and top-level `run_ids` must equal the declared provenance run scope. In
addition to these internal equalities, the fingerprint, revision, runs, event
targets, sources, and evidence values must be present in the turn-local trusted
tool-result ledger or a verified action receipt. Model-authored JSON cannot
self-attest any of them.

## Claims

Each claim contains `claim_id`, `kind`, `assertion`, `epistemic_status`, `evidence_refs`, and `run_ids`.

| Field | Closed values / rule |
| --- | --- |
| `kind` | `candidate`, `qc`, `anatomy`, `soz`, `ranking`, `comparison`, `numeric`, `summary` |
| `epistemic_status` | `observed`, `derived`, `reviewed`, `confirmed`, `hypothesis` |
| reviewed/confirmed | require `review_receipt_id`, actor identity/role/session hash, and the exact safe `review_command_payload`; its canonical digest, single event/run target, and observed proof must match a terminal verified review-write receipt in the same conversation; one receipt cannot confirm multiple targets |
| numeric | requires numeric `value`, `units`, `denominator`, typed `scope`, and explicit `partial_failure_status` |
| anatomy/SOZ | require at least one explicit evidence reference |

Evidence IDs are unique within an output, computed evidence binds to a declared run, every claim evidence reference resolves locally, and referenced evidence belongs to one of the claim's declared runs. Runtime validators enforce these referential and cross-receipt invariants before turn success is persisted.

`severity_score` evidence is recording-bound rather than detector-run-bound. It must identify the scalp recording and carry the attested BASED model identity, effective parameters, and result digest; it is a research signal measurement, not a diagnosis.

Claim validation is a typed projection, not just referential integrity. Claim
kind must be compatible with the attested evidence kind; case identifiers,
channel labels, and finding terms in the assertion must occur in referenced
trusted evidence or the exact review payload. A numeric value must occur under
a compatible metric in referenced evidence, textual counts must equal the
structured value, and count language requires a count-shaped result field
rather than an unrelated equal scalar.

A review receipt must be terminal, successful, `review_write`, postcondition-
verified, and bound to the same conversation and exact state revision (and to
request/message scope when present). Its actor and canonical command-payload
digest must match the claim. One receipt covers exactly one event/run target,
including targets nested inside evidence values. An HFO annotation or accepted
detector run cannot establish anatomy or SOZ; an SOZ claim may only relay an
explicit clinician-reviewed seizure-onset localization label.

Artifacts are admitted only when their complete public record exactly matches
an adapter attestation generated from bytes that existed at execution time.
The adapter hashes file content and exposes an opaque
`artifact://sha256/<digest>` reference; local paths and model-invented artifact
metadata are not authority.

## Durability and recovery

Successful completion atomically commits the visible assistant message, this
validated output, canonical terminal receipts, and the completed turn under the
preallocated message ID. History recovery returns the complete public-safe
output and receipts only when message/request/conversation/state scope still
matches; invalid-scope audit data recovers as empty evidence, and legacy rows
remain readable with empty contract metadata. No completed case result depends
on an in-memory-only object.

## Clinical guardrails

- Detector outputs are candidates, not confirmed HFOs.
- QC observations are research measurements, not diagnoses.
- Anatomy is either not inferred or comes from an explicit source; electrode/channel names alone are insufficient.
- SOZ is never inferred by this contract.
- Multiple runs are never silently aggregated; `explicit_multi_run` names the aggregation method.
- Limitations are mandatory even when all claims are supported.
- Every recursively nested public field rejects detected secrets, direct
  clinical identifiers, raw local paths, unsupported values, cycles, and
  unbounded containers before terminal success.
- Observability and durable metadata apply recursive key-alias, inline-token,
  and absolute/relative/UNC path redaction before persistence; redaction does
  not turn sensitive model-authored evidence into trusted evidence.
