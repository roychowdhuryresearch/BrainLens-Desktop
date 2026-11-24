"""Durable memory — types only (storage 已迁移到 backend).

为保持向后兼容，此模块现在只导出：
- Enum（MemoryScopeLevel / MemoryKind / MemoryStatus / MemoryWritePolicy / MemoryRetrievalTarget）
- Pydantic 类型（MemoryAccessContext / MemoryCreate / MemoryUpdate / MemoryQuery /
  RuntimeMemoryQuery / MemoryResponse / MemoryListResponse / MemoryPromptContext /
  DurableMemoryPromptItem / DurableMemoryPromptContext）
- **Deprecated 兼容桩**：`MemorySessionLocal`, `init_memory_db`, `DurableMemoryRow`, `get_memory_db`
  这些不再操作真实数据库，仅防止遗留 import 崩溃。所有实际 CRUD 走 backend HTTP。

真正的存储和 CRUD 在 backend/app/models/memory.py + backend/app/services/memory_service.py。
Agent 通过 app.services.backend_memory_client 访问。
"""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime
from enum import Enum
from typing import Any, Dict, Iterable, List, Optional

from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import Boolean, Column, DateTime, Integer, String, Text
from sqlalchemy.orm import declarative_base

logger = logging.getLogger(__name__)
Base = declarative_base()


# =========================
# Enums
# =========================


class MemoryScopeLevel(str, Enum):
    USER = "user"
    TEAM = "team"
    COMPANY = "company"


class MemoryKind(str, Enum):
    PREFERENCE = "preference"
    WORKING_STYLE = "working_style"
    LONG_TERM_GOAL = "long_term_goal"
    PROJECT_CONTEXT = "project_context"
    PROJECT_FACT = "project_fact"
    DECISION = "decision"
    ARTIFACT = "artifact"
    FACT = "fact"


class MemoryStatus(str, Enum):
    ACTIVE = "active"
    ARCHIVED = "archived"


class MemoryWritePolicy(str, Enum):
    EXPLICIT = "explicit"


class MemoryRetrievalTarget(str, Enum):
    BOOTSTRAP = "bootstrap"
    CONTROLLER = "controller"
    PROMPT = "prompt"


# =========================
# SQLAlchemy compat model
# =========================


class UserMemoryRow(Base):
    """Legacy local ORM model kept for offline tests and compatibility."""

    __tablename__ = "durable_memories"

    id = Column(Integer, primary_key=True, autoincrement=True)
    scope_level = Column(String(32), nullable=False, default=MemoryScopeLevel.USER.value)
    scope_id = Column(String(255), nullable=False, default="")
    user_id = Column(String(255), nullable=True)
    tenant_id = Column(String(255), nullable=True)
    team_id = Column(String(255), nullable=True)
    owner_user_id = Column(String(255), nullable=True)
    memory_kind = Column(String(64), nullable=False, default=MemoryKind.FACT.value)
    memory_type = Column(String(64), nullable=False, default=MemoryKind.FACT.value)
    namespace = Column(String(128), nullable=False, default="default")
    key = Column(String(255), nullable=False, index=True)
    title = Column(String(255), nullable=True)
    description = Column(Text, nullable=True)
    value_json = Column(Text, nullable=False, default="null")
    source = Column(String(128), nullable=True, default="manual")
    write_policy = Column(String(32), nullable=False, default=MemoryWritePolicy.EXPLICIT.value)
    tags_json = Column(Text, nullable=False, default="[]")
    retrieval_targets_json = Column(Text, nullable=False, default="[]")
    priority = Column(Integer, nullable=False, default=50)
    confidence = Column(Integer, nullable=False, default=100)
    confirmed = Column(Boolean, nullable=False, default=False)
    status = Column(String(32), nullable=False, default=MemoryStatus.ACTIVE.value)
    access_count = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)
    last_accessed_at = Column(DateTime, nullable=True)


# =========================
# Helpers（内部用）
# =========================


def _normalize_text(value: Optional[str], default: str = "") -> str:
    text = str(value or default).strip()
    return text or default


def _normalize_tags(tags: Optional[Iterable[str]]) -> List[str]:
    normalized: List[str] = []
    seen = set()
    for tag in tags or []:
        value = str(tag or "").strip()
        if not value or value in seen:
            continue
        seen.add(value)
        normalized.append(value)
    return normalized


def default_retrieval_targets(memory_kind: Optional[str]) -> List[str]:
    kind = _normalize_text(memory_kind)
    if kind == MemoryKind.PREFERENCE.value:
        return [MemoryRetrievalTarget.BOOTSTRAP.value, MemoryRetrievalTarget.CONTROLLER.value]
    if kind == MemoryKind.WORKING_STYLE.value:
        return [MemoryRetrievalTarget.BOOTSTRAP.value, MemoryRetrievalTarget.CONTROLLER.value]
    if kind in (MemoryKind.LONG_TERM_GOAL.value, MemoryKind.PROJECT_CONTEXT.value):
        return [MemoryRetrievalTarget.BOOTSTRAP.value, MemoryRetrievalTarget.CONTROLLER.value]
    if kind in (MemoryKind.PROJECT_FACT.value, MemoryKind.FACT.value):
        return [MemoryRetrievalTarget.BOOTSTRAP.value, MemoryRetrievalTarget.PROMPT.value]
    return [MemoryRetrievalTarget.BOOTSTRAP.value, MemoryRetrievalTarget.CONTROLLER.value]


def normalize_search_tokens(text: Optional[str]) -> List[str]:
    if not text:
        return []
    raw = str(text).lower()
    return [tok for tok in re.split(r"[\s,，.。;；:：!！?？/\\]+", raw) if tok]


# 下面几个 parse_* 原来操作 ORM row；保留签名但不再调用，
# 新代码请直接解 JSON。
def parse_value(obj: Any) -> Any:
    if obj is None:
        return None
    if hasattr(obj, "value_json"):
        raw = getattr(obj, "value_json", None)
        if raw is None:
            return None
        try:
            return json.loads(raw)
        except Exception:
            return None
    return obj


def parse_tags(obj: Any) -> List[str]:
    if obj is None:
        return []
    if hasattr(obj, "tags_json"):
        raw = getattr(obj, "tags_json", None)
        if not raw:
            return []
        try:
            data = json.loads(raw)
            return [str(x) for x in data] if isinstance(data, list) else []
        except Exception:
            return []
    return []


def parse_retrieval_targets(obj: Any) -> List[str]:
    if obj is None:
        return []
    if hasattr(obj, "retrieval_targets_json"):
        raw = getattr(obj, "retrieval_targets_json", None)
        if not raw:
            return []
        try:
            data = json.loads(raw)
            return [str(x) for x in data] if isinstance(data, list) else []
        except Exception:
            return []
    return []


# =========================
# Pydantic Schemas
# =========================


class MemoryAccessContext(BaseModel):
    user_id: str
    tenant_id: Optional[str] = None
    team_ids: List[str] = Field(default_factory=list)
    permissions: List[str] = Field(default_factory=list)

    @field_validator("user_id")
    @classmethod
    def _validate_user_id(cls, value: str) -> str:
        text = _normalize_text(value)
        if not text:
            raise ValueError("user_id is required")
        return text

    @field_validator("team_ids", "permissions", mode="before")
    @classmethod
    def _normalize_list_field(cls, value):
        if value is None:
            return []
        if isinstance(value, str):
            return [item.strip() for item in value.split(",") if item.strip()]
        return list(value)

    def has_permission(self, permission: str) -> bool:
        perms = {str(item or "").strip() for item in self.permissions}
        return permission in perms or "memory:*" in perms or "memory:all" in perms


class MemoryCreate(BaseModel):
    scope_level: str = Field(default=MemoryScopeLevel.USER.value)
    scope_id: Optional[str] = Field(default=None)
    memory_type: Optional[str] = Field(default=None)
    memory_kind: Optional[str] = Field(default=None)
    namespace: str = Field(default="default")
    key: str
    title: Optional[str] = None
    description: Optional[str] = None
    value: Any = Field(..., description="结构化值；也可以直接传字符串")
    source: Optional[str] = Field(default="manual")
    write_policy: str = Field(default=MemoryWritePolicy.EXPLICIT.value)
    tags: List[str] = Field(default_factory=list)
    retrieval_targets: List[str] = Field(default_factory=list)
    priority: int = Field(default=50)
    confidence: int = Field(default=100)
    confirmed: Optional[bool] = None
    status: str = Field(default=MemoryStatus.ACTIVE.value)
    tenant_id: Optional[str] = None
    team_id: Optional[str] = None

    @field_validator(
        "scope_level", "namespace", "key", "source", "write_policy", "status", mode="before"
    )
    @classmethod
    def _strip_strings(cls, value):
        return _normalize_text(value)

    @field_validator("tags", "retrieval_targets", mode="before")
    @classmethod
    def _normalize_lists(cls, value):
        if value is None:
            return []
        if isinstance(value, str):
            return [item.strip() for item in value.split(",") if item.strip()]
        return list(value)

    @field_validator("tags")
    @classmethod
    def _normalize_tags_field(cls, value):
        return _normalize_tags(value)

    @model_validator(mode="after")
    def _finalize(self):
        self.scope_level = _normalize_text(self.scope_level, default=MemoryScopeLevel.USER.value)
        self.namespace = _normalize_text(self.namespace, default="default")
        self.key = _normalize_text(self.key)
        self.source = _normalize_text(self.source, default="manual")
        self.write_policy = _normalize_text(
            self.write_policy, default=MemoryWritePolicy.EXPLICIT.value
        )
        self.status = _normalize_text(self.status, default=MemoryStatus.ACTIVE.value)
        resolved = _normalize_text(self.memory_kind)
        if not resolved and self.memory_type:
            resolved = _normalize_text(self.memory_type)
        self.memory_kind = resolved or MemoryKind.FACT.value
        if not self.key:
            raise ValueError("key is required")
        return self


class MemoryUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    value: Optional[Any] = None
    source: Optional[str] = None
    tags: Optional[List[str]] = None
    retrieval_targets: Optional[List[str]] = None
    priority: Optional[int] = None
    confidence: Optional[int] = None
    confirmed: Optional[bool] = None
    status: Optional[str] = None


class MemoryQuery(BaseModel):
    scope_levels: Optional[List[str]] = None
    scope_ids: Optional[List[str]] = None
    memory_kinds: Optional[List[str]] = None
    namespace: Optional[str] = None
    tag: Optional[str] = None
    text_query: Optional[str] = None
    include_archived: bool = False
    offset: int = 0
    limit: int = 50


class RuntimeMemoryQuery(BaseModel):
    user_message: str = ""
    target: str = Field(default=MemoryRetrievalTarget.BOOTSTRAP.value)
    include_preferences: bool = True
    include_user_context_memories: bool = True
    include_team_memories: bool = True
    include_company_memories: bool = True
    limit_per_bucket: int = Field(default=4, ge=1, le=10)


class MemoryResponse(BaseModel):
    id: int
    scope_level: str
    scope_id: str
    user_id: Optional[str] = None
    tenant_id: Optional[str] = None
    team_id: Optional[str] = None
    owner_user_id: Optional[str] = None
    memory_kind: str
    memory_type: str
    namespace: str = "default"
    key: str
    title: Optional[str] = None
    description: Optional[str] = None
    value: Any = None
    source: Optional[str] = None
    write_policy: str = "explicit"
    tags: List[str] = Field(default_factory=list)
    retrieval_targets: List[str] = Field(default_factory=list)
    priority: int = 50
    confidence: int = 100
    confirmed: bool = False
    status: str = MemoryStatus.ACTIVE.value
    access_count: int = 0
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    last_accessed_at: Optional[str] = None


class MemoryListResponse(BaseModel):
    items: List[MemoryResponse] = Field(default_factory=list)
    memories: List[MemoryResponse] = Field(default_factory=list)
    total: int = 0

    @model_validator(mode="after")
    def _sync_fields(self):
        if self.memories and not self.items:
            self.items = list(self.memories)
        elif self.items and not self.memories:
            self.memories = list(self.items)
        return self


class MemoryPromptContext(BaseModel):
    entities: List[Dict[str, Any]] = Field(default_factory=list)
    preferences: List[Dict[str, Any]] = Field(default_factory=list)

    def to_prompt_text(self) -> str:
        if not self.entities and not self.preferences:
            return ""
        lines = ["## 用户记忆"]
        if self.entities:
            lines.append("")
            lines.append("### 已知事实")
            for entity in self.entities:
                lines.append(f"- {entity.get('key', '')}: {entity.get('value', '')}")
        if self.preferences:
            lines.append("")
            lines.append("### 用户偏好")
            for pref in self.preferences:
                lines.append(f"- {pref.get('key', '')}: {pref.get('value', '')}")
        return "\n".join(lines)


class DurableMemoryPromptItem(BaseModel):
    id: int
    scope_level: str
    memory_kind: str
    namespace: str = "default"
    key: str
    title: Optional[str] = None
    summary: Optional[str] = None
    value: Any = None
    tags: List[str] = Field(default_factory=list)
    updated_at: Optional[str] = None


class DurableMemoryPromptContext(BaseModel):
    user_preferences: List[DurableMemoryPromptItem] = Field(default_factory=list)
    user_context_memories: List[DurableMemoryPromptItem] = Field(default_factory=list)
    team_memories: List[DurableMemoryPromptItem] = Field(default_factory=list)
    company_memories: List[DurableMemoryPromptItem] = Field(default_factory=list)

    def is_empty(self) -> bool:
        return not (
            self.user_preferences
            or self.user_context_memories
            or self.team_memories
            or self.company_memories
        )

    def _render_bucket(self, title: str, items: List[DurableMemoryPromptItem]) -> List[str]:
        if not items:
            return []
        lines = [title]
        for item in items:
            label = item.title or item.key
            lines.append(f"- {label}: {item.summary}")
        return lines

    def to_bootstrap_text(self) -> str:
        if self.is_empty():
            return ""
        lines = ["### Durable Memory"]
        lines.extend(self._render_bucket("已确认的用户偏好", self.user_preferences))
        lines.extend(self._render_bucket("用户长期上下文", self.user_context_memories))
        lines.extend(self._render_bucket("团队共享记忆", self.team_memories))
        lines.extend(self._render_bucket("机构共享记忆", self.company_memories))
        return "\n".join(lines)

    def to_controller_text(self) -> str:
        return self.to_bootstrap_text()

    def to_system_prompt_text(self) -> str:
        visible_items = (
            self.user_preferences
            + self.user_context_memories
        )
        if not visible_items:
            return ""
        lines = ["### 长期记忆提示"]
        for item in visible_items[:6]:
            label = item.title or item.key
            lines.append(f"- {label}: {item.summary}")
        return "\n".join(lines)


# =========================
# Deprecated 兼容桩 —— 遗留 import 用，真实操作都走 HTTP
# =========================


class _NoopSession:
    """不再真连 DB，保留方法名防止旧代码崩溃。"""

    def close(self) -> None:
        pass

    def commit(self) -> None:
        pass

    def rollback(self) -> None:
        pass

    def query(self, *args, **kwargs):
        raise RuntimeError(
            "Agent 本地 memory DB 已下线。请通过 app.services.backend_memory_client 访问 backend。"
        )

    def add(self, *args, **kwargs):
        raise RuntimeError(
            "Agent 本地 memory DB 已下线。请通过 app.services.backend_memory_client 访问 backend。"
        )

    def delete(self, *args, **kwargs):
        raise RuntimeError(
            "Agent 本地 memory DB 已下线。请通过 app.services.backend_memory_client 访问 backend。"
        )

    def refresh(self, *args, **kwargs):
        pass


def MemorySessionLocal() -> _NoopSession:  # noqa: N802 (keeping legacy name)
    """Deprecated。返回 no-op session；遗留 `MemorySessionLocal()` 调用点不会崩。"""
    return _NoopSession()


def init_memory_db() -> None:
    """Deprecated。Agent 本地 memory DB 已下线，这里是个 no-op。"""
    return None


def get_memory_db():
    """Deprecated FastAPI dependency — 保留 generator 接口。"""
    session = _NoopSession()
    try:
        yield session
    finally:
        session.close()


# 旧别名保留
DurableMemoryRow = UserMemoryRow
Memory = UserMemoryRow
USER_CONTEXT_MEMORY_KINDS = {
    MemoryKind.WORKING_STYLE.value,
    MemoryKind.LONG_TERM_GOAL.value,
    MemoryKind.PROJECT_CONTEXT.value,
    MemoryKind.DECISION.value,
    MemoryKind.PROJECT_FACT.value,
    MemoryKind.FACT.value,
    MemoryKind.ARTIFACT.value,
}
