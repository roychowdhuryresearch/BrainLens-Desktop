"""Conversation-scoped image references with on-demand reads from object storage."""
from __future__ import annotations

import base64
import logging
from typing import Dict, List, Optional

from runtime.models.schemas import ImageReference

logger = logging.getLogger(__name__)


class ImageReferenceStore:
    """Stores uploaded or URL-backed image references for one conversation.

    Uploaded bytes are saved in object storage. get() loads inline base64 for
    consumers that need the data. Failed uploads keep their data in memory.
    """

    def __init__(self, conversation_id: str = "default") -> None:
        self._conversation_id = conversation_id
        self._images: Dict[str, ImageReference] = {}
        self._counter = 0

    def _next_ref_id(self) -> str:
        self._counter += 1
        return f"img_ref_{self._counter:03d}"

    def _storage_key(self, ref_id: str, content_type: str, filename: Optional[str] = None) -> str:
        import os
        ext = os.path.splitext(filename or "")[1]
        if not ext:
            if "png" in content_type:
                ext = ".png"
            elif "webp" in content_type:
                ext = ".webp"
            elif "gif" in content_type:
                ext = ".gif"
            else:
                ext = ".jpg"
        return f"{self._conversation_id}/{ref_id}{ext}"

    def store_upload(
        self,
        *,
        data: str,
        content_type: str = "image/jpeg",
        filename: Optional[str] = None,
        description: Optional[str] = None,
    ) -> ImageReference:
        ref_id = self._next_ref_id()
        object_key = self._storage_key(ref_id, content_type, filename)
        storage_key: Optional[str] = None

        try:
            from runtime.services.storage_service import (
                StorageUnavailableError,
                get_storage_service,
            )
            raw = base64.b64decode(data.split(",", 1)[-1] if "," in data else data)
            get_storage_service().put_object("ieeg-chat-uploads", object_key, raw, content_type)
            storage_key = object_key
            logger.info("[ImageRefStore] Uploaded %s to object storage: %s", ref_id, object_key)
        except StorageUnavailableError:
            # Endpoint already reported unreachable once; keep base64 in memory, stay quiet.
            logger.debug("[ImageRefStore] object storage unavailable for %s; keeping base64 in memory", ref_id)
        except Exception:
            logger.warning("[ImageRefStore] Upload failed for %s, keeping base64 in memory", ref_id, exc_info=True)

        ref = ImageReference(
            ref_id=ref_id,
            source_type="upload",
            content_type=content_type,
            data=data if storage_key is None else None,
            url=None,
            metadata={
                **({"filename": filename} if filename else {}),
                "storage_key": storage_key,
                "storage_bucket": "ieeg-chat-uploads",
            },
            description=description,
        )
        self._images[ref.ref_id] = ref
        return ref

    def store_mcp_url(
        self,
        *,
        url: str,
        content_type: str = "image/jpeg",
        description: Optional[str] = None,
    ) -> ImageReference:
        ref = ImageReference(
            ref_id=self._next_ref_id(),
            source_type="mcp_url",
            content_type=content_type,
            url=url,
            description=description,
        )
        self._images[ref.ref_id] = ref
        return ref

    def store_existing_object(
        self,
        *,
        bucket: str,
        object_key: str,
        content_type: str = "image/jpeg",
        filename: Optional[str] = None,
        description: Optional[str] = None,
    ) -> ImageReference:
        """Create a VL image alias for an already persisted attachment object."""
        ref = ImageReference(
            ref_id=self._next_ref_id(),
            source_type="upload",
            content_type=content_type,
            data=None,
            url=None,
            metadata={
                **({"filename": filename} if filename else {}),
                "storage_key": object_key,
                "storage_bucket": bucket,
            },
            description=description,
        )
        self._images[ref.ref_id] = ref
        return ref

    def get(self, ref_id: str) -> Optional[ImageReference]:
        """Get image reference, lazily fetching base64 data from object storage if needed.

        If the image was persisted to object storage and ``data`` is None, this method
        downloads the bytes and populates ``data`` so that VL / embedding
        consumers get inline base64 they can use directly.
        """
        ref = self._images.get(ref_id)
        if ref is None:
            return None
        if ref.data is not None:
            return ref

        storage_key = (ref.metadata or {}).get("storage_key")
        bucket = (ref.metadata or {}).get("storage_bucket", "ieeg-chat-uploads")
        if not storage_key:
            return ref

        try:
            from runtime.services.storage_service import get_storage_service
            raw = get_storage_service().get_object(bucket, storage_key)
            if raw:
                ref.data = base64.b64encode(raw).decode("ascii")
                logger.debug("[ImageRefStore] Lazy-loaded %s from object storage (%d bytes)", ref_id, len(raw))
        except Exception:
            logger.warning("[ImageRefStore] Failed to fetch %s from object storage", ref_id, exc_info=True)

        return ref

    def list_all(self) -> List[str]:
        return list(self._images.keys())

    def get_summary(self) -> Optional[str]:
        refs = self.list_all()
        if not refs:
            return None
        return f"[可用图片引用: {', '.join(refs)}]"

    def clear(self) -> None:
        self._images.clear()
        self._counter = 0
