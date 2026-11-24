"""Operation approval state machine with immutable request-scope binding.

High-risk mutations are intentionally split into approval and execution.  The
opaque operation handle is not authority by itself: every transition must
repeat the actor, request, session, conversation, canonical payload digest,
and (when present) UI/state revision captured at creation time.

Example::

    svc = get_operation_safety_service()
    op = svc.create_pending_operation(
        request_id="req-1",
        session_id="session-1",
        conversation_id="conv-1",
        user_id="u-1",
        operation_type="config_change",
        target="service-a",
        params={"replicas": 3},
        description="Set replicas to 3",
        state_revision="42",
    )
    scope = {
        "request_id": op.request_id,
        "session_id": op.session_id,
        "conversation_id": op.conversation_id,
        "user_id": op.user_id,
        "payload_digest": op.payload_digest,
        "state_revision": op.state_revision,
    }
    svc.confirm_operation(op.operation_id, **scope)
    svc.mark_executed(op.operation_id, **scope)
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)


def _sha256_text(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _required_scope_value(value: Any, field_name: str) -> str:
    normalized = str(value or "").strip()
    if not normalized:
        raise ValueError(f"{field_name} must be non-blank")
    if len(normalized) > 256 or any(ord(char) < 32 for char in normalized):
        raise ValueError(f"{field_name} is invalid")
    return normalized


def _optional_state_revision(value: Any) -> Optional[str]:
    if value is None:
        return None
    return _required_scope_value(value, "state_revision")


def _canonical_operation_payload(
    *,
    operation_type: Any,
    target: Any,
    params: Optional[Dict[str, Any]],
    description: Any,
) -> Tuple[Dict[str, Any], str]:
    """Return a JSON-owned payload copy and its canonical SHA-256 digest."""
    payload = {
        "description": str(description or ""),
        "operation_type": _required_scope_value(operation_type, "operation_type"),
        "params": params or {},
        "target": _required_scope_value(target, "target"),
    }
    if not isinstance(payload["params"], dict):
        raise ValueError("params must be an object")
    try:
        serialized = json.dumps(
            payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
    except (TypeError, ValueError) as exc:
        raise ValueError("operation payload must be canonical JSON") from exc

    # Round-tripping gives the operation an owned deep copy.  Mutating the
    # caller's original dictionary can therefore never change what was shown
    # for approval.
    canonical_copy = json.loads(serialized)
    digest = hashlib.sha256(serialized.encode("utf-8")).hexdigest()
    return canonical_copy, digest


@dataclass(frozen=True)
class OperationScope:
    """Authority scope captured once and never mutated."""

    request_id: str
    session_id: str
    conversation_id: str
    user_id: str
    payload_digest: str
    state_revision: Optional[str] = None


@dataclass
class PendingOperation:
    """One pending or completed approval workflow."""

    operation_id: str
    scope: OperationScope
    operation_type: str
    target: str
    params: Dict[str, Any] = field(default_factory=dict)
    description: str = ""
    status: str = "pending"  # pending | confirmed | executed | rolled_back | expired
    previous_state: Optional[Dict[str, Any]] = None
    created_at: float = field(default_factory=time.time)
    confirmed_at: Optional[float] = None
    executed_at: Optional[float] = None
    rolled_back_at: Optional[float] = None

    @property
    def request_id(self) -> str:
        return self.scope.request_id

    @property
    def session_id(self) -> str:
        return self.scope.session_id

    @property
    def conversation_id(self) -> str:
        return self.scope.conversation_id

    @property
    def user_id(self) -> str:
        return self.scope.user_id

    @property
    def payload_digest(self) -> str:
        return self.scope.payload_digest

    @property
    def state_revision(self) -> Optional[str]:
        return self.scope.state_revision

    def to_dict(self) -> Dict[str, Any]:
        """Return privacy-safe audit metadata, never the raw mutation payload."""
        return {
            "operation_id": self.operation_id,
            "request_id_sha256": _sha256_text(self.request_id),
            "session_id_sha256": _sha256_text(self.session_id),
            "conversation_id_sha256": _sha256_text(self.conversation_id),
            "actor_user_id_sha256": _sha256_text(self.user_id),
            "operation_type": self.operation_type,
            "payload_digest": self.payload_digest,
            "state_revision_sha256": _sha256_text(self.state_revision),
            "status": self.status,
            "has_previous_state": self.previous_state is not None,
            "created_at": self.created_at,
            "confirmed_at": self.confirmed_at,
            "executed_at": self.executed_at,
            "rolled_back_at": self.rolled_back_at,
        }

    def confirmation_prompt(self) -> str:
        """Generate the human-facing preview for this exact payload."""
        parts = [f"即将执行操作：{self.description}"]
        parts.append(f"目标：{self.target}")
        if self.params:
            param_str = "、".join(f"{key}={value}" for key, value in self.params.items())
            parts.append(f"参数：{param_str}")
        parts.append('请确认是否执行？（回复"确认"执行，或"取消"放弃）')
        return "\n".join(parts)

    @property
    def is_rollbackable(self) -> bool:
        return self.status == "executed" and self.previous_state is not None


HIGH_RISK_OPERATIONS = {
    "set_parameter",
    "firmware_update",
    "config_change",
    "factory_reset",
    "calibration",
    "delete",
}

_OPERATION_EXPIRE_SECONDS = 300


class OperationSafetyService:
    """In-memory operation approval state machine."""

    def __init__(self) -> None:
        self._operations: Dict[str, PendingOperation] = {}

    def _next_id(self) -> str:
        return f"op_{uuid.uuid4().hex}"

    @staticmethod
    def compute_payload_digest(
        *,
        operation_type: str,
        target: str,
        params: Optional[Dict[str, Any]] = None,
        description: str = "",
    ) -> str:
        """Compute the public canonical digest used by action requests."""
        _, digest = _canonical_operation_payload(
            operation_type=operation_type,
            target=target,
            params=params,
            description=description,
        )
        return digest

    def create_pending_operation(
        self,
        *,
        request_id: str,
        session_id: str,
        conversation_id: str,
        user_id: str,
        operation_type: str,
        target: str,
        params: Optional[Dict[str, Any]] = None,
        description: str = "",
        previous_state: Optional[Dict[str, Any]] = None,
        state_revision: Optional[str] = None,
    ) -> PendingOperation:
        """Create an operation whose authority scope cannot later be widened."""
        canonical_payload, payload_digest = _canonical_operation_payload(
            operation_type=operation_type,
            target=target,
            params=params,
            description=description,
        )
        request_id = _required_scope_value(request_id, "request_id")
        session_id = _required_scope_value(session_id, "session_id")
        conversation_id = _required_scope_value(conversation_id, "conversation_id")
        user_id = _required_scope_value(user_id, "user_id")
        state_revision = _optional_state_revision(state_revision)

        canonical_previous_state: Optional[Dict[str, Any]] = None
        if previous_state is not None:
            if not isinstance(previous_state, dict):
                raise ValueError("previous_state must be an object")
            try:
                canonical_previous_state = json.loads(
                    json.dumps(
                        previous_state,
                        ensure_ascii=False,
                        sort_keys=True,
                        separators=(",", ":"),
                        allow_nan=False,
                    )
                )
            except (TypeError, ValueError) as exc:
                raise ValueError("previous_state must be canonical JSON") from exc

        scope = OperationScope(
            request_id=request_id,
            session_id=session_id,
            conversation_id=conversation_id,
            user_id=user_id,
            payload_digest=payload_digest,
            state_revision=state_revision,
        )
        op = PendingOperation(
            operation_id=self._next_id(),
            scope=scope,
            operation_type=canonical_payload["operation_type"],
            target=canonical_payload["target"],
            params=canonical_payload["params"],
            description=canonical_payload["description"],
            previous_state=canonical_previous_state,
        )
        self._operations[op.operation_id] = op
        logger.info("[OpSafety] Created pending id=%s", op.operation_id)
        return op

    def is_high_risk(self, operation_type: str) -> bool:
        return operation_type in HIGH_RISK_OPERATIONS

    def _scope_matches(
        self,
        op: PendingOperation,
        *,
        request_id: str,
        session_id: str,
        conversation_id: str,
        user_id: str,
        payload_digest: str,
        state_revision: Optional[str],
    ) -> bool:
        try:
            supplied = OperationScope(
                request_id=_required_scope_value(request_id, "request_id"),
                session_id=_required_scope_value(session_id, "session_id"),
                conversation_id=_required_scope_value(conversation_id, "conversation_id"),
                user_id=_required_scope_value(user_id, "user_id"),
                payload_digest=_required_scope_value(payload_digest, "payload_digest"),
                state_revision=_optional_state_revision(state_revision),
            )
            current_digest = self.compute_payload_digest(
                operation_type=op.operation_type,
                target=op.target,
                params=op.params,
                description=op.description,
            )
        except (TypeError, ValueError):
            return False

        # Detect both caller-scope substitution and any in-memory mutation of
        # the approved semantic payload.  compare_digest also avoids exposing
        # which part of a secret-bearing scope differed through timing.
        pairs = (
            (supplied.request_id, op.scope.request_id),
            (supplied.session_id, op.scope.session_id),
            (supplied.conversation_id, op.scope.conversation_id),
            (supplied.user_id, op.scope.user_id),
            (supplied.payload_digest, op.scope.payload_digest),
            (current_digest, op.scope.payload_digest),
            (supplied.state_revision or "", op.scope.state_revision or ""),
        )
        return all(hmac.compare_digest(left, right) for left, right in pairs)

    def _get_scoped_operation(
        self,
        operation_id: str,
        *,
        request_id: str,
        session_id: str,
        conversation_id: str,
        user_id: str,
        payload_digest: str,
        state_revision: Optional[str],
    ) -> Optional[PendingOperation]:
        op = self._operations.get(str(operation_id or "").strip())
        if op is None:
            return None
        if not self._scope_matches(
            op,
            request_id=request_id,
            session_id=session_id,
            conversation_id=conversation_id,
            user_id=user_id,
            payload_digest=payload_digest,
            state_revision=state_revision,
        ):
            logger.warning("[OpSafety] Rejected transition id=%s reason=scope_mismatch", op.operation_id)
            return None
        return op

    def confirm_operation(
        self,
        operation_id: str,
        *,
        request_id: str,
        session_id: str,
        conversation_id: str,
        user_id: str,
        payload_digest: str,
        state_revision: Optional[str] = None,
    ) -> bool:
        """Confirm an operation, without performing its side effect."""
        op = self._get_scoped_operation(
            operation_id,
            request_id=request_id,
            session_id=session_id,
            conversation_id=conversation_id,
            user_id=user_id,
            payload_digest=payload_digest,
            state_revision=state_revision,
        )
        if op is None or op.status != "pending":
            return False
        if time.time() - op.created_at > _OPERATION_EXPIRE_SECONDS:
            op.status = "expired"
            return False
        op.status = "confirmed"
        op.confirmed_at = time.time()
        logger.info("[OpSafety] Confirmed id=%s", op.operation_id)
        return True

    def mark_executed(
        self,
        operation_id: str,
        *,
        request_id: str,
        session_id: str,
        conversation_id: str,
        user_id: str,
        payload_digest: str,
        state_revision: Optional[str] = None,
    ) -> bool:
        """Record execution only for the same scope that was approved."""
        op = self._get_scoped_operation(
            operation_id,
            request_id=request_id,
            session_id=session_id,
            conversation_id=conversation_id,
            user_id=user_id,
            payload_digest=payload_digest,
            state_revision=state_revision,
        )
        if op is None or op.status != "confirmed":
            return False
        op.status = "executed"
        op.executed_at = time.time()
        logger.info("[OpSafety] Executed id=%s", op.operation_id)
        return True

    def rollback_operation(
        self,
        operation_id: str,
        *,
        request_id: str,
        session_id: str,
        conversation_id: str,
        user_id: str,
        payload_digest: str,
        state_revision: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """Return the previous state only to the exact approved scope."""
        op = self._get_scoped_operation(
            operation_id,
            request_id=request_id,
            session_id=session_id,
            conversation_id=conversation_id,
            user_id=user_id,
            payload_digest=payload_digest,
            state_revision=state_revision,
        )
        if op is None or not op.is_rollbackable:
            return None
        op.status = "rolled_back"
        op.rolled_back_at = time.time()
        logger.info("[OpSafety] Rolled back id=%s", op.operation_id)
        # Keep the service-owned snapshot immutable to mutation by the caller.
        return json.loads(json.dumps(op.previous_state, ensure_ascii=False))

    def cancel_operation(
        self,
        operation_id: str,
        *,
        request_id: str,
        session_id: str,
        conversation_id: str,
        user_id: str,
        payload_digest: str,
        state_revision: Optional[str] = None,
    ) -> bool:
        """Cancel a pending operation only from its original request scope."""
        op = self._get_scoped_operation(
            operation_id,
            request_id=request_id,
            session_id=session_id,
            conversation_id=conversation_id,
            user_id=user_id,
            payload_digest=payload_digest,
            state_revision=state_revision,
        )
        if op is None or op.status != "pending":
            return False
        op.status = "expired"
        logger.info("[OpSafety] Cancelled id=%s", op.operation_id)
        return True

    def get_operation(self, operation_id: str) -> Optional[PendingOperation]:
        return self._operations.get(operation_id)

    def get_pending_operations(self, conversation_id: str) -> List[PendingOperation]:
        now = time.time()
        results = []
        for op in self._operations.values():
            if op.conversation_id != conversation_id:
                continue
            if op.status == "pending" and now - op.created_at > _OPERATION_EXPIRE_SECONDS:
                op.status = "expired"
            if op.status == "pending":
                results.append(op)
        return results

    def get_operation_log(self, conversation_id: str, limit: int = 20) -> List[Dict[str, Any]]:
        """Return bounded metadata; raw params and prior state are intentionally omitted."""
        ops = [op for op in self._operations.values() if op.conversation_id == conversation_id]
        ops.sort(key=lambda operation: operation.created_at, reverse=True)
        return [op.to_dict() for op in ops[:limit]]


_safety_service: Optional[OperationSafetyService] = None


def get_operation_safety_service() -> OperationSafetyService:
    global _safety_service
    if _safety_service is None:
        _safety_service = OperationSafetyService()
    return _safety_service
