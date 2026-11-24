#!/usr/bin/env python3
"""Zero-dependency UI bus (broker) for the iEEG UI MCP connector.

The broker is the stable hand-off between an MCP client and the Electron renderer. Commands remain
ephemeral, because they can contain clinical identifiers. Compact receipts are persisted atomically so
command identity, idempotency, approval, state transitions, and terminal proof survive broker restarts.

Stdlib only -- this must not run inside the agent's Python environment.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import hmac
import json
import math
import os
import re
import tempfile
import threading
import uuid
from collections import OrderedDict
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

_CATALOG_PATH = Path(os.getenv("IEEG_UI_CATALOG") or (Path(__file__).resolve().parents[1] / "contracts" / "ui-command-catalog.json"))
WRITE_RISKS = frozenset({"compute", "artifact_write", "review_write", "destructive"})
CANONICAL_STATUSES = frozenset({"queued", "applied", "running", "complete", "failed", "rejected", "noop"})
FAILURE_STATUSES = frozenset({"failed", "rejected", "noop"})
SUCCESS_FLOW_STATUSES = frozenset({"applied", "running", "complete"})
STATUS_ALIASES = {
    "staged": "queued",
    "dismissed": "rejected",
    "unknown": "rejected",
    "error": "failed",
    "cancelled": "failed",
    "canceled": "failed",
    "success": "complete",
}
_ALLOWED_TRANSITIONS = {
    "queued": frozenset({"queued", "applied", "running", "complete", "failed", "rejected", "noop"}),
    "applied": frozenset({"applied", "running", "complete", "failed", "rejected", "noop"}),
    "running": frozenset({"running", "complete", "failed", "rejected", "noop"}),
    "complete": frozenset({"complete"}),
    "failed": frozenset({"failed"}),
    "rejected": frozenset({"rejected"}),
    "noop": frozenset({"noop"}),
}
_IDENTIFIER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
_SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
_AUTHORITY_SCOPE_FIELDS = frozenset({
    "request_id",
    "message_id",
    "conversation_id",
    "session_id",
    "state_revision",
    "recording_fingerprint",
    "resource_scope",
})
_RESOURCE_SCOPE_FIELDS = frozenset({
    "recording_id",
    "recording_sha256",
    "run_id",
    "event_id",
    "project_id",
    "state_revision",
})
_RESOURCE_SCOPE_IDENTIFIER_FIELDS = frozenset({
    "recording_id",
    "run_id",
    "event_id",
    "project_id",
    "state_revision",
})
REVIEW_ACK_TRANSPORT_VERSION = "ieeg-agent.review-ack.transport.v1"
_ACTOR_ROLES = frozenset({"researcher", "clinician", "reviewer", "administrator", "service"})
_REQUIRED_EFFECTIVE_CONTRACT_FIELDS = frozenset({
    "owner", "effect", "research_impact", "idempotency", "retry", "timeout_seconds",
    "approval_role", "affected_resources", "postcondition", "terminal_statuses",
    "failure_statuses", "terminal_proof", "data_sensitivity", "provenance_required",
})


class ReceiptPersistenceError(RuntimeError):
    """A configured durable receipt store could not commit the requested mutation."""


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _json_sha256(value: object) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _text_sha256(value: object) -> str:
    return hashlib.sha256(str(value).encode("utf-8")).hexdigest()


def _review_receipt_scope_sha256(receipt: dict) -> str | None:
    provenance = receipt.get("provenance")
    postcondition = receipt.get("postcondition")
    actor = receipt.get("actor")
    evidence = postcondition.get("evidence") if isinstance(postcondition, dict) else None
    scope = {
        "contract_version": receipt.get("contract_version"),
        "receipt_id": receipt.get("receipt_id"),
        "command_id": receipt.get("command_id"),
        "command_type": receipt.get("command_type"),
        "status": receipt.get("status"),
        "terminal": receipt.get("terminal"),
        "success": receipt.get("success"),
        "recording_fingerprint": receipt.get("recording_fingerprint"),
        "request_id": receipt.get("request_id"),
        "message_id": receipt.get("message_id"),
        "conversation_id": receipt.get("conversation_id"),
        "state_revision": receipt.get("state_revision"),
        "payload_sha256": (
            provenance.get("payload_sha256") if isinstance(provenance, dict) else None
        ),
        "actor_sha256": _json_sha256(actor) if actor is not None else None,
        "postcondition_evidence_sha256": (
            _json_sha256(evidence) if evidence is not None else None
        ),
    }
    required = (
        "recording_fingerprint",
        "request_id",
        "message_id",
        "conversation_id",
        "state_revision",
    )
    if any(not str(receipt.get(field) or "").strip() for field in required):
        return None
    return _json_sha256(scope)


def _canonical_status(value: object) -> str:
    raw = str(value or "").strip().lower()
    return STATUS_ALIASES.get(raw, raw)


def _resolve_catalog_document(data: dict) -> dict:
    """Resolve compact catalog profiles into one fail-closed effective contract per command."""
    if not isinstance(data, dict):
        raise ValueError("catalog root must be an object")
    if data.get("contract_profile_binding") != "risk":
        raise ValueError("catalog contract_profile_binding must be 'risk'")
    defaults = data.get("contract_defaults")
    profiles = data.get("contract_profiles")
    namespaces = data.get("namespace_contracts")
    commands = data.get("commands")
    if not all(isinstance(value, dict) for value in (defaults, profiles, namespaces)) or not isinstance(commands, list):
        raise ValueError("catalog contract sections are missing")

    resolved: dict[str, dict] = {}
    for entry in commands:
        if not isinstance(entry, dict) or not isinstance(entry.get("type"), str) or not entry["type"].strip():
            raise ValueError("every catalog command must have a non-empty type")
        command_type = entry["type"].strip()
        if command_type in resolved:
            raise ValueError(f"duplicate ui command type: {command_type}")
        risk = entry.get("risk")
        profile = profiles.get(risk)
        namespace = namespaces.get(command_type.split(".", 1)[0])
        if not isinstance(profile, dict):
            raise ValueError(f"unknown contract profile for {command_type}")
        if not isinstance(namespace, dict):
            raise ValueError(f"unknown command owner namespace for {command_type}")
        if risk in WRITE_RISKS and entry.get("requires_confirmation") is not True:
            raise ValueError(f"write command must require confirmation: {command_type}")

        contract = dict(defaults)
        contract.update(namespace)
        contract.update(profile)
        command_override = entry.get("contract")
        if command_override is not None:
            if not isinstance(command_override, dict):
                raise ValueError(f"command contract override must be an object: {command_type}")
            contract.update(command_override)
        # The command type is the exact effect identifier; the profile supplies its broader effect class.
        contract["effect_class"] = contract.get("effect")
        contract["effect"] = str(entry.get("effect") or command_type)
        missing = sorted(field for field in _REQUIRED_EFFECTIVE_CONTRACT_FIELDS if field not in contract)
        if missing:
            raise ValueError(f"incomplete contract for {command_type}: {', '.join(missing)}")
        if not isinstance(contract["idempotency"], dict) or not isinstance(contract["retry"], dict):
            raise ValueError(f"invalid idempotency/retry contract for {command_type}")
        if not isinstance(contract["timeout_seconds"], (int, float)) or contract["timeout_seconds"] <= 0:
            raise ValueError(f"invalid timeout contract for {command_type}")
        terminal = contract["terminal_statuses"]
        failures = contract["failure_statuses"]
        if not isinstance(terminal, list) or not set(terminal) <= CANONICAL_STATUSES:
            raise ValueError(f"invalid terminal statuses for {command_type}")
        if not isinstance(failures, list) or set(failures) != FAILURE_STATUSES:
            raise ValueError(f"invalid failure statuses for {command_type}")

        effective = dict(entry)
        effective.update(contract)
        effective["contract_profile"] = risk
        effective["catalog_version"] = str(data.get("version") or "")
        effective["contract_version"] = str(data.get("contract_version") or "")
        effective["contract"] = dict(contract)
        resolved[command_type] = effective
    return resolved


def load_catalog(path: Path = _CATALOG_PATH, *, strict: bool = False) -> dict:
    """Load and resolve the catalog; malformed catalogs fail closed to an empty allowlist."""
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        return _resolve_catalog_document(data)
    except Exception:
        if strict:
            raise
        return {}


def default_receipt_store_path() -> Path | None:
    configured = os.getenv("IEEG_UI_RECEIPT_STORE")
    if configured is not None:
        value = configured.strip()
        if value.lower() in {"", "0", "false", "off", "none", "disabled"}:
            return None
        return Path(value).expanduser()
    state_home = os.getenv("XDG_STATE_HOME")
    root = Path(state_home).expanduser() if state_home else (Path.home() / ".ieeg-agent")
    return root / "ui-command-receipts.json"


def _sanitize_evidence(value: object, *, key: str = "") -> object:
    """Keep receipt structure while hashing clinical identifiers and filesystem locations."""
    if isinstance(value, str) and value.startswith("sha256:"):
        return value
    lowered = key.lower().replace("-", "_")
    sensitive_key = any(token in lowered for token in ("patient", "subject", "recording", "event", "run_id", "channel", "path", "filename"))
    if sensitive_key and value not in (None, ""):
        return f"sha256:{_json_sha256(value)}"
    if isinstance(value, dict):
        return {str(k): _sanitize_evidence(v, key=str(k)) for k, v in value.items()}
    if isinstance(value, list):
        return [_sanitize_evidence(v, key=key) for v in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def _durable_receipt(receipt: dict) -> dict:
    """Remove free-text that could contain clinical identifiers before writing the audit file."""
    durable = json.loads(json.dumps(receipt, ensure_ascii=False, default=str))
    for field in ("reason", "detail", "label"):
        if durable.get(field) not in (None, ""):
            durable[field] = f"sha256:{_text_sha256(durable[field])}"
    for field in ("before", "after", "provenance"):
        if field in durable:
            durable[field] = _sanitize_evidence(durable[field], key=field)
    return durable


class UiBus:
    """Thread-safe UI command queue plus bounded, optionally durable command receipts."""

    _ACKS_MAX = 512
    _TRANSITIONS_MAX = 64

    def __init__(self, catalog: dict | None = None, receipt_store: str | Path | None = None) -> None:
        self._lock = threading.Lock()
        self.catalog = catalog if catalog is not None else load_catalog()
        self.ui_state: dict = {}
        self.pending: list[dict] = []
        self.acks: "OrderedDict[str, dict]" = OrderedDict()
        self.receipt_store = Path(receipt_store).expanduser() if receipt_store else None
        self._idempotency_index: dict[str, str] = {}
        self._loaded_receipt_ids: set[str] = set()
        self._issued_this_process: set[str] = set()
        # Raw command payloads stay only in bounded process memory. They let
        # terminal ACK proof bind to the exact event/run without persisting PHI.
        self._issued_payloads: dict[str, dict] = {}
        self._persistence_error: str | None = None
        self._load_receipts()

    def _load_receipts(self) -> None:
        if not self.receipt_store or not self.receipt_store.exists():
            return
        try:
            stored = json.loads(self.receipt_store.read_text(encoding="utf-8"))
            receipts = stored.get("receipts") if isinstance(stored, dict) else None
            if not isinstance(receipts, list):
                raise ValueError("receipt store has no receipts list")
            for receipt in receipts[-self._ACKS_MAX:]:
                if not isinstance(receipt, dict):
                    raise ValueError("receipt store contains a non-object receipt")
                command_id = str(receipt.get("command_id") or "").strip()
                command_type = str(receipt.get("command_type") or "").strip()
                status = str(receipt.get("status") or "").strip()
                required = {
                    "contract_version", "receipt_id", "command_id", "command_type", "status",
                    "terminal", "occurred_at", "effect", "provenance", "transitions",
                    "transition_count",
                }
                if (
                    not required <= set(receipt)
                    or (
                        receipt.get("contract_version") != "ieeg-agent.v1"
                        and not (
                            receipt.get("contract_version") == REVIEW_ACK_TRANSPORT_VERSION
                            and receipt.get("effect") == "review_write"
                            and receipt.get("terminal") is True
                        )
                    )
                    or not command_id
                    or command_type not in self.catalog
                    or status not in CANONICAL_STATUSES
                    or command_id in self.acks
                ):
                    raise ValueError("receipt store contains an incompatible receipt")
                self.acks[command_id] = dict(receipt)
            index = stored.get("idempotency_index") if isinstance(stored, dict) else None
            if isinstance(index, dict):
                self._idempotency_index = {
                    str(key): str(command_id) for key, command_id in index.items()
                    if isinstance(key, str) and str(command_id) in self.acks
                }
            self._loaded_receipt_ids = set(self.acks)
        except Exception as exc:
            self._persistence_error = type(exc).__name__

    def _persist_locked(self) -> None:
        if not self.receipt_store:
            return
        temp_name: str | None = None
        try:
            self.receipt_store.parent.mkdir(parents=True, exist_ok=True)
            payload = {
                "schema_version": 1,
                "updated_at": _utc_now(),
                "receipts": [_durable_receipt(receipt) for receipt in self.acks.values()],
                "idempotency_index": dict(self._idempotency_index),
            }
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", dir=self.receipt_store.parent,
                prefix=f".{self.receipt_store.name}.", suffix=".tmp", delete=False,
            ) as handle:
                temp_name = handle.name
                json.dump(payload, handle, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temp_name, 0o600)
            os.replace(temp_name, self.receipt_store)
            temp_name = None
            self._persistence_error = None
        except Exception as exc:
            self._persistence_error = type(exc).__name__
            raise ReceiptPersistenceError(self._persistence_error) from exc
        finally:
            if temp_name:
                try:
                    Path(temp_name).unlink(missing_ok=True)
                except Exception:
                    pass

    def _snapshot_locked(self) -> tuple:
        return (
            copy.deepcopy(self.pending),
            copy.deepcopy(self.acks),
            dict(self._idempotency_index),
            set(self._loaded_receipt_ids),
            set(self._issued_this_process),
            copy.deepcopy(self._issued_payloads),
        )

    def _restore_locked(self, snapshot: tuple) -> None:
        pending, acks, idempotency_index, loaded_ids, issued_ids, issued_payloads = snapshot
        self.pending = pending
        self.acks = acks
        self._idempotency_index = idempotency_index
        self._loaded_receipt_ids = loaded_ids
        self._issued_this_process = issued_ids
        self._issued_payloads = issued_payloads

    @staticmethod
    def _persistence_message(exc: ReceiptPersistenceError) -> str:
        return f"receipt persistence failed: {exc}"

    def _trim_locked(self) -> None:
        while len(self.acks) > self._ACKS_MAX:
            command_id, _ = self.acks.popitem(last=False)
            self._loaded_receipt_ids.discard(command_id)
            self._issued_this_process.discard(command_id)
            self._issued_payloads.pop(command_id, None)
            self._idempotency_index = {
                key: target for key, target in self._idempotency_index.items() if target != command_id
            }

    def set_state(self, state: dict) -> None:
        with self._lock:
            self.ui_state = dict(state or {})

    def get_state(self) -> dict:
        with self._lock:
            return dict(self.ui_state)

    def health(self) -> dict:
        with self._lock:
            return {
                "pending": len(self.pending),
                "has_state": bool(self.ui_state),
                "receipts": len(self.acks),
                "durable_receipts": bool(self.receipt_store),
                "persistence_error": self._persistence_error,
            }

    def validate(self, command_type: str, payload: dict | None) -> tuple[bool, str | None, bool]:
        spec = self.catalog.get(command_type)
        if not spec:
            return False, f"unknown ui command type: {command_type!r} (not in catalog)", False
        if payload is not None and not isinstance(payload, dict):
            return False, f"payload must be a JSON object, got {type(payload).__name__}", False
        for key in spec.get("required_payload") or []:
            value = (payload if isinstance(payload, dict) else {}).get(key)
            if value is None or (isinstance(value, str) and not value.strip()):
                return False, f"missing required payload field: {key!r}", False
        needs_confirm = bool(spec.get("requires_confirmation")) or spec.get("risk") in WRITE_RISKS
        return True, None, needs_confirm

    @staticmethod
    def _validated_identifier(value: object, field: str) -> tuple[str | None, str | None]:
        text = str(value or "").strip()
        if not text:
            return None, None
        if not _IDENTIFIER_RE.fullmatch(text):
            return None, f"authority_scope.{field} is invalid"
        return text, None

    def _normalize_authority_scope_locked(
        self,
        raw_scope: object,
        *,
        command_type: str,
        required: bool,
    ) -> tuple[dict | None, str | None]:
        """Validate and bind caller authority to the broker's current renderer state.

        Request/message/conversation identity comes only from the runtime turn.  Workspace
        session and revision may be supplied by that runtime or filled from the broker's trusted
        renderer snapshot, but any two supplied sources must agree.  Confirmation-gated writes
        fail closed unless the resulting scope is complete.
        """
        if raw_scope is None:
            supplied: dict = {}
        elif isinstance(raw_scope, dict):
            supplied = dict(raw_scope)
        else:
            return None, "authority_scope must be a JSON object"
        unknown = sorted(set(supplied) - _AUTHORITY_SCOPE_FIELDS)
        if unknown:
            return None, f"authority_scope contains unsupported fields: {', '.join(unknown)}"

        normalized: dict = {}
        for field in ("request_id", "message_id", "conversation_id", "session_id", "state_revision"):
            value, error = self._validated_identifier(supplied.get(field), field)
            if error:
                return None, error
            if value:
                normalized[field] = value

        raw_resource = supplied.get("resource_scope")
        if raw_resource is None:
            resource_scope: dict = {}
        elif isinstance(raw_resource, dict):
            resource_scope = dict(raw_resource)
        else:
            return None, "authority_scope.resource_scope must be a JSON object"
        unknown_resource = sorted(set(resource_scope) - _RESOURCE_SCOPE_FIELDS)
        if unknown_resource:
            return None, (
                "authority_scope.resource_scope contains unsupported fields: "
                + ", ".join(unknown_resource)
            )
        for field in _RESOURCE_SCOPE_IDENTIFIER_FIELDS:
            if field not in resource_scope:
                continue
            value, error = self._validated_identifier(
                resource_scope.get(field), f"resource_scope.{field}",
            )
            if error:
                return None, error
            if value:
                resource_scope[field] = value
            else:
                resource_scope.pop(field, None)

        resource_fingerprint = str(resource_scope.get("recording_sha256") or "").strip().lower()
        if resource_fingerprint and not _SHA256_RE.fullmatch(resource_fingerprint):
            return None, "authority_scope.resource_scope.recording_sha256 is invalid"
        if resource_fingerprint:
            resource_scope["recording_sha256"] = resource_fingerprint
        else:
            resource_scope.pop("recording_sha256", None)
        supplied_fingerprint = str(supplied.get("recording_fingerprint") or "").strip().lower()
        if supplied_fingerprint and not _SHA256_RE.fullmatch(supplied_fingerprint):
            return None, "authority_scope.recording_fingerprint is invalid"
        if supplied_fingerprint and resource_fingerprint and supplied_fingerprint != resource_fingerprint:
            return None, "authority_scope recording fingerprint conflicts with resource_scope"
        recording_fingerprint = supplied_fingerprint or resource_fingerprint
        if recording_fingerprint:
            resource_scope["recording_sha256"] = recording_fingerprint
            normalized["recording_fingerprint"] = recording_fingerprint
        recording_bound_write = (
            required
            and (self.catalog.get(command_type) or {}).get("requires_recording") is True
        )

        top_revision = normalized.get("state_revision")
        resource_revision = str(resource_scope.get("state_revision") or "").strip() or None
        if top_revision and resource_revision and top_revision != resource_revision:
            return None, "authority_scope state_revision conflicts with resource_scope"
        effective_revision = top_revision or resource_revision

        current_session_raw = str(self.ui_state.get("session_id") or "").strip()
        current_session, current_session_error = self._validated_identifier(
            current_session_raw, "current_ui.session_id",
        )
        if current_session_error:
            if required or normalized.get("session_id"):
                return None, "current UI session_id is invalid; refresh the workspace scope"
            current_session = None
        submitted_session = normalized.get("session_id")
        if submitted_session and current_session and submitted_session != current_session:
            return None, "authority_scope.session_id does not match current UI state"
        if not submitted_session and current_session:
            normalized["session_id"] = current_session

        current_resource = self.ui_state.get("resource_scope")
        current_recording_fingerprint = (
            str(current_resource.get("recording_sha256") or "").strip().lower()
            if isinstance(current_resource, dict)
            else ""
        )
        if current_recording_fingerprint and not _SHA256_RE.fullmatch(current_recording_fingerprint):
            if required or recording_fingerprint:
                return None, "current UI recording fingerprint is invalid; refresh the workspace scope"
            current_recording_fingerprint = ""
        if recording_bound_write and recording_fingerprint and not current_recording_fingerprint:
            return None, "current UI recording fingerprint is missing; refresh the workspace scope"
        if (
            recording_fingerprint
            and current_recording_fingerprint
            and recording_fingerprint != current_recording_fingerprint
        ):
            return None, "authority_scope recording fingerprint does not match current UI state"
        current_resource_revision = (
            str(current_resource.get("state_revision") or "").strip()
            if isinstance(current_resource, dict)
            else ""
        )
        current_top_revision = str(self.ui_state.get("state_revision") or "").strip()
        if (
            current_resource_revision
            and current_top_revision
            and current_resource_revision != current_top_revision
        ):
            if required or effective_revision:
                return None, "current UI state_revision conflicts with resource_scope"
            current_resource_revision = ""
        current_revision_raw = current_resource_revision or current_top_revision
        current_revision, current_revision_error = self._validated_identifier(
            current_revision_raw, "current_ui.state_revision",
        )
        if current_revision_error:
            if required or effective_revision:
                return None, "current UI state_revision is invalid; refresh the workspace scope"
            current_revision = None
        if effective_revision and current_revision and effective_revision != current_revision:
            return None, "authority_scope.state_revision does not match current UI state"
        effective_revision = effective_revision or current_revision
        if effective_revision:
            normalized["state_revision"] = effective_revision
            resource_scope["state_revision"] = effective_revision

        if resource_scope.get("run_id") and not resource_scope.get("recording_id"):
            return None, "authority_scope.resource_scope.run_id requires recording_id"
        if resource_scope.get("event_id") and (
            not resource_scope.get("run_id") or not resource_scope.get("recording_id")
        ):
            return None, "authority_scope.resource_scope.event_id requires run_id and recording_id"

        if resource_scope:
            normalized["resource_scope"] = resource_scope

        if required:
            missing = [
                field for field in (
                    "request_id", "message_id", "conversation_id", "session_id", "state_revision",
                )
                if not normalized.get(field)
            ]
            if missing:
                return None, "write command authority_scope is missing: " + ", ".join(missing)
        if recording_bound_write and not recording_fingerprint:
            return None, f"{command_type} authority_scope requires recording_fingerprint"
        return normalized, None

    @staticmethod
    def _command_scope_fields(scope: dict) -> dict:
        command_scope = {
            field: scope[field]
            for field in ("request_id", "message_id", "conversation_id", "session_id", "state_revision")
            if scope.get(field)
        }
        resource_scope = scope.get("resource_scope")
        if isinstance(resource_scope, dict) and resource_scope:
            command_scope["resource_scope"] = copy.deepcopy(resource_scope)
        return command_scope

    @staticmethod
    def _command_contract(spec: dict) -> dict:
        return {
            "version": spec.get("contract_version"),
            "profile": spec.get("contract_profile"),
            "owner": spec.get("owner"),
            "effect": spec.get("effect"),
            "effect_class": spec.get("effect_class"),
            "research_impact": spec.get("research_impact"),
            "idempotency": spec.get("idempotency"),
            "retry": spec.get("retry"),
            "timeout_seconds": spec.get("timeout_seconds"),
            "approval_role": spec.get("approval_role"),
            "affected_resources": spec.get("affected_resources"),
            "postcondition": spec.get("postcondition"),
            "data_sensitivity": spec.get("data_sensitivity"),
        }

    def _new_receipt(
        self, command_id: str, command_type: str, spec: dict, payload_sha256: str,
        needs_confirm: bool, idempotency_key_sha256: str | None, authority_scope: dict,
    ) -> dict:
        now = _utc_now()
        idempotency = {
            **dict(spec.get("idempotency") or {
                "mode": "idempotent",
                "key_scope": "command_type_and_payload",
            }),
            "key_supplied": bool(idempotency_key_sha256),
        }
        if idempotency_key_sha256:
            idempotency["key_sha256"] = idempotency_key_sha256
        receipt = {
            "contract_version": str(spec.get("contract_version") or "ieeg-agent.v1"),
            "receipt_id": f"receipt-{uuid.uuid4().hex}",
            "command_id": command_id,
            "command_type": command_type,
            "status": "queued",
            "terminal": False,
            "occurred_at": now,
            "effect": str(spec.get("risk") or spec.get("contract_profile") or "view"),
            "requires_confirmation": needs_confirm,
            "owner": str(spec.get("owner") or "desktop.unspecified"),
            "research_impact": str(spec.get("research_impact") or "unknown"),
            "idempotency": idempotency,
            "retry": dict(spec.get("retry") or {"mode": "safe", "max_attempts": 1, "backoff_ms": 0}),
            "timeout_seconds": float(spec.get("timeout_seconds") or 1),
            "approval_role": str(spec.get("approval_role") or "none"),
            "affected_resources": list(spec.get("affected_resources") or []),
            "postcondition_name": str(spec.get("postcondition") or "renderer_ack_observed"),
            "data_sensitivity": str(spec.get("data_sensitivity") or "unknown"),
            "provenance": {
                "source": "mcp",
                "payload_sha256": payload_sha256,
                "command_effect": str(spec.get("effect") or command_type),
                "effect_class": str(spec.get("effect_class") or spec.get("risk") or "view"),
            },
            "transitions": [{
                "sequence": 0,
                "from": None,
                "to": "queued",
                "observed_at": now,
                "source": "broker_emit",
            }],
            "transition_count": 1,
            "created_at": now,
        }
        for field in ("request_id", "message_id", "conversation_id", "state_revision"):
            if authority_scope.get(field):
                receipt[field] = authority_scope[field]
        recording_fingerprint = str(authority_scope.get("recording_fingerprint") or "").strip()
        if recording_fingerprint:
            receipt["recording_fingerprint"] = recording_fingerprint
        initial_transition = receipt["transitions"][0]
        if authority_scope.get("state_revision"):
            initial_transition["state_revision"] = authority_scope["state_revision"]
        if authority_scope.get("conversation_id"):
            initial_transition["conversation_id"] = authority_scope["conversation_id"]
        if authority_scope.get("session_id"):
            session_sha256 = _text_sha256(authority_scope["session_id"])
            receipt["issuance_session_sha256"] = session_sha256
            initial_transition["session_id_sha256"] = session_sha256
        resource_scope = authority_scope.get("resource_scope")
        if isinstance(resource_scope, dict) and resource_scope:
            # Freeze the complete canonical resource scope without persisting raw resource IDs.
            # Keep it top-level across transition trimming and mirror it in the issuance event.
            resource_scope_sha256 = _json_sha256(resource_scope)
            receipt["issuance_resource_scope_sha256"] = resource_scope_sha256
            initial_transition["evidence_sha256"] = resource_scope_sha256
        return receipt

    def emit(
        self, command_type: str, payload: dict | None, reason: str | None,
        idempotency_key: str | None = None, authority_scope: dict | None = None,
    ) -> tuple[dict | None, str | None]:
        ok, why, needs_confirm = self.validate(command_type, payload)
        if not ok:
            return None, why
        spec = self.catalog[command_type]
        body = payload or {}
        payload_sha256 = _json_sha256(body)
        key = str(idempotency_key or "").strip()
        key_sha256 = _text_sha256(key) if key else None
        with self._lock:
            issuance_scope, scope_error = self._normalize_authority_scope_locked(
                authority_scope,
                command_type=command_type,
                required=needs_confirm,
            )
            if scope_error:
                return None, scope_error
            issuance_scope = issuance_scope or {}
            if self.receipt_store and self._persistence_error:
                return None, f"receipt persistence unavailable: {self._persistence_error}"
            if key_sha256 and key_sha256 in self._idempotency_index:
                command_id = self._idempotency_index[key_sha256]
                existing = self.acks.get(command_id)
                if not existing:
                    return None, "idempotency receipt is unavailable; use a new idempotency key"
                existing_payload_hash = (existing.get("provenance") or {}).get("payload_sha256")
                if existing.get("command_type") != command_type or existing_payload_hash != payload_sha256:
                    return None, "idempotency key was already used for a different command effect"
                existing_scope = {
                    field: existing.get(field)
                    for field in ("request_id", "message_id", "conversation_id", "state_revision")
                    if existing.get(field)
                }
                existing_fingerprint = str(existing.get("recording_fingerprint") or "").strip()
                if existing_fingerprint:
                    existing_scope["recording_fingerprint"] = existing_fingerprint
                transitions = existing.get("transitions")
                initial = transitions[0] if isinstance(transitions, list) and transitions else None
                existing_session_sha256 = (
                    str(existing.get("issuance_session_sha256") or "").strip()
                    or (
                        str(initial.get("session_id_sha256") or "").strip()
                        if isinstance(initial, dict)
                        else ""
                    )
                )
                requested_session_sha256 = (
                    _text_sha256(issuance_scope["session_id"])
                    if issuance_scope.get("session_id")
                    else ""
                )
                existing_resource_scope_sha256 = (
                    str(existing.get("issuance_resource_scope_sha256") or "").strip()
                    or (
                        str(initial.get("evidence_sha256") or "").strip()
                        if isinstance(initial, dict)
                        else ""
                    )
                )
                requested_resource_scope = issuance_scope.get("resource_scope")
                requested_resource_scope_sha256 = (
                    _json_sha256(requested_resource_scope)
                    if isinstance(requested_resource_scope, dict) and requested_resource_scope
                    else ""
                )
                for field in ("request_id", "message_id", "conversation_id", "state_revision", "recording_fingerprint"):
                    if str(existing_scope.get(field) or "") != str(issuance_scope.get(field) or ""):
                        return None, "idempotency key was already used for a different command authority scope"
                if existing_session_sha256 != requested_session_sha256:
                    return None, "idempotency key was already used for a different command authority scope"
                if existing_resource_scope_sha256 != requested_resource_scope_sha256:
                    return None, "idempotency key was already used for a different command authority scope"
                command = {
                    "contract_version": str(spec.get("contract_version") or "ieeg-agent.v1"),
                    "command_id": command_id,
                    "type": command_type,
                    "payload": body,
                    "reason": reason or command_type,
                    "requires_confirmation": needs_confirm,
                    "source": "mcp",
                    "created_at": existing.get("created_at"),
                    "deduplicated": True,
                    "contract": self._command_contract(spec),
                    **self._command_scope_fields(issuance_scope),
                }
                self._issued_payloads[command_id] = copy.deepcopy(body)
                retry_mode = str((spec.get("retry") or {}).get("mode") or "")
                if (
                    command_id in self._loaded_receipt_ids
                    and command_id not in self._issued_this_process
                    and existing.get("status") == "queued"
                    and retry_mode != "never"
                ):
                    snapshot = self._snapshot_locked()
                    command["recovered_after_restart"] = True
                    self.pending.append(command)
                    self._issued_this_process.add(command_id)
                    try:
                        self._persist_locked()
                    except ReceiptPersistenceError as exc:
                        self._restore_locked(snapshot)
                        return None, self._persistence_message(exc)
                return command, None

            command_id = f"mcp-{uuid.uuid4().hex}"
            command = {
                "contract_version": str(spec.get("contract_version") or "ieeg-agent.v1"),
                "command_id": command_id,
                "type": command_type,
                "payload": body,
                "reason": reason or command_type,
                "requires_confirmation": needs_confirm,
                "source": "mcp",
                "created_at": _utc_now(),
                "contract": self._command_contract(spec),
                **self._command_scope_fields(issuance_scope),
            }
            receipt = self._new_receipt(
                command_id,
                command_type,
                spec,
                payload_sha256,
                needs_confirm,
                key_sha256,
                issuance_scope,
            )
            snapshot = self._snapshot_locked()
            self.pending.append(command)
            self.acks[command_id] = receipt
            self._issued_this_process.add(command_id)
            self._issued_payloads[command_id] = copy.deepcopy(body)
            if key_sha256:
                self._idempotency_index[key_sha256] = command_id
            self._trim_locked()
            try:
                self._persist_locked()
            except ReceiptPersistenceError as exc:
                self._restore_locked(snapshot)
                return None, self._persistence_message(exc)
        return command, None

    def drain(self) -> list[dict]:
        with self._lock:
            out, self.pending = self.pending, []
            return out

    @staticmethod
    def _identifier(value: object, field: str, *, required: bool = False) -> tuple[str | None, str | None]:
        text = str(value or "").strip()
        if not text:
            return (None, f"{field} is required") if required else (None, None)
        if not _IDENTIFIER_RE.fullmatch(text):
            return None, f"{field} is invalid"
        return text, None

    @staticmethod
    def _approval_actor(
        outcome: dict, required_role: str, status: str, existing_actor: dict | None,
    ) -> tuple[dict | None, str | None]:
        raw = outcome.get("approval_actor", outcome.get("actor"))
        requires_actor = required_role not in {"", "none"} and status in SUCCESS_FLOW_STATUSES
        if raw is None:
            if requires_actor:
                return None, "approval_actor is required for a write success transition"
            return existing_actor, None
        if not isinstance(raw, dict):
            return None, "approval_actor must be an object"

        role = str(raw.get("role") or "").strip().lower()
        actor_id = str(raw.get("actor_id") or raw.get("id") or "").strip()
        session_id = str(raw.get("session_id") or "").strip()
        source = str(raw.get("source") or "").strip()
        if role not in _ACTOR_ROLES:
            return None, "approval_actor.role is invalid"
        if requires_actor and role != required_role:
            return None, f"approval role {required_role!r} is required for this transition"
        if not actor_id:
            return None, "approval_actor.actor_id is required"
        if not session_id:
            return None, "approval_actor.session_id is required"
        if not source:
            return None, "approval_actor.source is required"
        normalized = {
            "role": role,
            "actor_id_sha256": _text_sha256(actor_id),
            "session_id_sha256": _text_sha256(session_id),
            "source": source,
        }
        if existing_actor is not None and normalized != existing_actor:
            return None, "approval actor/session binding does not match the existing receipt"
        return normalized, None

    @staticmethod
    def _receipt_terminal(spec: dict, status: str) -> bool:
        return status in FAILURE_STATUSES or status in set(spec.get("terminal_statuses") or [])

    @staticmethod
    def _observed_evidence(outcome: dict) -> dict:
        evidence: dict = {}
        supplied = outcome.get("terminal_proof")
        if isinstance(supplied, dict) and supplied:
            proof_evidence = {key: value for key, value in supplied.items() if key != "source"}
            if proof_evidence:
                evidence["terminal_proof"] = _sanitize_evidence(proof_evidence, key="terminal_proof")
        for field in ("before", "after", "provenance"):
            value = outcome.get(field)
            if isinstance(value, dict) and value:
                evidence[field] = _sanitize_evidence(value, key=field)
        diff_state = str(outcome.get("diff_state") or "").strip()
        if diff_state and diff_state.lower().replace("-", "_") not in {
            "unchanged", "no_change", "none", "same", "equal",
        }:
            evidence["diff_state"] = diff_state
        if str(outcome.get("operation_id") or "").strip():
            evidence["operation_id_sha256"] = _text_sha256(outcome["operation_id"])
        if str(outcome.get("finished_at") or "").strip() and str(outcome.get("detail") or "").strip():
            evidence["finished_at"] = str(outcome["finished_at"]).strip()
            evidence["detail_sha256"] = _text_sha256(outcome["detail"])
        return evidence

    @staticmethod
    def _review_terminal_proof_error(
        command_type: str,
        issued_payload: dict | None,
        outcome: dict,
    ) -> str | None:
        proof = outcome.get("terminal_proof")
        if not isinstance(issued_payload, dict) or not isinstance(proof, dict):
            return "terminal review success requires command-bound observed postcondition evidence"

        source = str(proof.get("source") or "").strip()
        if command_type in {"events.stage_annotation", "events.clear_staged_annotation"}:
            event_id = str(issued_payload.get("event_id") or "").strip()
            run_id = str(proof.get("run_id") or "").strip()
            if (
                source != "backend_readback"
                or not event_id
                or not run_id
                or str(proof.get("event_id") or "").strip() != event_id
                or str(proof.get("backend_status") or "").strip() != "complete"
            ):
                return "terminal review success requires command-bound observed postcondition evidence"

            if command_type == "events.stage_annotation":
                requested_label = str(issued_payload.get("label") or "").strip()
                proof_requested_label = str(proof.get("requested_annotation_label") or "").strip()
                expected_label = str(proof.get("expected_annotation_label") or "").strip()
                observed_label = str(proof.get("observed_annotation_label") or "").strip()
                if (
                    not requested_label
                    or proof_requested_label != requested_label
                    or not expected_label
                    or observed_label != expected_label
                    or proof.get("annotation_present") is not True
                    or proof.get("annotation_cleared") is not False
                ):
                    return "terminal review success requires command-bound observed postcondition evidence"
            elif (
                proof.get("annotation_cleared") is not True
                or proof.get("annotation_present") is not False
                or proof.get("observed_annotation_label") not in {None, ""}
            ):
                return "terminal review success requires command-bound observed postcondition evidence"
            return None

        if command_type == "review.accept_run":
            run_id = str(issued_payload.get("run_id") or "").strip()
            if (
                source != "renderer_state_transition"
                or not run_id
                or str(proof.get("accepted_run_id") or "").strip() != run_id
                or proof.get("accepted_flag") is not True
            ):
                return "terminal review success requires command-bound observed postcondition evidence"
            return None

        return "terminal review success requires command-bound observed postcondition evidence"

    @staticmethod
    def _severity_terminal_proof_error(
        issuance_recording_fingerprint: str | None,
        outcome: dict,
    ) -> str | None:
        proof = outcome.get("terminal_proof")
        if not isinstance(proof, dict):
            return "terminal severity success requires backend result and model provenance"
        summary = proof.get("severity_summary")
        required_digests = (
            "recording_fingerprint", "model_sha256", "parameters_sha256", "result_sha256",
        )
        proof_fingerprint = str(proof.get("recording_fingerprint") or "").strip()
        outcome_fingerprint = str(outcome.get("recording_fingerprint") or "").strip()
        issued_fingerprint = str(issuance_recording_fingerprint or "").strip()
        num_segments = summary.get("num_segments") if isinstance(summary, dict) else None
        num_clean_segments = summary.get("num_clean_segments") if isinstance(summary, dict) else None
        artifact_quality = summary.get("artifact_quality") if isinstance(summary, dict) else None

        def valid_score(field: str, *, required: bool) -> bool:
            value = summary.get(field) if isinstance(summary, dict) else None
            if value is None:
                return not required
            return (
                isinstance(value, (int, float))
                and not isinstance(value, bool)
                and math.isfinite(float(value))
                and 0.0 <= float(value) <= 5.0
            )

        def valid_time(field: str, *, required: bool) -> bool:
            value = summary.get(field) if isinstance(summary, dict) else None
            if value is None:
                return not required
            return (
                isinstance(value, (int, float))
                and not isinstance(value, bool)
                and math.isfinite(float(value))
                and float(value) >= 0.0
            )

        scores_are_valid = (
            valid_score("mean_score", required=True)
            and valid_score("peak_score", required=True)
            and valid_time("peak_time_sec", required=True)
            and valid_score("clean_mean_score", required=isinstance(num_clean_segments, int) and num_clean_segments > 0)
            and valid_score("clean_peak_score", required=isinstance(num_clean_segments, int) and num_clean_segments > 0)
            and valid_time("clean_peak_time_sec", required=isinstance(num_clean_segments, int) and num_clean_segments > 0)
        )

        clean_values = (
            summary.get("clean_mean_score") if isinstance(summary, dict) else None,
            summary.get("clean_peak_score") if isinstance(summary, dict) else None,
            summary.get("clean_peak_time_sec") if isinstance(summary, dict) else None,
        )
        artifact_quality_is_valid = False
        if artifact_quality is None:
            # Missing/unknown artifact screening must not promote any segment as clean.
            artifact_quality_is_valid = num_clean_segments == 0 and all(
                value is None for value in clean_values
            )
        elif isinstance(artifact_quality, dict):
            quality_status = str(artifact_quality.get("status") or "").strip()
            assessed_segments = artifact_quality.get("assessed_segments")
            quality_total = artifact_quality.get("total_segments")
            channel_count = artifact_quality.get("channel_count")
            threshold_uv = artifact_quality.get("threshold_uv")
            common_quality_valid = (
                isinstance(num_segments, int)
                and not isinstance(num_segments, bool)
                and num_segments > 0
                and str(artifact_quality.get("method") or "").strip()
                == "tueg19_peak_amplitude"
                and isinstance(assessed_segments, int)
                and not isinstance(assessed_segments, bool)
                and 0 <= assessed_segments <= num_segments
                and isinstance(quality_total, int)
                and not isinstance(quality_total, bool)
                and quality_total == num_segments
                and isinstance(channel_count, int)
                and not isinstance(channel_count, bool)
                and channel_count >= 0
                and isinstance(threshold_uv, (int, float))
                and not isinstance(threshold_uv, bool)
                and math.isfinite(float(threshold_uv))
                and float(threshold_uv) > 0.0
            )
            if quality_status == "assessed":
                artifact_quality_is_valid = (
                    common_quality_valid
                    and assessed_segments == num_segments
                    and (
                        (
                            isinstance(num_clean_segments, int)
                            and not isinstance(num_clean_segments, bool)
                            and num_clean_segments > 0
                        )
                        or (
                            num_clean_segments == 0
                            and all(value is None for value in clean_values)
                        )
                    )
                )
            elif quality_status == "partial":
                artifact_quality_is_valid = (
                    common_quality_valid
                    and 0 < assessed_segments < num_segments
                    and num_clean_segments == 0
                    and all(value is None for value in clean_values)
                )
            elif quality_status == "unavailable":
                artifact_quality_is_valid = (
                    common_quality_valid
                    and assessed_segments == 0
                    and num_clean_segments == 0
                    and all(value is None for value in clean_values)
                )
        if (
            str(proof.get("source") or "").strip() != "backend_readback"
            or str(proof.get("backend_status") or "").strip() != "complete"
            or str(proof.get("model_name") or "").strip() != "BASED"
            or not str(proof.get("model_version") or "").strip()
            or any(not _SHA256_RE.fullmatch(str(proof.get(field) or "").strip()) for field in required_digests)
            or not isinstance(summary, dict)
            or str(summary.get("eeg_type") or "").strip().lower() != "scalp"
            or not isinstance(num_segments, int)
            or isinstance(num_segments, bool)
            or num_segments <= 0
            or not isinstance(num_clean_segments, int)
            or isinstance(num_clean_segments, bool)
            or num_clean_segments < 0
            or num_clean_segments > num_segments
            or not scores_are_valid
            or not artifact_quality_is_valid
            or not outcome_fingerprint
            or proof_fingerprint != outcome_fingerprint
            or not issued_fingerprint
            or proof_fingerprint != issued_fingerprint
        ):
            return "terminal severity success requires backend result and model provenance"
        return None

    @staticmethod
    def _compute_terminal_proof_error(
        command_type: str,
        issuance_recording_fingerprint: str | None,
        outcome: dict,
    ) -> str | None:
        """Require backend-observed compute evidence, with stronger per-command proofs.

        Renderer lifecycle text, timestamps, and operation IDs prove only that the renderer
        finished waiting.  They are not evidence that a clinical compute result exists.
        """
        proof = outcome.get("terminal_proof")
        error = f"terminal {command_type} success requires backend result and provenance"
        if not isinstance(proof, dict):
            return error
        if (
            str(proof.get("source") or "").strip() != "backend_readback"
            or str(proof.get("backend_status") or "").strip() != "complete"
            or not _SHA256_RE.fullmatch(str(proof.get("result_sha256") or "").strip())
        ):
            return error

        issued_fingerprint = str(issuance_recording_fingerprint or "").strip()
        proof_fingerprint = str(proof.get("recording_fingerprint") or "").strip()
        outcome_fingerprint = str(outcome.get("recording_fingerprint") or "").strip()
        if issued_fingerprint and (
            not _SHA256_RE.fullmatch(proof_fingerprint)
            or proof_fingerprint != issued_fingerprint
            or outcome_fingerprint != issued_fingerprint
        ):
            return error

        if command_type == "analysis.prepare_recording":
            if (
                str(proof.get("input_recording_fingerprint") or "").strip()
                != issued_fingerprint
                or not _SHA256_RE.fullmatch(
                    str(proof.get("output_recording_fingerprint") or "").strip()
                )
                or not _SHA256_RE.fullmatch(str(proof.get("parameters_sha256") or "").strip())
                or not _SHA256_RE.fullmatch(str(proof.get("output_path_sha256") or "").strip())
            ):
                return error
            return None

        if command_type == "detection.run":
            run_id = str(proof.get("run_id") or "").strip()
            num_events = proof.get("num_events")
            num_channels = proof.get("num_channels")
            if (
                not _IDENTIFIER_RE.fullmatch(run_id)
                or not _SHA256_RE.fullmatch(str(proof.get("parameters_sha256") or "").strip())
                or not str(proof.get("biomarker") or "").strip()
                or not str(proof.get("detector") or "").strip()
                or not _SHA256_RE.fullmatch(str(proof.get("artifacts_sha256") or "").strip())
                or not _SHA256_RE.fullmatch(str(proof.get("output_dir_sha256") or "").strip())
                or not isinstance(num_events, int)
                or isinstance(num_events, bool)
                or num_events < 0
                or not isinstance(num_channels, int)
                or isinstance(num_channels, bool)
                or num_channels < 0
            ):
                return error
            return None

        # Other compute commands still need a durable result read-back. Recording-bound
        # commands are already tied above; run-producing commands also name that run.
        if command_type in {"classification.run", "detection.create_consensus_run"}:
            run_id = str(proof.get("run_id") or "").strip()
            if not _IDENTIFIER_RE.fullmatch(run_id):
                return error
        return None

    @staticmethod
    def _artifact_terminal_proof_error(command_type: str, outcome: dict) -> str | None:
        proof = outcome.get("terminal_proof")
        error = f"terminal {command_type} success requires artifact existence readback and digests"
        if not isinstance(proof, dict):
            return error
        if (
            str(proof.get("source") or "").strip() != "backend_readback"
            or str(proof.get("backend_status") or "").strip() != "complete"
            or proof.get("artifact_exists") is not True
            or not _SHA256_RE.fullmatch(str(proof.get("artifact_sha256") or "").strip())
            or not _SHA256_RE.fullmatch(str(proof.get("result_sha256") or "").strip())
        ):
            return error
        return None

    @staticmethod
    def _failure_reason(status: str) -> str:
        return {
            "failed": "Action execution failed.",
            "rejected": "Action was rejected.",
            "noop": "Action produced no observable effect.",
        }[status]

    @staticmethod
    def _failure_result(outcome: dict) -> dict:
        result: dict = {}
        for field in ("reason", "detail", "label"):
            value = str(outcome.get(field) or "").strip()
            if value:
                result[f"reported_{field}_sha256"] = _text_sha256(value)
        return result

    @staticmethod
    def _receipt_error(outcome: dict) -> dict:
        raw = outcome.get("error") if isinstance(outcome.get("error"), dict) else {}
        allowed_codes = {
            "validation_failed", "scope_missing", "scope_conflict", "permission_denied",
            "approval_missing", "stale_state", "resource_not_found", "backend_busy",
            "timeout", "execution_failed", "cancelled", "internal_error",
        }
        code = str(raw.get("code") or "execution_failed")
        if code not in allowed_codes:
            code = "execution_failed"
        safe_details = UiBus._failure_result(outcome)
        if isinstance(raw.get("safe_details"), dict):
            safe_details.update(_sanitize_evidence(raw["safe_details"], key="safe_details"))
        result = {
            "code": code,
            "message": "Action execution failed.",
            "retryable": bool(raw.get("retryable", False)),
        }
        if safe_details:
            result["safe_details"] = safe_details
        return result

    def record_ack(self, command_id: str, outcome: dict) -> tuple[dict | None, str | None]:
        command_id = str(command_id or "").strip()
        if not command_id:
            return None, "command_id is required"
        if not isinstance(outcome, dict):
            return None, "ack outcome must be a JSON object"
        with self._lock:
            existing = self.acks.get(command_id)
            if existing is None:
                return None, "unknown command_id; ACK rejected"
            if self.receipt_store and self._persistence_error:
                return None, f"receipt persistence unavailable: {self._persistence_error}"
            command_type = str(existing.get("command_type") or "").strip()
            supplied_command_type = str(outcome.get("command_type") or "").strip()
            if supplied_command_type and supplied_command_type != command_type:
                return None, "command_type does not match the issued command"
            spec = self.catalog.get(command_type)
            if not spec:
                return None, "issued command contract is unavailable"

            raw_status = str(outcome.get("status") or "").strip().lower()
            if not raw_status:
                return None, "ack status is required"

            status = _canonical_status(raw_status)
            if status not in CANONICAL_STATUSES:
                return None, f"unsupported command receipt status: {raw_status!r}"
            current = _canonical_status(existing.get("status")) or "queued"
            if status not in _ALLOWED_TRANSITIONS.get(current, frozenset()):
                return None, f"invalid command receipt transition: {current} -> {status}"

            actor, actor_error = self._approval_actor(
                outcome,
                str(spec.get("approval_role") or "none"),
                status,
                existing.get("actor") if isinstance(existing.get("actor"), dict) else None,
            )
            if actor_error:
                return None, actor_error
            transitions = existing.get("transitions")
            issuance_transition = transitions[0] if isinstance(transitions, list) and transitions else None
            issuance_session_sha256 = (
                str(existing.get("issuance_session_sha256") or "").strip()
                or (
                    str(issuance_transition.get("session_id_sha256") or "").strip()
                    if isinstance(issuance_transition, dict)
                    else ""
                )
            )
            if (
                status in SUCCESS_FLOW_STATUSES
                and issuance_session_sha256
                and actor is not None
                and actor.get("session_id_sha256") != issuance_session_sha256
            ):
                return None, "approval session_id does not match the command issuance scope"
            requires_scope = status in SUCCESS_FLOW_STATUSES
            conversation_id, scope_error = self._identifier(
                outcome.get("conversation_id"), "conversation_id", required=requires_scope,
            )
            if scope_error:
                return None, scope_error
            existing_conversation = str(existing.get("conversation_id") or "").strip() or None
            if existing_conversation and conversation_id and existing_conversation != conversation_id:
                return None, "conversation_id does not match the existing receipt"
            request_id, request_error = self._identifier(outcome.get("request_id"), "request_id")
            if request_error:
                return None, request_error
            existing_request = str(existing.get("request_id") or "").strip() or None
            if existing_request and request_id and existing_request != request_id:
                return None, "request_id does not match the existing receipt"
            message_id, message_error = self._identifier(outcome.get("message_id"), "message_id")
            if message_error:
                return None, message_error
            existing_message = str(existing.get("message_id") or "").strip() or None
            if existing_message and message_id and existing_message != message_id:
                return None, "message_id does not match the existing receipt"
            recording_fingerprint = str(outcome.get("recording_fingerprint") or "").strip()
            if recording_fingerprint and not _SHA256_RE.fullmatch(recording_fingerprint):
                return None, "recording_fingerprint is invalid"
            existing_fingerprint = str(existing.get("recording_fingerprint") or "").strip() or None
            if (
                existing_fingerprint
                and recording_fingerprint
                and existing_fingerprint != recording_fingerprint
            ):
                return None, "recording_fingerprint does not match the existing receipt"
            if (
                recording_fingerprint
                and not existing_fingerprint
                and existing.get("requires_confirmation") is True
            ):
                return None, "recording_fingerprint was not present in the command issuance scope"
            state_revision, revision_error = self._identifier(
                outcome.get("state_revision"), "state_revision", required=requires_scope,
            )
            if revision_error:
                return None, revision_error
            existing_revision = str(existing.get("state_revision") or "").strip() or None
            if existing_revision and state_revision and existing_revision != state_revision:
                return None, "state_revision does not match the command issuance scope"

            if status in SUCCESS_FLOW_STATUSES and existing.get("requires_confirmation") is True:
                frozen_fields = ("request_id", "message_id", "conversation_id", "state_revision")
                if any(not str(existing.get(field) or "").strip() for field in frozen_fields):
                    return None, "command issuance authority scope is incomplete"
                if spec.get("requires_recording") is True and not existing_fingerprint:
                    return None, "command issuance recording fingerprint is missing"

            terminal = self._receipt_terminal(spec, status)
            terminal_success = terminal and status not in FAILURE_STATUSES
            evidence = self._observed_evidence(outcome)
            if terminal_success and str(spec.get("risk") or "") == "review_write":
                proof_error = self._review_terminal_proof_error(
                    command_type,
                    self._issued_payloads.get(command_id),
                    outcome,
                )
                if proof_error:
                    return None, proof_error
            if terminal_success:
                risk = str(spec.get("risk") or "")
                if command_type == "severity.run":
                    proof_error = self._severity_terminal_proof_error(
                        str(existing.get("recording_fingerprint") or "").strip() or None,
                        outcome,
                    )
                    if proof_error:
                        return None, proof_error
                elif risk == "compute":
                    proof_error = self._compute_terminal_proof_error(
                        command_type,
                        str(existing.get("recording_fingerprint") or "").strip() or None,
                        outcome,
                    )
                    if proof_error:
                        return None, proof_error
                elif risk == "artifact_write":
                    proof_error = self._artifact_terminal_proof_error(command_type, outcome)
                    if proof_error:
                        return None, proof_error
            if terminal_success and not evidence:
                return None, "terminal success requires observed postcondition evidence"

            if existing.get("terminal"):
                if status != current:
                    return None, f"invalid command receipt transition: {current} -> {status}"
                return dict(existing), None

            now = _utc_now()
            receipt = copy.deepcopy(existing)
            receipt["status"] = status
            receipt["terminal"] = terminal
            receipt["occurred_at"] = now
            if actor is not None:
                receipt["actor"] = actor
            if conversation_id:
                receipt["conversation_id"] = conversation_id
            if request_id:
                receipt["request_id"] = request_id
            if message_id:
                receipt["message_id"] = message_id
            if recording_fingerprint:
                receipt["recording_fingerprint"] = recording_fingerprint
            if state_revision:
                receipt["state_revision"] = state_revision

            for key in ("success", "result", "postcondition", "reason", "error"):
                receipt.pop(key, None)
            if terminal_success:
                receipt["success"] = True
                receipt["result"] = {"observed": evidence}
                source = "renderer_or_backend_ack"
                if isinstance(outcome.get("terminal_proof"), dict):
                    source = str(outcome["terminal_proof"].get("source") or source)
                receipt["postcondition"] = {
                    "name": str(spec.get("postcondition") or ""),
                    "state_revision": state_revision,
                    "verified": True,
                    "observed_at": now,
                    "source": source,
                    "evidence": evidence,
                }
            elif status in FAILURE_STATUSES:
                receipt["success"] = False
                receipt["reason"] = self._failure_reason(status)
                failure_result = self._failure_result(outcome)
                if failure_result:
                    receipt["result"] = failure_result
                if status == "failed":
                    receipt["error"] = self._receipt_error(outcome)

            transitions = list(receipt.get("transitions") or [])
            sequence = int(receipt.get("transition_count") or len(transitions))
            transition = {
                "sequence": sequence,
                "from": current,
                "to": status,
                "observed_at": now,
                "source": "renderer_ack",
            }
            if state_revision:
                transition["state_revision"] = state_revision
            if conversation_id:
                transition["conversation_id"] = conversation_id
            if actor:
                transition["actor_id_sha256"] = actor["actor_id_sha256"]
                transition["session_id_sha256"] = actor["session_id_sha256"]
            if evidence:
                transition["evidence_sha256"] = _json_sha256(evidence)
            transitions.append(transition)
            receipt["transitions"] = transitions[-self._TRANSITIONS_MAX:]
            receipt["transition_count"] = sequence + 1
            if terminal and str(spec.get("risk") or "") == "review_write":
                receipt["contract_version"] = "ieeg-agent.v1"
                scope_sha256 = _review_receipt_scope_sha256(receipt)
                if scope_sha256:
                    receipt["scope_sha256"] = scope_sha256
                else:
                    receipt.pop("scope_sha256", None)
                    receipt["contract_version"] = REVIEW_ACK_TRANSPORT_VERSION

            snapshot = self._snapshot_locked()
            self.acks[command_id] = receipt
            self.acks.move_to_end(command_id)
            self._trim_locked()
            try:
                self._persist_locked()
            except ReceiptPersistenceError as exc:
                self._restore_locked(snapshot)
                return None, self._persistence_message(exc)
            return dict(receipt), None

    def get_ack(self, command_id: str | None = None) -> dict:
        with self._lock:
            if command_id:
                return dict(self.acks.get(command_id) or {})
            return {key: dict(value) for key, value in self.acks.items()}


def make_handler(bus: UiBus, token: str | None):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            # Deliberately quiet: HTTP paths and renderer outcomes may carry clinical identifiers.
            pass

        def _authorized(self) -> bool:
            if not token:
                return False
            provided = self.headers.get("authorization") or ""
            return hmac.compare_digest(provided, f"Bearer {token}")

        def _send(self, code: int, obj) -> None:
            body = json.dumps(obj).encode("utf-8")
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _read_json(self) -> dict:
            length = int(self.headers.get("content-length") or 0)
            if not length:
                return {}
            try:
                parsed = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
                return parsed if isinstance(parsed, dict) else {}
            except Exception:
                return {}

        def do_GET(self):
            parsed = urlparse(self.path)
            if parsed.path == "/health":
                self._send(200, {"status": "ok", "service": "ieeg-ui-broker", **bus.health()})
                return
            if not self._authorized():
                self._send(401, {"error": "unauthorized"})
                return
            if parsed.path == "/ui/state":
                self._send(200, {"ui_state": bus.get_state()})
                return
            if parsed.path == "/ui/commands":
                self._send(200, {"commands": bus.drain()})
                return
            if parsed.path == "/ui/ack":
                qs = parse_qs(parsed.query)
                command_id = (qs.get("command_id") or [""])[0]
                if command_id:
                    ack = bus.get_ack(command_id)
                    self._send(200, {"command_id": command_id, "ack": ack or None, "found": bool(ack)})
                else:
                    self._send(200, {"acks": bus.get_ack()})
                return
            self._send(404, {"error": f"unknown path {parsed.path}"})

        def do_POST(self):
            parsed = urlparse(self.path)
            if not self._authorized():
                self._send(401, {"error": "unauthorized"})
                return
            payload = self._read_json()
            if parsed.path == "/ui/state":
                bus.set_state(payload.get("ui_state") if isinstance(payload.get("ui_state"), dict) else payload)
                self._send(200, {"ok": True})
                return
            if parsed.path == "/ui/emit":
                command, err = bus.emit(
                    payload.get("type"),
                    payload.get("payload"),
                    payload.get("reason"),
                    payload.get("idempotency_key"),
                    payload.get("authority_scope"),
                )
                if err:
                    self._send(200, {"success": False, "error": err})
                else:
                    self._send(200, {
                        "success": True,
                        "command": command,
                        "staged": command["requires_confirmation"],
                        "receipt": bus.get_ack(command["command_id"]),
                    })
                return
            if parsed.path == "/ui/ack":
                outcome = payload.get("outcome") if isinstance(payload.get("outcome"), dict) else payload
                receipt, err = bus.record_ack(str(payload.get("command_id") or ""), outcome)
                if err:
                    self._send(409, {"ok": False, "error": err})
                else:
                    self._send(200, {"ok": True, "receipt": receipt})
                return
            self._send(404, {"error": f"unknown path {parsed.path}"})

    return Handler


def build_server(
    host: str, port: int, bus: UiBus | None = None, token: str | None = None,
    receipt_store: str | Path | None = None,
) -> ThreadingHTTPServer:
    bus = bus or UiBus(receipt_store=receipt_store if receipt_store is not None else default_receipt_store_path())
    token = token if token is not None else (os.getenv("IEEG_UI_BROKER_TOKEN") or None)
    return ThreadingHTTPServer((host, port), make_handler(bus, token))


def main() -> int:
    default_store = default_receipt_store_path()
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8770)
    ap.add_argument("--receipt-store", default=str(default_store) if default_store else None)
    ap.add_argument("--no-receipt-store", action="store_true")
    args = ap.parse_args()
    receipt_store = None if args.no_receipt_store else args.receipt_store
    server = build_server(args.host, args.port, bus=UiBus(receipt_store=receipt_store))
    durability = "on" if receipt_store else "off"
    print(
        f"[ieeg-ui-broker] listening on http://{args.host}:{args.port} "
        f"(catalog: {len(load_catalog())} commands; durable receipts: {durability})",
        flush=True,
    )
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
