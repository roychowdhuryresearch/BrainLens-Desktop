from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple


SESSION_DEFAULTS_SHARED_KEY = "__session_defaults__"
SESSION_DEFAULTS_MEMORY_TYPE = "session_defaults"
HITL_MEMORY_ALLOWED_SCOPES = {"use_once", "session", "durable"}


def normalize_identifier(value: Optional[str], default: str = "") -> str:
    text = re.sub(r"[^0-9A-Za-z_\-\u4e00-\u9fff]+", "_", str(value or "").strip().lower()).strip("_")
    return text or default


def summarize_activation_context(activation_context: Optional[Dict[str, Any]]) -> str:
    if not isinstance(activation_context, dict):
        return ""
    parts: List[str] = []
    for key, value in activation_context.items():
        cleaned_key = str(key or "").strip()
        cleaned_value = str(value or "").strip()
        if cleaned_key and cleaned_value:
            parts.append(f"{cleaned_key}={cleaned_value}")
    return "；".join(parts[:6])


def build_activation_context_fingerprint(
    activation_context: Optional[Dict[str, Any]],
    fingerprint_fields: Optional[List[str]] = None,
) -> Tuple[str, Dict[str, Any]]:
    if not isinstance(activation_context, dict):
        return "", {}

    if fingerprint_fields:
        candidate_items = [
            (str(field).strip(), activation_context.get(str(field).strip()))
            for field in fingerprint_fields
            if str(field).strip()
        ]
    else:
        candidate_items = list(activation_context.items())

    normalized_context: Dict[str, Any] = {}
    fingerprint_tokens: List[str] = []
    for raw_key, raw_value in candidate_items:
        key = str(raw_key or "").strip()
        if not key:
            continue
        if raw_value in (None, "", [], {}):
            continue
        normalized_context[key] = raw_value
        token = normalize_identifier(f"{key}_{raw_value}")
        if token:
            fingerprint_tokens.append(token)

    return "__".join(fingerprint_tokens[:8]), normalized_context


def is_session_defaults_payload(payload: Any) -> bool:
    return isinstance(payload, dict) and payload.get("memory_type") == SESSION_DEFAULTS_MEMORY_TYPE


def extract_session_defaults(shared_memory: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    if not isinstance(shared_memory, dict):
        return []
    bucket = shared_memory.get(SESSION_DEFAULTS_SHARED_KEY)
    if not isinstance(bucket, dict) or bucket.get("memory_type") != SESSION_DEFAULTS_MEMORY_TYPE:
        return []
    items = bucket.get("items") or []
    if not isinstance(items, list):
        return []
    extracted: List[Dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        extracted.append(dict(item))
    return extracted


def upsert_session_default_item(
    shared_memory: Optional[Dict[str, Any]],
    item: Dict[str, Any],
) -> Dict[str, Any]:
    normalized_shared = dict(shared_memory or {})
    bucket = normalized_shared.get(SESSION_DEFAULTS_SHARED_KEY)
    if not isinstance(bucket, dict) or bucket.get("memory_type") != SESSION_DEFAULTS_MEMORY_TYPE:
        bucket = {
            "memory_type": SESSION_DEFAULTS_MEMORY_TYPE,
            "summary": "本会话确认的默认值",
            "items": [],
        }

    items = []
    existing_items = bucket.get("items") or []
    for existing in existing_items:
        if isinstance(existing, dict):
            items.append(dict(existing))

    identity = str(item.get("identity") or "").strip()
    replaced = False
    for index, existing in enumerate(items):
        if str(existing.get("identity") or "").strip() == identity:
            items[index] = dict(item)
            replaced = True
            break
    if not replaced:
        items.append(dict(item))

    items = items[-12:]
    bucket["items"] = items
    bucket["updated_at"] = datetime.utcnow().isoformat()
    normalized_shared[SESSION_DEFAULTS_SHARED_KEY] = bucket
    return normalized_shared
