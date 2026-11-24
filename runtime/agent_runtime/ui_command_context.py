"""Per-turn desktop UI context for MCP-emitted commands.

This module is deliberately not an agent tool provider and deliberately does not store UI state.
The callable UI tools live in ``ui_mcp/mcp_server.py`` and read the renderer state from the UI
broker. Runtime code only needs a small turn-local place to mirror MCP command results into the
final/SSE payload.
"""
from __future__ import annotations

import contextvars
import hashlib
import json
from typing import Any, Dict, List, Mapping, Optional

_UI_CONTEXT: contextvars.ContextVar[Optional[Dict[str, Any]]] = contextvars.ContextVar(
    "ieeg_ui_command_context",
    default=None,
)


def begin_ui_turn(
    accumulator: Optional[List[Dict[str, Any]]],
    *,
    authority_scope: Optional[Mapping[str, Any]] = None,
) -> None:
    _UI_CONTEXT.set(
        {
            "commands": accumulator if accumulator is not None else [],
            "authority_scope": dict(authority_scope or {}),
            "command_authority_scopes": {},
        }
    )


def end_ui_turn() -> None:
    _UI_CONTEXT.set(None)


def current_authority_scope() -> Optional[Dict[str, Any]]:
    """Return the trusted current turn scope in the broker's issuance shape.

    The recording path itself never crosses this boundary.  When available it is converted to a
    fresh content fingerprint and carried as canonical ``resource_scope.recording_sha256`` so a
    durable broker receipt can bind a result after either process restarts.
    """
    ctx = _UI_CONTEXT.get()
    raw = ctx.get("authority_scope") if ctx else None
    if not isinstance(raw, Mapping):
        return None
    scope = {
        field: str(raw.get(field) or "").strip()
        for field in ("request_id", "message_id", "conversation_id", "session_id", "state_revision")
        if str(raw.get(field) or "").strip()
    }
    if not all(scope.get(field) for field in ("request_id", "message_id", "conversation_id", "state_revision")):
        return None

    fingerprint = str(raw.get("recording_fingerprint") or "").strip().lower()
    if len(fingerprint) != 64 or any(character not in "0123456789abcdef" for character in fingerprint):
        from runtime.agent_runtime.clinical_evidence import recording_fingerprint_for_path

        fingerprint = str(
            recording_fingerprint_for_path(raw.get("recording_path"), fresh=True) or ""
        ).strip().lower()
    resource_scope: Dict[str, Any] = {"state_revision": scope["state_revision"]}
    if len(fingerprint) == 64 and all(character in "0123456789abcdef" for character in fingerprint):
        scope["recording_fingerprint"] = fingerprint
        resource_scope["recording_sha256"] = fingerprint
    scope["resource_scope"] = resource_scope
    return scope


def command_idempotency_key(command_type: str, payload: Mapping[str, Any]) -> Optional[str]:
    """Build a stable, non-identifying retry key for one command in the current turn."""
    scope = current_authority_scope()
    command_name = str(command_type or "").strip()
    if not scope or not command_name or not isinstance(payload, Mapping):
        return None
    try:
        payload_bytes = json.dumps(
            dict(payload),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
        key_material = json.dumps(
            {
                "request_id": scope["request_id"],
                "message_id": scope["message_id"],
                "command_type": command_name,
                "payload_sha256": hashlib.sha256(payload_bytes).hexdigest(),
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError):
        return None
    return f"runtime-ui-v1-{hashlib.sha256(key_material).hexdigest()}"


def record_ui_command(command: Dict[str, Any]) -> None:
    if not isinstance(command, dict):
        return
    ctx = _UI_CONTEXT.get()
    if ctx is not None:
        copied = dict(command)
        ctx["commands"].append(copied)
        contract = copied.get("contract")
        is_review_write = (
            isinstance(contract, Mapping)
            and str(contract.get("profile") or "").strip() == "review_write"
        )
        if not is_review_write:
            return

        command_id = str(copied.get("command_id") or "").strip()
        scopes = ctx.get("command_authority_scopes")
        if not command_id or not isinstance(scopes, dict) or command_id in scopes:
            return
        # A deduplicated command belongs to the turn that originally issued its
        # idempotency key.  Never rebind it to a later request/message scope.
        if copied.get("deduplicated") is True:
            return

        turn_scope = current_authority_scope()
        if not isinstance(turn_scope, Mapping):
            return
        authority = {
            field: str(turn_scope.get(field) or "").strip()
            for field in ("request_id", "message_id", "conversation_id", "state_revision")
        }
        if any(not value for value in authority.values()):
            return
        fingerprint = str(turn_scope.get("recording_fingerprint") or "").strip()
        if not fingerprint:
            return
        try:
            payload_bytes = json.dumps(
                copied.get("payload") or {},
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
                allow_nan=False,
            ).encode("utf-8")
        except (TypeError, ValueError):
            return
        scopes[command_id] = {
            "recording_fingerprint": fingerprint,
            "command_type": str(copied.get("type") or "").strip(),
            "payload_sha256": hashlib.sha256(payload_bytes).hexdigest(),
            **authority,
        }


def collected_ui_commands() -> List[Dict[str, Any]]:
    ctx = _UI_CONTEXT.get()
    return list(ctx.get("commands") or []) if ctx else []


def authority_scope_for_command(command_id: str) -> Optional[Dict[str, str]]:
    ctx = _UI_CONTEXT.get()
    scopes = ctx.get("command_authority_scopes") if ctx else None
    scope = scopes.get(str(command_id or "").strip()) if isinstance(scopes, dict) else None
    return dict(scope) if isinstance(scope, dict) else None
