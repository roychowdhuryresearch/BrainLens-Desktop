"""Public semantic stream projection for the internal Agent API.

The orchestrator intentionally emits rich runtime telemetry.  This module is
the trust boundary that turns that private event stream into the small,
versioned surface consumed by Electron.  It never forwards reasoning, tool
arguments, or raw exception text.
"""

from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional


AGENT_CONTRACT_VERSION = "ieeg-agent.v1"
PUBLIC_INTERNAL_ERROR = "The agent could not complete this request. Please try again."
_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_RESOURCE_SCOPE_FIELDS = frozenset({
    "recording_id", "recording_sha256", "run_id", "event_id", "project_id", "state_revision",
})
_MESSAGE_NAMESPACE = uuid.UUID("b75cd243-08a5-5190-8eb1-c2159d04f5c1")


def _load_ui_command_types() -> frozenset[str]:
    catalog_path = Path(__file__).resolve().parents[2] / "contracts" / "ui-command-catalog.json"
    try:
        document = json.loads(catalog_path.read_text(encoding="utf-8"))
        commands = document.get("commands") if isinstance(document, dict) else None
        if not isinstance(commands, list):
            return frozenset()
        return frozenset(
            str(item.get("type") or "").strip()
            for item in commands
            if isinstance(item, dict) and str(item.get("type") or "").strip()
        )
    except (OSError, ValueError, TypeError):
        # A missing or malformed allowlist is not permission to emit commands.
        return frozenset()


_UI_COMMAND_TYPES = _load_ui_command_types()


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _require_identifier(value: Any, *, field: str) -> str:
    normalized = str(value or "").strip()
    if not _IDENTIFIER.fullmatch(normalized):
        raise ValueError(f"{field} is not a valid contract identifier")
    return normalized


def _fallback_message_id(request_id: str, outcome: str) -> str:
    value = uuid.uuid5(_MESSAGE_NAMESPACE, f"{request_id}\x1f{outcome}").hex
    return f"msg_{value}"


def _public_error(code: str, request_id: str) -> Dict[str, Any]:
    if code == "cancelled":
        message = "The request was cancelled."
        retryable = False
    elif code == "timeout":
        message = "The agent timed out before completing the request."
        retryable = True
    elif code == "terminal_event_missing":
        message = "The agent stream ended before completion was established."
        retryable = True
    elif code == "contract_version_mismatch":
        message = "The client and Agent contract versions do not match."
        retryable = False
    else:
        message = PUBLIC_INTERNAL_ERROR
        retryable = True
    return {
        "code": code,
        "message": message,
        "retryable": retryable,
        "correlation_id": request_id,
    }


class StreamContractProjector:
    """Stateful, fail-closed projection of one runtime turn.

    ``project`` may return more than one event: a final raw ``done`` can first
    surface commands that were accumulated by the runtime and then emit the
    sole terminal semantic event.
    """

    _INTERNAL_EVENTS = frozenset(
        {
            "thinking",
            "verification",
            "skill_routing",
            "plan_created",
            "plan_updated",
            "plan_completed",
            "agent_control",
            "step_handoff",
            "step_completed",
            "step_status",
            "tool_call",
            "tool_result",
        }
    )

    def __init__(
        self,
        *,
        request_id: str,
        conversation_id: str,
        response_language: str,
        actor_user_id: str,
        state_revision: Optional[str] = None,
    ) -> None:
        self.request_id = _require_identifier(request_id, field="request_id")
        self.conversation_id = _require_identifier(conversation_id, field="conversation_id")
        self.state_revision = (
            _require_identifier(state_revision, field="state_revision")
            if state_revision is not None
            else None
        )
        if response_language not in {"en-US", "zh-CN"}:
            raise ValueError("unsupported response language")
        self.response_language = response_language
        self.actor_user_id = str(actor_user_id or "").strip()
        self.sequence = 0
        self.final_content = ""
        self.action_receipts: List[Dict[str, Any]] = []
        self.research_output: Optional[Dict[str, Any]] = None
        self.ui_commands: List[Dict[str, Any]] = []
        self._ui_command_ids: set[str] = set()
        self._terminal = False

    @property
    def is_terminal(self) -> bool:
        return self._terminal

    def _envelope(self, event: str, data: Any) -> Dict[str, Any]:
        envelope = {
            "contract_version": AGENT_CONTRACT_VERSION,
            "request_id": self.request_id,
            "conversation_id": self.conversation_id,
            "sequence": self.sequence,
            "event": event,
            "visibility": "public",
            "data": data,
            "emitted_at": _utc_now(),
        }
        self.sequence += 1
        return envelope

    @staticmethod
    def _status_phase(message: str) -> str:
        lowered = message.lower()
        if any(token in lowered for token in ("连接", "context", "上下文", "connect")):
            return "scope"
        if any(token in lowered for token in ("plan", "规划", "计划", "处理您的请求")):
            return "planning"
        if any(token in lowered for token in ("verify", "验证", "核验")):
            return "verification"
        if any(token in lowered for token in ("final", "总结", "整理回答")):
            return "finalization"
        return "execution"

    def _status(self, data: Any) -> Dict[str, Any]:
        raw = data if isinstance(data, dict) else {}
        phase = str(raw.get("phase") or self._status_phase(str(raw.get("message") or "")))
        if phase not in {"scope", "planning", "approval", "execution", "verification", "finalization"}:
            phase = "execution"
        messages = {
            "en-US": {
                "scope": "Preparing the scoped turn.",
                "planning": "Preparing the execution plan.",
                "approval": "Waiting for the required approval.",
                "execution": "Executing the requested workflow.",
                "verification": "Verifying the result.",
                "finalization": "Finalizing the response.",
            },
            "zh-CN": {
                "scope": "正在准备本次任务范围。",
                "planning": "正在准备执行计划。",
                "approval": "正在等待所需确认。",
                "execution": "正在执行请求的工作流。",
                "verification": "正在核验结果。",
                "finalization": "正在整理最终答复。",
            },
        }
        result: Dict[str, Any] = {"message": messages[self.response_language][phase], "phase": phase}
        if isinstance(raw.get("step"), int) and raw["step"] >= 0:
            result["step"] = raw["step"]
        if isinstance(raw.get("total_steps"), int) and raw["total_steps"] >= 1:
            result["total_steps"] = raw["total_steps"]
        return result

    def _content(self, event: str, data: Any) -> Optional[Dict[str, Any]]:
        if event == "content_preview_discard":
            self.final_content = ""
            return None
        if not isinstance(data, dict):
            raise ValueError("content data must be an object")
        raw = data
        text = raw.get("text", raw.get("content"))
        if not isinstance(text, str):
            raise ValueError("content text must be a string")
        if "replace" in raw and not isinstance(raw.get("replace"), bool):
            raise ValueError("content replace must be a boolean")
        replace = event == "content_replace" or raw.get("replace") is True
        self.final_content = text if replace else self.final_content + text
        return {
            "text": text,
            "response_language": self.response_language,
            "replace": replace,
        }

    @staticmethod
    def _project_resource_scope(raw: Any) -> Dict[str, Any]:
        if not isinstance(raw, dict):
            raise ValueError("UI command resource_scope must be an object")
        unknown = sorted(set(raw) - _RESOURCE_SCOPE_FIELDS)
        if unknown:
            raise ValueError("UI command resource_scope contains unsupported fields")
        scope: Dict[str, Any] = {}
        for field in ("recording_id", "run_id", "event_id", "project_id", "state_revision"):
            if raw.get(field) not in (None, ""):
                scope[field] = _require_identifier(raw[field], field=f"resource_scope.{field}")
        recording_sha256 = str(raw.get("recording_sha256") or "").strip().lower()
        if recording_sha256:
            if not _SHA256.fullmatch(recording_sha256):
                raise ValueError("resource_scope.recording_sha256 is invalid")
            scope["recording_sha256"] = recording_sha256
        if scope.get("run_id") and not scope.get("recording_id"):
            raise ValueError("resource_scope.run_id requires recording_id")
        if scope.get("event_id") and (not scope.get("run_id") or not scope.get("recording_id")):
            raise ValueError("resource_scope.event_id requires run_id and recording_id")
        return scope

    def _project_ui_command(self, raw: Any) -> Dict[str, Any]:
        if not isinstance(raw, dict):
            raise ValueError("UI command must be an object")
        command_type = str(raw.get("type") or "").strip()
        if not _UI_COMMAND_TYPES or command_type not in _UI_COMMAND_TYPES:
            raise ValueError("UI command type is not allowlisted")
        command_id = _require_identifier(raw.get("command_id"), field="command_id")
        payload = raw.get("payload")
        if not isinstance(payload, dict):
            raise ValueError("UI command payload must be an object")
        requires_confirmation = raw.get("requires_confirmation")
        if not isinstance(requires_confirmation, bool):
            raise ValueError("UI command confirmation flag must be a boolean")
        source = str(raw.get("source") or "mcp").strip()
        if source not in {"mcp", "agent"}:
            raise ValueError("UI command source is invalid")
        reason = str(raw.get("reason") or "").strip() or command_type
        raw_contract_version = str(raw.get("contract_version") or "").strip()
        if raw_contract_version and raw_contract_version != AGENT_CONTRACT_VERSION:
            raise ValueError("UI command contract version is invalid")
        for field, expected in (
            ("request_id", self.request_id),
            ("conversation_id", self.conversation_id),
        ):
            if raw.get(field) not in (None, ""):
                supplied = _require_identifier(raw[field], field=field)
                if supplied != expected:
                    raise ValueError(f"UI command {field} conflicts with the active request")

        resource_scope = (
            self._project_resource_scope(raw["resource_scope"])
            if raw.get("resource_scope") is not None
            else {}
        )
        raw_state_revision = None
        if raw.get("state_revision") not in (None, ""):
            raw_state_revision = _require_identifier(raw["state_revision"], field="state_revision")
        nested_state_revision = resource_scope.get("state_revision")
        if raw_state_revision and nested_state_revision and raw_state_revision != nested_state_revision:
            raise ValueError("UI command state_revision conflicts with resource_scope")
        issued_revision = raw_state_revision or nested_state_revision
        if self.state_revision and issued_revision and self.state_revision != issued_revision:
            raise ValueError("UI command state_revision conflicts with the active request")
        effective_revision = self.state_revision or issued_revision
        if effective_revision:
            resource_scope["state_revision"] = effective_revision
        elif resource_scope:
            raise ValueError("UI command resource_scope requires state_revision")

        command: Dict[str, Any] = {
            "contract_version": AGENT_CONTRACT_VERSION,
            "request_id": self.request_id,
            "conversation_id": self.conversation_id,
            "command_id": command_id,
            "type": command_type,
            "reason": reason,
            "payload": payload,
            "requires_confirmation": requires_confirmation,
            "source": source,
        }
        if raw.get("message_id") not in (None, ""):
            command["message_id"] = _require_identifier(raw["message_id"], field="message_id")
        if raw.get("session_id") not in (None, ""):
            command["session_id"] = _require_identifier(raw["session_id"], field="session_id")
        if effective_revision:
            command["state_revision"] = effective_revision
            command["resource_scope"] = resource_scope
        for key in ("created_at", "contract"):
            value = raw.get(key)
            if key == "created_at" and isinstance(value, str) and value.strip():
                try:
                    datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
                except ValueError:
                    continue
                command[key] = value.strip()
            elif key == "contract" and isinstance(value, dict):
                command[key] = value
        for key in ("deduplicated", "recovered_after_restart"):
            if isinstance(raw.get(key), bool):
                command[key] = raw[key]
        return command

    def _add_ui_command(self, raw: Any) -> Optional[Dict[str, Any]]:
        command = self._project_ui_command(raw)
        command_id = command["command_id"]
        if command_id in self._ui_command_ids:
            return None
        self._ui_command_ids.add(command_id)
        self.ui_commands.append(command)
        return command

    @staticmethod
    def _extract_ui_command(data: Any) -> Optional[Dict[str, Any]]:
        if not isinstance(data, dict):
            return None
        # Tool identity is an authority boundary.  Runtime events use canonical
        # tool names, so accepting an arbitrary namespaced suffix would let an
        # untrusted MCP impersonate the UI broker and inject executable commands.
        name = str(data.get("name") or "").strip()
        if name != "emit_ui_command" or data.get("success") is not True:
            return None
        result = data.get("result")
        if isinstance(result, dict) and isinstance(result.get("command"), dict):
            return result["command"]
        if isinstance(data.get("command"), dict):
            return data["command"]
        return None

    def _user_input(self, data: Any) -> Dict[str, Any]:
        raw = data if isinstance(data, dict) else {}
        timeout = raw.get("timeout")
        timeout_seconds = int(timeout) if isinstance(timeout, (int, float)) and timeout > 0 else 300
        expires_at = datetime.now(timezone.utc) + timedelta(seconds=timeout_seconds)
        input_type = str(raw.get("input_type") or "text")
        if input_type not in {"text", "confirm", "choice"}:
            input_type = "text"
        result: Dict[str, Any] = {
            "input_id": _require_identifier(raw.get("input_id"), field="input_id"),
            "prompt": str(raw.get("prompt") or "Input is required to continue."),
            "input_type": input_type,
            "actor_user_id": _require_identifier(self.actor_user_id, field="actor_user_id"),
            "expires_at": expires_at.isoformat().replace("+00:00", "Z"),
        }
        options = raw.get("options")
        if isinstance(options, list):
            result["options"] = [str(value) for value in options if str(value).strip()]
        metadata = raw.get("input_metadata")
        if isinstance(metadata, dict) and metadata.get("command_id"):
            result["command_id"] = _require_identifier(metadata["command_id"], field="command_id")
        return result

    def _tool_approval(self, data: Any) -> Dict[str, Any]:
        raw = data if isinstance(data, dict) else {}
        approved = raw.get("approved") is True
        input_id = raw.get("input_id") or raw.get("tool_call_id")
        result: Dict[str, Any] = {
            "input_id": _require_identifier(input_id, field="input_id"),
            "decision": "approved" if approved else "rejected",
            "actor_user_id": _require_identifier(self.actor_user_id, field="actor_user_id"),
        }
        if raw.get("command_id"):
            result["command_id"] = _require_identifier(raw["command_id"], field="command_id")
        return result

    def project(self, raw_event: Any) -> List[Dict[str, Any]]:
        if self._terminal:
            return []
        if not isinstance(raw_event, dict):
            return self.fail(code="execution_failed")
        event = str(raw_event.get("event") or "")
        data = raw_event.get("data")

        try:
            if event in {"content", "content_replace", "content_preview_discard"}:
                content = self._content(event, data)
                return [self._envelope("content", content)] if content is not None else []
            if event in {"status", "public_progress"}:
                return [self._envelope(event, self._status(data))]
            if event == "image_urls":
                raw = data if isinstance(data, dict) else {}
                image_urls = [
                    str(value)
                    for value in raw.get("image_urls", [])
                    if str(value).strip()
                ]
                attachment_urls = [
                    str(value)
                    for value in raw.get("attachment_urls", [])
                    if str(value).strip()
                ]
                return [
                    self._envelope(
                        "image_urls",
                        {"image_urls": image_urls, "attachment_urls": attachment_urls},
                    )
                ]
            if event == "tool_result":
                raw_command = self._extract_ui_command(data)
                if raw_command is None:
                    return []
                command = self._add_ui_command(raw_command)
                return [self._envelope("ui_command", command)] if command is not None else []
            if event == "ui_command":
                command = self._add_ui_command(data)
                return [self._envelope("ui_command", command)] if command is not None else []
            if event == "action_receipt":
                if not isinstance(data, dict):
                    return self.fail(code="execution_failed")
                self.action_receipts.append(data)
                return [self._envelope("action_receipt", data)]
            if event == "research_output":
                if not isinstance(data, dict):
                    return self.fail(code="execution_failed")
                self.research_output = data
                return [self._envelope("research_output", data)]
            if event == "user_input_required":
                return [self._envelope("user_input_required", self._user_input(data))]
            if event == "tool_approval_result":
                return [self._envelope("tool_approval_result", self._tool_approval(data))]
            if event == "error":
                raw = data if isinstance(data, dict) else {}
                message = str(raw.get("message") or "").lower()
                if "cancel" in message or "取消" in message:
                    code = "cancelled"
                elif "timeout" in message or "超时" in message:
                    code = "timeout"
                else:
                    code = "execution_failed"
                return self.fail(code=code)
            if event == "done":
                return self._complete(data)
            if event in self._INTERNAL_EVENTS:
                return []
            # Unknown producer events are never forwarded through the public API.
            return []
        except (TypeError, ValueError):
            return self.fail(code="execution_failed")

    def _complete(self, data: Any) -> List[Dict[str, Any]]:
        raw = data if isinstance(data, dict) else {}
        raw_outcome = str(raw.get("outcome") or "completed").strip().lower()
        if raw_outcome in {"failed", "cancelled"}:
            code = "cancelled" if raw_outcome == "cancelled" else "execution_failed"
            return self.fail(code=code)
        if raw_outcome != "completed" or not self.final_content.strip():
            # A producer cannot establish success with an unknown outcome or an
            # empty visible answer, even if it happened to emit a raw done.
            return self.fail(code="execution_failed")

        raw_research_output = raw.get("research_output")
        if raw_research_output is not None and not isinstance(raw_research_output, dict):
            return self.fail(code="execution_failed")
        if (
            self.research_output is not None
            and raw_research_output is not None
            and self.research_output != raw_research_output
        ):
            return self.fail(code="execution_failed")

        receipts = list(self.action_receipts)
        raw_receipts = raw.get("action_receipts")
        if raw_receipts is not None and not isinstance(raw_receipts, list):
            return self.fail(code="execution_failed")
        seen_receipts = {
            json.dumps(receipt, ensure_ascii=False, sort_keys=True)
            for receipt in receipts
        }
        for receipt in raw_receipts or []:
            if not isinstance(receipt, dict):
                return self.fail(code="execution_failed")
            signature = json.dumps(receipt, ensure_ascii=False, sort_keys=True)
            if signature not in seen_receipts:
                receipts.append(receipt)
                seen_receipts.add(signature)

        projected: List[Dict[str, Any]] = []
        raw_commands = raw.get("ui_commands")
        if isinstance(raw_commands, list):
            for raw_command in raw_commands:
                command = self._add_ui_command(raw_command)
                if command is not None:
                    projected.append(self._envelope("ui_command", command))

        message_id = str(raw.get("message_id") or "").strip()
        if not _IDENTIFIER.fullmatch(message_id):
            message_id = _fallback_message_id(self.request_id, "completed")
        done: Dict[str, Any] = {
            "outcome": "completed",
            "message_id": message_id,
            "final_content": self.final_content,
            "response_language": self.response_language,
            "action_receipts": receipts,
            "ui_commands": list(self.ui_commands),
        }
        if self.research_output is not None:
            done["research_output"] = self.research_output
        elif raw_research_output is not None:
            done["research_output"] = raw_research_output
        projected.append(self._envelope("done", done))
        self._terminal = True
        return projected

    def fail(self, *, code: str = "internal_error") -> List[Dict[str, Any]]:
        if self._terminal:
            return []
        error = _public_error(code, self.request_id)
        outcome = "cancelled" if code == "cancelled" else "failed"
        events = [self._envelope("error", error)]
        events.append(
            self._envelope(
                "done",
                {
                    "outcome": outcome,
                    "message_id": _fallback_message_id(self.request_id, outcome),
                    "response_language": self.response_language,
                    "action_receipts": list(self.action_receipts),
                    "ui_commands": list(self.ui_commands),
                    "error": error,
                },
            )
        )
        self._terminal = True
        return events

    def finish(self) -> List[Dict[str, Any]]:
        """Close an upstream EOF that did not establish a semantic terminal."""
        if self._terminal:
            return []
        return self.fail(code="terminal_event_missing")


def format_sse_event(envelope: Dict[str, Any]) -> str:
    """Encode one semantic envelope without relying on transport EOF."""
    event = str(envelope.get("event") or "message")
    return f"event: {event}\ndata: {json.dumps(envelope, ensure_ascii=False)}\n\n"


def iter_sse(events: Iterable[Dict[str, Any]]) -> Iterable[str]:
    for event in events:
        yield format_sse_event(event)
