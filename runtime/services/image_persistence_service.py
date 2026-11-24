"""
Image Persistence Service - 多轮图片持久化

让用户上传的图片在对话跨轮保持可引用。
图片数据存 object storage，内存只保留 object storage 对象 key，按需下载。

使用方式::

    svc = get_image_persistence_service()
    ref = svc.store_image("conv-1", data="base64...", filename="ieeg_snapshot.jpg")
    images = svc.get_conversation_images("conv-1")
    summary = svc.get_context_summary("conv-1")
"""

import base64
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)


@dataclass
class PersistedImage:
    """一张持久化图片。"""
    ref_id: str
    conversation_id: str
    source_type: str  # "upload" | "mcp_url"
    content_type: str
    data: Optional[str] = None  # base64（惰性从 object storage 加载）
    url: Optional[str] = None   # URL（MCP）
    filename: Optional[str] = None
    description: Optional[str] = None
    turn_index: int = 0  # 在哪一轮上传的
    created_at: float = field(default_factory=time.time)
    storage_key: Optional[str] = None
    storage_bucket: Optional[str] = None

    def to_summary(self) -> str:
        desc = self.description or self.filename or self.ref_id
        return f"[图片 {self.ref_id}: {desc}]"

    def ensure_data(self) -> Optional[str]:
        """Lazily fetch base64 data from object storage if not already in memory."""
        if self.data is not None:
            return self.data
        if not self.storage_key or not self.storage_bucket:
            return self.data
        try:
            from runtime.services.storage_service import get_storage_service
            raw = get_storage_service().get_object(self.storage_bucket, self.storage_key)
            if raw:
                self.data = base64.b64encode(raw).decode("ascii")
                logger.debug("[ImagePersist] Lazy-loaded %s from object storage (%d bytes)", self.ref_id, len(raw))
        except Exception:
            logger.warning("[ImagePersist] Failed to fetch %s from object storage", self.ref_id, exc_info=True)
        return self.data


class ImagePersistenceService:
    """跨轮图片持久化服务。"""

    def __init__(self) -> None:
        self._store: Dict[str, List[PersistedImage]] = {}
        self._counter = 0

    def _next_ref_id(self) -> str:
        self._counter += 1
        return f"img_{self._counter:04d}"

    def store_image(
        self,
        conversation_id: str,
        *,
        data: Optional[str] = None,
        url: Optional[str] = None,
        content_type: str = "image/jpeg",
        filename: Optional[str] = None,
        description: Optional[str] = None,
        turn_index: int = 0,
    ) -> PersistedImage:
        """存储一张图片到 object storage，内存只保留对象 key。"""
        source_type = "upload" if data else "mcp_url"
        storage_key: Optional[str] = None

        if data and content_type.startswith("image/"):
            try:
                from runtime.services.storage_service import (
                    StorageUnavailableError,
                    get_storage_service,
                )
                ref_id = self._next_ref_id()
                ext = os.path.splitext(filename or "")[1] or ".jpg"
                object_key = f"{conversation_id}/{ref_id}{ext}"
                raw = base64.b64decode(data.split(",", 1)[-1] if "," in data else data)
                storage = get_storage_service()
                storage.put_object("ieeg-chat-uploads", object_key, raw, content_type)
                storage_key = object_key
                logger.info("[ImagePersist] Uploaded %s to object storage for conv=%s", object_key, conversation_id)
            except StorageUnavailableError:
                # Endpoint already reported unreachable once; keep base64 in memory, stay quiet.
                logger.debug("[ImagePersist] object storage unavailable for conv=%s; keeping image in memory", conversation_id)
            except Exception:
                logger.warning("[ImagePersist] object storage upload failed for conv=%s", conversation_id, exc_info=True)

        img = PersistedImage(
            ref_id=self._next_ref_id() if storage_key is None else ref_id,
            conversation_id=conversation_id,
            source_type=source_type,
            content_type=content_type,
            data=data if storage_key is None else None,
            url=url,
            filename=filename,
            description=description,
            turn_index=turn_index,
            storage_key=storage_key,
            storage_bucket="ieeg-chat-uploads" if storage_key else None,
        )
        if conversation_id not in self._store:
            self._store[conversation_id] = []
        self._store[conversation_id].append(img)
        logger.debug("[ImagePersist] Stored %s for conv=%s turn=%d persisted=%s", img.ref_id, conversation_id, turn_index, bool(storage_key))
        return img

    def get_conversation_images(self, conversation_id: str) -> List[PersistedImage]:
        return list(self._store.get(conversation_id, []))

    def get_image(self, conversation_id: str, ref_id: str) -> Optional[PersistedImage]:
        for img in self._store.get(conversation_id, []):
            if img.ref_id == ref_id:
                return img
        return None

    def get_context_summary(self, conversation_id: str) -> Optional[str]:
        images = self.get_conversation_images(conversation_id)
        if not images:
            return None
        lines = [f"对话中已上传 {len(images)} 张图片:"]
        for img in images:
            lines.append(f"  - {img.to_summary()} (第{img.turn_index + 1}轮上传)")
        return "\n".join(lines)

    def clear_conversation(self, conversation_id: str) -> int:
        images = self._store.pop(conversation_id, [])
        return len(images)

    def count(self, conversation_id: Optional[str] = None) -> int:
        if conversation_id:
            return len(self._store.get(conversation_id, []))
        return sum(len(v) for v in self._store.values())


_image_service: Optional[ImagePersistenceService] = None


def get_image_persistence_service() -> ImagePersistenceService:
    global _image_service
    if _image_service is None:
        _image_service = ImagePersistenceService()
    return _image_service
