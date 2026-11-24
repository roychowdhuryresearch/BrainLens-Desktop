"""Conversation-scoped uploaded attachment references.

The store keeps only metadata in memory. Original bytes are persisted through
the shared storage service under a conversation/message/attachment key so
document readers and VL aliases can resolve the same object later.
"""
from __future__ import annotations

import hashlib
import logging
import mimetypes
import os
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Dict, Iterable, Optional

logger = logging.getLogger(__name__)

CHAT_UPLOAD_BUCKET = "ieeg-chat-uploads"


@dataclass
class AttachmentReference:
    attachment_id: str
    message_id: str
    conversation_id: str
    user_id: Optional[str]
    bucket: str
    object_key: str
    filename: Optional[str]
    content_type: str
    size: int
    sha256: str
    image_ref: Optional[str]
    created_at: str

    def to_dict(self) -> Dict[str, object]:
        return asdict(self)

    @classmethod
    def from_dict(cls, payload: Dict[str, object]) -> "AttachmentReference":
        return cls(
            attachment_id=str(payload.get("attachment_id") or payload.get("id") or ""),
            message_id=str(payload.get("message_id") or ""),
            conversation_id=str(payload.get("conversation_id") or ""),
            user_id=(str(payload.get("user_id")) if payload.get("user_id") is not None else None),
            bucket=str(payload.get("bucket") or CHAT_UPLOAD_BUCKET),
            object_key=str(payload.get("object_key") or ""),
            filename=(str(payload.get("filename")) if payload.get("filename") is not None else None),
            content_type=str(payload.get("content_type") or "application/octet-stream"),
            size=int(payload.get("size") or 0),
            sha256=str(payload.get("sha256") or ""),
            image_ref=(str(payload.get("image_ref")) if payload.get("image_ref") is not None else None),
            created_at=str(payload.get("created_at") or datetime.now(timezone.utc).isoformat()),
        )


class AttachmentReferenceStore:
    def __init__(self, conversation_id: str = "default") -> None:
        self._conversation_id = conversation_id
        self._attachments: Dict[str, AttachmentReference] = {}
        self._counter = 0

    def _next_attachment_id(self) -> str:
        self._counter += 1
        return f"att_ref_{self._counter:03d}"

    @staticmethod
    def _extension(content_type: str, filename: Optional[str]) -> str:
        ext = os.path.splitext(filename or "")[1]
        if ext:
            return ext.lower()
        guessed = mimetypes.guess_extension((content_type or "").split(";", 1)[0].strip())
        return guessed or ".bin"

    def store_upload(
        self,
        *,
        raw: bytes,
        content_type: str,
        filename: Optional[str],
        message_id: str,
        user_id: Optional[str],
        size: Optional[int] = None,
        sha256: Optional[str] = None,
    ) -> AttachmentReference:
        attachment_id = self._next_attachment_id()
        safe_message_id = str(message_id or "message").replace("/", "_").replace("\\", "_")
        ext = self._extension(content_type, filename)
        object_key = f"{self._conversation_id}/{safe_message_id}/{attachment_id}{ext}"
        digest = sha256 or hashlib.sha256(raw).hexdigest()
        ref = AttachmentReference(
            attachment_id=attachment_id,
            message_id=safe_message_id,
            conversation_id=self._conversation_id,
            user_id=user_id,
            bucket=CHAT_UPLOAD_BUCKET,
            object_key=object_key,
            filename=filename,
            content_type=content_type or "application/octet-stream",
            size=int(size if size is not None else len(raw)),
            sha256=digest,
            image_ref=None,
            created_at=datetime.now(timezone.utc).isoformat(),
        )

        from runtime.services.storage_service import get_storage_service

        get_storage_service().put_object(ref.bucket, ref.object_key, raw, ref.content_type)
        self._attachments[ref.attachment_id] = ref
        self._persist_metadata(ref)
        logger.info(
            "[AttachmentStore] stored attachment=%s conv=%s object=%s type=%s size=%s",
            ref.attachment_id,
            ref.conversation_id,
            ref.object_key,
            ref.content_type,
            ref.size,
        )
        return ref

    def update(self, ref: AttachmentReference) -> AttachmentReference:
        self._attachments[ref.attachment_id] = ref
        self._persist_metadata(ref)
        return ref

    def put(self, ref: AttachmentReference) -> AttachmentReference:
        self._attachments[ref.attachment_id] = ref
        return ref

    def get(self, attachment_id: str) -> Optional[AttachmentReference]:
        return self._attachments.get(str(attachment_id or "").strip())

    def list_all(self) -> Iterable[AttachmentReference]:
        return list(self._attachments.values())

    def get_summary(self, attachment_ids: Optional[Iterable[str]] = None) -> Optional[str]:
        ids = list(attachment_ids or self._attachments.keys())
        refs = [self._attachments[att_id] for att_id in ids if att_id in self._attachments]
        if not refs:
            return None

        lines = ["[available attachments]"]
        for ref in refs:
            image_part = f", image_ref={ref.image_ref}" if ref.image_ref else ""
            name = ref.filename or ref.object_key.rsplit("/", 1)[-1]
            lines.append(f"- {ref.attachment_id}: {name}, {ref.content_type}{image_part}")
        return "\n".join(lines)

    def clear(self) -> None:
        self._attachments.clear()
        self._counter = 0

    @staticmethod
    def _persist_metadata(ref: AttachmentReference) -> None:
        try:
            from runtime.agent_history.service import get_agent_history_service

            get_agent_history_service().save_attachment(ref.to_dict())
        except Exception:
            logger.debug("[AttachmentStore] attachment metadata persistence skipped", exc_info=True)


_attachment_stores: Dict[str, AttachmentReferenceStore] = {}


def get_attachment_store(conversation_id: str) -> AttachmentReferenceStore:
    conv_id = conversation_id or "default"
    if conv_id not in _attachment_stores:
        _attachment_stores[conv_id] = AttachmentReferenceStore(conversation_id=conv_id)
    return _attachment_stores[conv_id]


def clear_attachment_stores_for_tests() -> None:
    _attachment_stores.clear()
