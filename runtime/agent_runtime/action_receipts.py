from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from typing import Any, Mapping, Optional


_IDENTIFIER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
_SHA256_RE = re.compile(r"^[A-Fa-f0-9]{64}$")
_STATUSES = {"queued", "applied", "running", "complete", "failed", "rejected", "noop"}
_EFFECTS = {
    "view",
    "read",
    "analysis",
    "compute",
    "artifact_write",
    "review_write",
    "destructive",
}
_WRITE_EFFECTS = {"compute", "artifact_write", "review_write", "destructive"}
_FAILURE_STATUSES = {"failed", "rejected", "noop"}
_ACTOR_ROLES = {"researcher", "clinician", "reviewer", "administrator", "service"}
REVIEW_ACK_TRANSPORT_VERSION = "ieeg-agent.review-ack.transport.v1"
_REQUIRED_FIELDS = {
    "contract_version",
    "receipt_id",
    "command_id",
    "command_type",
    "status",
    "terminal",
    "occurred_at",
    "effect",
    "requires_confirmation",
    "owner",
    "research_impact",
    "idempotency",
    "retry",
    "timeout_seconds",
    "approval_role",
    "affected_resources",
    "postcondition_name",
    "data_sensitivity",
    "provenance",
    "transitions",
    "transition_count",
    "created_at",
}
_OPTIONAL_FIELDS = {
    "request_id",
    "conversation_id",
    "message_id",
    "recording_fingerprint",
    "scope_sha256",
    "issuance_session_sha256",
    "issuance_resource_scope_sha256",
    "success",
    "actor",
    "state_revision",
    "result",
    "postcondition",
    "reason",
    "error",
}
_TERMINAL_REVIEW_SCOPE_FIELDS = (
    "recording_fingerprint",
    "request_id",
    "message_id",
    "conversation_id",
    "state_revision",
)


@lru_cache(maxsize=1)
def _catalog_command_types() -> frozenset[str]:
    path = Path(__file__).resolve().parents[2] / "contracts" / "ui-command-catalog.json"
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, TypeError, ValueError, json.JSONDecodeError):
        return frozenset()
    commands = payload.get("commands") if isinstance(payload, Mapping) else None
    if not isinstance(commands, list):
        return frozenset()
    return frozenset(
        str(item.get("type") or "")
        for item in commands
        if isinstance(item, Mapping) and _non_empty_text(item.get("type"))
    )


def _identifier(value: Any) -> bool:
    return isinstance(value, str) and bool(_IDENTIFIER_RE.fullmatch(value))


def _sha256(value: Any) -> bool:
    return isinstance(value, str) and bool(_SHA256_RE.fullmatch(value))


def _non_empty_text(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _date_time(value: Any) -> bool:
    if not isinstance(value, str) or not value.strip():
        return False
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return parsed.tzinfo is not None


def _exact_keys(
    value: Mapping[str, Any],
    required: set[str],
    optional: set[str] | None = None,
) -> bool:
    keys = set(value)
    return required <= keys <= (required | (optional or set()))


def _valid_actor(value: Any) -> bool:
    return (
        isinstance(value, Mapping)
        and _exact_keys(
            value,
            {"role", "actor_id_sha256", "session_id_sha256", "source"},
        )
        and value.get("role") in _ACTOR_ROLES
        and _sha256(value.get("actor_id_sha256"))
        and _sha256(value.get("session_id_sha256"))
        and _non_empty_text(value.get("source"))
    )


def _valid_idempotency(value: Any) -> bool:
    if not isinstance(value, Mapping) or not _exact_keys(
        value,
        {"mode", "key_scope", "key_supplied"},
        {"key_sha256"},
    ):
        return False
    supplied = value.get("key_supplied")
    if not isinstance(supplied, bool):
        return False
    if supplied and not _sha256(value.get("key_sha256")):
        return False
    if not supplied and "key_sha256" in value:
        return False
    return (
        value.get("mode") in {"idempotent", "deduplicate_by_key", "non_idempotent"}
        and _non_empty_text(value.get("key_scope"))
    )


def _valid_retry(value: Any) -> bool:
    return (
        isinstance(value, Mapping)
        and _exact_keys(value, {"mode", "max_attempts", "backoff_ms"})
        and value.get("mode") in {"safe", "same_key_only", "never"}
        and isinstance(value.get("max_attempts"), int)
        and not isinstance(value.get("max_attempts"), bool)
        and value["max_attempts"] >= 1
        and isinstance(value.get("backoff_ms"), int)
        and not isinstance(value.get("backoff_ms"), bool)
        and value["backoff_ms"] >= 0
    )


def _valid_provenance(value: Any) -> bool:
    return (
        isinstance(value, Mapping)
        and _exact_keys(
            value,
            {"source", "payload_sha256", "command_effect", "effect_class"},
        )
        and value.get("source") == "mcp"
        and _sha256(value.get("payload_sha256"))
        and _non_empty_text(value.get("command_effect"))
        and _non_empty_text(value.get("effect_class"))
    )


def _valid_transition(value: Any) -> bool:
    optional = {
        "state_revision",
        "conversation_id",
        "actor_id_sha256",
        "session_id_sha256",
        "evidence_sha256",
    }
    if not isinstance(value, Mapping) or not _exact_keys(
        value,
        {"sequence", "from", "to", "observed_at", "source"},
        optional,
    ):
        return False
    if (
        not isinstance(value.get("sequence"), int)
        or isinstance(value.get("sequence"), bool)
        or value["sequence"] < 0
        or value.get("from") not in (_STATUSES | {None})
        or value.get("to") not in _STATUSES
        or not _date_time(value.get("observed_at"))
        or value.get("source") not in {"broker_emit", "renderer_ack"}
    ):
        return False
    for field in ("state_revision", "conversation_id"):
        if field in value and not _identifier(value.get(field)):
            return False
    for field in ("actor_id_sha256", "session_id_sha256", "evidence_sha256"):
        if field in value and not _sha256(value.get(field)):
            return False
    return True


def _valid_postcondition(value: Any) -> bool:
    return (
        isinstance(value, Mapping)
        and _exact_keys(
            value,
            {"name", "state_revision", "verified", "observed_at", "source", "evidence"},
        )
        and _non_empty_text(value.get("name"))
        and _identifier(value.get("state_revision"))
        and value.get("verified") is True
        and _date_time(value.get("observed_at"))
        and _non_empty_text(value.get("source"))
        and isinstance(value.get("evidence"), Mapping)
        and bool(value.get("evidence"))
    )


def _valid_error(value: Any) -> bool:
    required = {"code", "message", "retryable"}
    allowed_codes = {
        "validation_failed",
        "scope_missing",
        "scope_conflict",
        "permission_denied",
        "approval_missing",
        "stale_state",
        "resource_not_found",
        "backend_busy",
        "timeout",
        "execution_failed",
        "cancelled",
        "internal_error",
    }
    return (
        isinstance(value, Mapping)
        and _exact_keys(value, required, {"safe_details"})
        and value.get("code") in allowed_codes
        and _non_empty_text(value.get("message"))
        and isinstance(value.get("retryable"), bool)
        and ("safe_details" not in value or isinstance(value.get("safe_details"), Mapping))
    )


def _json_sha256(value: Any) -> Optional[str]:
    try:
        encoded = json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError):
        return None
    return hashlib.sha256(encoded).hexdigest()


def review_receipt_scope_sha256(value: Mapping[str, Any]) -> Optional[str]:
    """Hash the exact terminal review authority and proof binding.

    The digest is not a replacement for provider authentication.  It makes the
    trusted adapter's recording/turn binding mechanically inseparable from the
    command, issued payload, clinician actor, terminal status, and observed
    postcondition that the receipt carries.
    """

    if not isinstance(value, Mapping):
        return None
    provenance = value.get("provenance")
    postcondition = value.get("postcondition")
    actor = value.get("actor")
    evidence = (
        postcondition.get("evidence")
        if isinstance(postcondition, Mapping)
        else None
    )
    evidence_sha256 = _json_sha256(evidence) if evidence is not None else None
    actor_sha256 = _json_sha256(actor) if actor is not None else None
    if evidence is not None and evidence_sha256 is None:
        return None
    if actor is not None and actor_sha256 is None:
        return None
    scope = {
        "contract_version": value.get("contract_version"),
        "receipt_id": value.get("receipt_id"),
        "command_id": value.get("command_id"),
        "command_type": value.get("command_type"),
        "status": value.get("status"),
        "terminal": value.get("terminal"),
        "success": value.get("success"),
        "recording_fingerprint": value.get("recording_fingerprint"),
        "request_id": value.get("request_id"),
        "message_id": value.get("message_id"),
        "conversation_id": value.get("conversation_id"),
        "state_revision": value.get("state_revision"),
        "payload_sha256": (
            provenance.get("payload_sha256")
            if isinstance(provenance, Mapping)
            else None
        ),
        "actor_sha256": actor_sha256,
        "postcondition_evidence_sha256": evidence_sha256,
    }
    return _json_sha256(scope)


def _canonical_action_receipt(
    value: Any,
    *,
    terminal_only: bool = False,
    expected_conversation_id: Optional[str] = None,
    expected_request_id: Optional[str] = None,
    expected_message_id: Optional[str] = None,
    expected_state_revision: Optional[str] = None,
    expected_recording_fingerprint: Optional[str] = None,
    require_terminal_review_scope: bool = True,
) -> Optional[dict[str, Any]]:
    if not isinstance(value, Mapping) or not _exact_keys(
        value,
        _REQUIRED_FIELDS,
        _OPTIONAL_FIELDS,
    ):
        return None
    if value.get("contract_version") != "ieeg-agent.v1":
        return None
    if any(
        not _identifier(value.get(field))
        for field in ("receipt_id", "command_id", "command_type")
    ):
        return None
    if value.get("command_type") not in _catalog_command_types():
        return None
    for field in ("request_id", "conversation_id", "message_id", "state_revision"):
        if field in value and not _identifier(value.get(field)):
            return None
    for field in (
        "recording_fingerprint",
        "scope_sha256",
        "issuance_session_sha256",
        "issuance_resource_scope_sha256",
    ):
        if field in value and (
            not _sha256(value.get(field))
            or value.get(field) != str(value.get(field)).lower()
        ):
            return None
    if (
        value.get("status") not in _STATUSES
        or not isinstance(value.get("terminal"), bool)
        or not _date_time(value.get("occurred_at"))
        or value.get("effect") not in _EFFECTS
        or not isinstance(value.get("requires_confirmation"), bool)
        or not _non_empty_text(value.get("owner"))
        or not _non_empty_text(value.get("research_impact"))
        or not _valid_idempotency(value.get("idempotency"))
        or not _valid_retry(value.get("retry"))
        or not isinstance(value.get("timeout_seconds"), (int, float))
        or isinstance(value.get("timeout_seconds"), bool)
        or value["timeout_seconds"] <= 0
        or value.get("approval_role") not in {"none", "clinician"}
        or not isinstance(value.get("affected_resources"), list)
        or not value["affected_resources"]
        or any(not _non_empty_text(item) for item in value["affected_resources"])
        or len(set(value["affected_resources"])) != len(value["affected_resources"])
        or not _non_empty_text(value.get("postcondition_name"))
        or not _non_empty_text(value.get("data_sensitivity"))
        or not _valid_provenance(value.get("provenance"))
        or not _date_time(value.get("created_at"))
    ):
        return None
    if value.get("requires_confirmation") is True:
        if any(
            not _identifier(value.get(field))
            for field in ("request_id", "message_id", "conversation_id", "state_revision")
        ):
            return None
        if any(
            not _sha256(value.get(field))
            for field in ("issuance_session_sha256", "issuance_resource_scope_sha256")
        ):
            return None

    transitions = value.get("transitions")
    transition_count = value.get("transition_count")
    if (
        not isinstance(transitions, list)
        or not 1 <= len(transitions) <= 64
        or any(not _valid_transition(item) for item in transitions)
        or not isinstance(transition_count, int)
        or isinstance(transition_count, bool)
        or transition_count < len(transitions)
    ):
        return None
    sequences = [item["sequence"] for item in transitions]
    if sequences != sorted(set(sequences)) or transitions[-1].get("to") != value.get("status"):
        return None

    status = str(value["status"])
    effect = str(value["effect"])
    terminal = value["terminal"]
    if status in {"queued", "running"}:
        if terminal or "success" in value or "postcondition" in value:
            return None
    elif status == "applied":
        if effect not in {"view", "read"}:
            if terminal or "success" in value or "postcondition" in value:
                return None
        elif not terminal or value.get("success") is not True:
            return None
    elif status == "complete":
        if not terminal or value.get("success") is not True or "error" in value:
            return None
    elif status in _FAILURE_STATUSES:
        if not terminal or value.get("success") is not False or not _non_empty_text(value.get("reason")):
            return None
        if "postcondition" in value or (status == "failed" and not _valid_error(value.get("error"))):
            return None

    terminal_success = terminal and value.get("success") is True
    if terminal_success:
        result = value.get("result")
        postcondition = value.get("postcondition")
        observed = result.get("observed") if isinstance(result, Mapping) else None
        if (
            not isinstance(result, Mapping)
            or not result
            or not isinstance(observed, Mapping)
            or not observed
            or not _valid_postcondition(postcondition)
            or postcondition.get("name") != value.get("postcondition_name")
            or postcondition.get("state_revision") != value.get("state_revision")
            or dict(postcondition.get("evidence") or {}) != dict(observed)
        ):
            return None
    if status in {"applied", "running", "complete"}:
        if not _identifier(value.get("conversation_id")) or not _identifier(value.get("state_revision")):
            return None
    if status in {"applied", "running", "complete"} and effect in _WRITE_EFFECTS:
        actor = value.get("actor")
        if (
            value.get("approval_role") != "clinician"
            or not _valid_actor(actor)
            or actor.get("role") != "clinician"
        ):
            return None

    terminal_review = terminal and effect == "review_write"
    if terminal_review and require_terminal_review_scope:
        if any(
            not _identifier(value.get(field))
            for field in ("request_id", "message_id", "conversation_id", "state_revision")
        ):
            return None
        if not _sha256(value.get("recording_fingerprint")):
            return None
        expected_scope_sha256 = review_receipt_scope_sha256(value)
        if (
            expected_scope_sha256 is None
            or value.get("scope_sha256") != expected_scope_sha256
        ):
            return None
        for field, expected in (
            ("conversation_id", expected_conversation_id),
            ("request_id", expected_request_id),
            ("message_id", expected_message_id),
            ("state_revision", expected_state_revision),
            ("recording_fingerprint", expected_recording_fingerprint),
        ):
            if expected and value.get(field) != expected:
                return None

    if terminal_only:
        if (
            not terminal
            or status in {"queued", "running"}
            or (status == "applied" and effect not in {"view", "read"})
        ):
            return None
        if expected_conversation_id and value.get("conversation_id") != expected_conversation_id:
            return None
        if expected_request_id and value.get("request_id") not in {None, expected_request_id}:
            return None
        if expected_message_id and value.get("message_id") not in {None, expected_message_id}:
            return None
        if expected_state_revision and value.get("state_revision") != expected_state_revision:
            return None
        if (
            expected_recording_fingerprint
            and value.get("recording_fingerprint") not in {None, expected_recording_fingerprint}
        ):
            return None
    return dict(value)


def canonical_action_receipt(
    value: Any,
    *,
    terminal_only: bool = False,
    expected_conversation_id: Optional[str] = None,
    expected_request_id: Optional[str] = None,
    expected_message_id: Optional[str] = None,
    expected_state_revision: Optional[str] = None,
    expected_recording_fingerprint: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    """Validate and copy one canonical XLP-ACTION-RECEIPT-V1 object.

    This is the shared runtime/history trust boundary.  Terminal review-write
    receipts are canonical only when their exact recording and active-turn
    scope is present and its SHA-256 binding verifies.
    """

    return _canonical_action_receipt(
        value,
        terminal_only=terminal_only,
        expected_conversation_id=expected_conversation_id,
        expected_request_id=expected_request_id,
        expected_message_id=expected_message_id,
        expected_state_revision=expected_state_revision,
        expected_recording_fingerprint=expected_recording_fingerprint,
        require_terminal_review_scope=True,
    )


def bind_terminal_review_receipt_scope(
    value: Any,
    *,
    recording_fingerprint: str,
    request_id: str,
    message_id: str,
    conversation_id: str,
    state_revision: str,
) -> Optional[dict[str, Any]]:
    """Promote a trusted broker ACK into a turn-bound review receipt.

    Callers must first prove that ``command_id`` was freshly issued in the
    active turn.  Existing scope fields are conflict-checked, never overwritten.
    """

    candidate = dict(value) if isinstance(value, Mapping) else value
    if (
        isinstance(candidate, dict)
        and candidate.get("contract_version") == REVIEW_ACK_TRANSPORT_VERSION
    ):
        candidate["contract_version"] = "ieeg-agent.v1"
    raw = _canonical_action_receipt(
        candidate,
        require_terminal_review_scope=False,
    )
    if raw is None or raw.get("effect") != "review_write" or raw.get("terminal") is not True:
        return None
    expected_scope = {
        "recording_fingerprint": recording_fingerprint,
        "request_id": request_id,
        "message_id": message_id,
        "conversation_id": conversation_id,
        "state_revision": state_revision,
    }
    if (
        any(not _identifier(expected_scope[field]) for field in expected_scope if field != "recording_fingerprint")
        or not _sha256(recording_fingerprint)
        or recording_fingerprint != recording_fingerprint.lower()
    ):
        return None
    for field in _TERMINAL_REVIEW_SCOPE_FIELDS:
        observed = raw.get(field)
        if observed is not None and observed != expected_scope[field]:
            return None

    supplied_scope_sha256 = raw.get("scope_sha256")
    bound = dict(raw)
    bound.update(expected_scope)
    bound.pop("scope_sha256", None)
    scope_sha256 = review_receipt_scope_sha256(bound)
    if scope_sha256 is None:
        return None
    if supplied_scope_sha256 is not None and supplied_scope_sha256 != scope_sha256:
        return None
    bound["scope_sha256"] = scope_sha256
    return canonical_action_receipt(
        bound,
        expected_conversation_id=conversation_id,
        expected_request_id=request_id,
        expected_message_id=message_id,
        expected_state_revision=state_revision,
        expected_recording_fingerprint=recording_fingerprint,
    )


__all__ = [
    "bind_terminal_review_receipt_scope",
    "canonical_action_receipt",
    "REVIEW_ACK_TRANSPORT_VERSION",
    "review_receipt_scope_sha256",
]
