"""Agent-side Memory Service — HTTP shim.

以前是自己操作 SQLite 的富服务。现在 durable_memories 已迁到 backend，此处仅作为
同步 HTTP shim，把老的方法签名（`MemoryService.create_memory_record(db, ...)` 等）
转发到 backend 的 `/internal/api/memories/*`。

- 保留全部静态/类方法签名（`db` 参数被忽略）
- 使用 httpx.Client（同步），因为大部分 agent 调用点是在 `asyncio.to_thread` 里跑的
- 失败抛 MemoryServiceError；上层 runtime 已经有 try/except 兜底
- 鉴权：env `AGENT_BACKEND_TOKEN`
- Runtime context 在 agent 进程内有 30s TTL cache

异步调用方（少数）可以直接用 app.services.backend_memory_client 的 AsyncClient。
"""

from __future__ import annotations

from datetime import datetime
import json
import logging
import os
import threading
import time
from typing import Any, Dict, List, Optional

import httpx

from runtime.models.memory import (
    DurableMemoryPromptContext,
    DurableMemoryPromptItem,
    MemoryAccessContext,
    MemoryCreate,
    MemoryKind,
    MemoryListResponse,
    MemoryPromptContext,
    MemoryQuery,
    MemoryResponse,
    MemoryRetrievalTarget,
    MemoryScopeLevel,
    MemoryStatus,
    MemoryUpdate,
    RuntimeMemoryQuery,
    USER_CONTEXT_MEMORY_KINDS,
    UserMemoryRow,
    default_retrieval_targets,
    parse_retrieval_targets,
    parse_tags,
    parse_value,
)

logger = logging.getLogger(__name__)


_DEFAULT_BACKEND_URL = "http://127.0.0.1:8000"
_CACHE_TTL_SECONDS = 30.0
_RUNTIME_CTX_TIMEOUT = httpx.Timeout(connect=5.0, read=10.0, write=5.0, pool=5.0)


class MemoryServiceError(RuntimeError):
    """Backend memory API 调用失败。"""


class MemoryValidationError(ValueError):
    """保留原名以兼容 caller catch 语义。"""


class MemoryAccessError(PermissionError):
    """保留原名以兼容 caller catch 语义。"""


# =========================
# HTTP client (module-level singleton, thread-safe)
# =========================


def _backend_url() -> str:
    return (os.environ.get("BACKEND_INTERNAL_URL") or _DEFAULT_BACKEND_URL).rstrip("/")


def _auth_header() -> Dict[str, str]:
    token = os.environ.get("AGENT_BACKEND_TOKEN", "").strip()
    if not token:
        raise MemoryServiceError("Set AGENT_BACKEND_TOKEN to access the memory backend")
    return {"Authorization": f"Bearer {token}"}


_http_client: Optional[httpx.Client] = None
_http_lock = threading.Lock()


def _get_http() -> httpx.Client:
    global _http_client
    if _http_client is None:
        with _http_lock:
            if _http_client is None:
                _http_client = httpx.Client(
                    base_url=_backend_url(),
                    timeout=_RUNTIME_CTX_TIMEOUT,
                    limits=httpx.Limits(max_connections=50, max_keepalive_connections=20),
                    trust_env=False,
                )
    return _http_client


def _access_headers(access: MemoryAccessContext) -> Dict[str, str]:
    headers: Dict[str, str] = {"X-User-Id": access.user_id}
    if access.tenant_id:
        headers["X-Tenant-Id"] = access.tenant_id
    if access.team_ids:
        headers["X-Team-Ids"] = ",".join(access.team_ids)
    if access.permissions:
        headers["X-Permissions"] = ",".join(access.permissions)
    headers.update(_auth_header())
    return headers


def _request_json(
    method: str,
    path: str,
    *,
    access: Optional[MemoryAccessContext] = None,
    json_body: Optional[Dict[str, Any]] = None,
) -> Any:
    headers: Dict[str, str] = {}
    if access is not None:
        headers.update(_access_headers(access))
    else:
        headers.update(_auth_header())
    try:
        resp = _get_http().request(method, path, headers=headers, json=json_body)
    except httpx.TimeoutException as exc:
        raise MemoryServiceError(f"timeout calling {method} {path}: {exc}") from exc
    except httpx.RequestError as exc:
        raise MemoryServiceError(f"network error calling {method} {path}: {exc}") from exc

    if resp.status_code == 403:
        raise MemoryAccessError(_extract_detail(resp) or "forbidden")
    if resp.status_code == 400:
        raise MemoryValidationError(_extract_detail(resp) or "invalid request")
    if resp.status_code == 404:
        return None
    if resp.status_code >= 400:
        raise MemoryServiceError(
            f"{resp.status_code} calling {method} {path}: {resp.text[:200]}"
        )
    if resp.status_code == 204 or not resp.content:
        return None
    try:
        return resp.json()
    except Exception as exc:
        raise MemoryServiceError(f"invalid json from {method} {path}: {exc}") from exc


def _extract_detail(resp: httpx.Response) -> Optional[str]:
    try:
        data = resp.json()
        if isinstance(data, dict):
            d = data.get("detail")
            if isinstance(d, str):
                return d
        return None
    except Exception:
        return None


# =========================
# Runtime context cache
# =========================


_RUNTIME_CACHE: Dict[tuple, tuple[float, DurableMemoryPromptContext]] = {}
_RUNTIME_CACHE_LOCK = threading.Lock()


def _cache_get(key: tuple) -> Optional[DurableMemoryPromptContext]:
    with _RUNTIME_CACHE_LOCK:
        entry = _RUNTIME_CACHE.get(key)
        if not entry:
            return None
        exp, ctx = entry
        if time.time() > exp:
            _RUNTIME_CACHE.pop(key, None)
            return None
        return ctx


def _cache_set(key: tuple, value: DurableMemoryPromptContext) -> None:
    with _RUNTIME_CACHE_LOCK:
        _RUNTIME_CACHE[key] = (time.time() + _CACHE_TTL_SECONDS, value)


def _cache_invalidate_user(user_id: str) -> None:
    with _RUNTIME_CACHE_LOCK:
        keys = [k for k in _RUNTIME_CACHE if k and k[0] == user_id]
        for k in keys:
            _RUNTIME_CACHE.pop(k, None)


def _normalize_runtime_cache_message(value: Optional[str]) -> str:
    return " ".join(str(value or "").split())


def _runtime_context_cache_key(
    access_context: MemoryAccessContext,
    query: RuntimeMemoryQuery,
) -> tuple:
    return (
        access_context.user_id,
        str(access_context.tenant_id or ""),
        tuple(sorted(str(item) for item in (access_context.team_ids or []))),
        tuple(sorted(str(item) for item in (access_context.permissions or []))),
        str(query.target or ""),
        int(query.limit_per_bucket or 4),
        bool(query.include_preferences),
        bool(query.include_user_context_memories),
        bool(query.include_team_memories),
        bool(query.include_company_memories),
        _normalize_runtime_cache_message(query.user_message),
    )


# =========================
# MemoryService — shim
# =========================


class MemoryService:
    """保持老签名兼容的 memory service。

    - 传入真实 SQLAlchemy Session 时：走本地 SQLite compat 路径（供离线测试/旧调用使用）
    - 否则：走 backend HTTP durable memory API
    """

    # 命名常量保持兼容
    USER_WRITE_ANY = "memory:write:user:any"
    TEAM_WRITE = "memory:write:team"
    TEAM_WRITE_ANY = "memory:write:team:any"
    COMPANY_WRITE = "memory:write:company"
    COMPANY_WRITE_ANY = "memory:write:company:any"
    READ_ALL = "memory:read:all"

    @staticmethod
    def _map_memory_kind(memory_kind: Optional[str]) -> str:
        normalized = str(memory_kind or "").strip().lower()
        alias_map = {
            "entity": MemoryKind.PROJECT_FACT.value,
            "fact": MemoryKind.FACT.value,
            "preference": MemoryKind.PREFERENCE.value,
            "working_style": MemoryKind.WORKING_STYLE.value,
            "long_term_goal": MemoryKind.LONG_TERM_GOAL.value,
            "project_context": MemoryKind.PROJECT_CONTEXT.value,
            "decision": MemoryKind.DECISION.value,
            "artifact": MemoryKind.ARTIFACT.value,
            "project_fact": MemoryKind.PROJECT_FACT.value,
        }
        return alias_map.get(normalized, normalized or MemoryKind.PROJECT_FACT.value)

    @staticmethod
    def _should_use_local_db(db: Any) -> bool:
        return db is not None and getattr(db, "bind", None) is not None and hasattr(db, "query")

    @classmethod
    def _assert_scope_write_access(
        cls,
        access_context: MemoryAccessContext,
        *,
        scope_level: str,
        scope_id: str,
    ) -> None:
        if scope_level == MemoryScopeLevel.USER.value:
            if scope_id != access_context.user_id and not access_context.has_permission(cls.USER_WRITE_ANY):
                raise MemoryAccessError("cannot write user-scoped memory for another user")
            return

        if scope_level == MemoryScopeLevel.TEAM.value:
            if not scope_id or scope_id not in access_context.team_ids:
                raise MemoryAccessError("team memory requires a visible team scope")
            if not (
                access_context.has_permission(cls.TEAM_WRITE)
                or access_context.has_permission(cls.TEAM_WRITE_ANY)
            ):
                raise MemoryAccessError("team memory write requires permission")
            return

        if scope_level == MemoryScopeLevel.COMPANY.value:
            if not scope_id or scope_id != str(access_context.tenant_id or ""):
                raise MemoryAccessError("company memory requires tenant scope")
            if not (
                access_context.has_permission(cls.COMPANY_WRITE)
                or access_context.has_permission(cls.COMPANY_WRITE_ANY)
            ):
                raise MemoryAccessError("company memory write requires permission")
            return

        raise MemoryValidationError(f"unsupported scope_level: {scope_level}")

    @classmethod
    def _normalize_local_create(
        cls,
        access_context: MemoryAccessContext,
        data: MemoryCreate,
    ) -> Dict[str, Any]:
        scope_level = str(data.scope_level or MemoryScopeLevel.USER.value).strip().lower()
        scope_id = str(data.scope_id or "").strip()
        if scope_level == MemoryScopeLevel.USER.value:
            scope_id = scope_id or access_context.user_id
        elif scope_level == MemoryScopeLevel.TEAM.value:
            scope_id = scope_id or (access_context.team_ids[0] if access_context.team_ids else "")
        elif scope_level == MemoryScopeLevel.COMPANY.value:
            scope_id = scope_id or str(access_context.tenant_id or "")

        cls._assert_scope_write_access(
            access_context,
            scope_level=scope_level,
            scope_id=scope_id,
        )

        memory_kind = cls._map_memory_kind(data.memory_kind or data.memory_type)
        retrieval_targets = list(data.retrieval_targets or default_retrieval_targets(memory_kind))
        owner_user_id = access_context.user_id if scope_level != MemoryScopeLevel.USER.value else scope_id
        now = datetime.utcnow()
        return {
            "scope_level": scope_level,
            "scope_id": scope_id,
            "user_id": scope_id if scope_level == MemoryScopeLevel.USER.value else None,
            "tenant_id": data.tenant_id or access_context.tenant_id,
            "team_id": data.team_id or (scope_id if scope_level == MemoryScopeLevel.TEAM.value else None),
            "owner_user_id": owner_user_id,
            "memory_kind": memory_kind,
            "memory_type": str(data.memory_type or memory_kind),
            "namespace": str(data.namespace or "default"),
            "key": str(data.key or "").strip(),
            "title": data.title,
            "description": data.description,
            "value_json": json.dumps(data.value, ensure_ascii=False),
            "source": data.source,
            "write_policy": data.write_policy,
            "tags_json": json.dumps(list(data.tags or []), ensure_ascii=False),
            "retrieval_targets_json": json.dumps(retrieval_targets, ensure_ascii=False),
            "priority": int(data.priority or 50),
            "confidence": int(data.confidence or 100),
            "confirmed": bool(data.confirmed) if data.confirmed is not None else False,
            "status": str(data.status or MemoryStatus.ACTIVE.value),
            "created_at": now,
            "updated_at": now,
        }

    @staticmethod
    def _row_visible_to_access(row: UserMemoryRow, access_context: MemoryAccessContext) -> bool:
        if access_context.has_permission(MemoryService.READ_ALL):
            return True
        scope_level = str(row.scope_level or "")
        scope_id = str(row.scope_id or "")
        if scope_level == MemoryScopeLevel.USER.value:
            return scope_id == access_context.user_id
        if scope_level == MemoryScopeLevel.TEAM.value:
            return scope_id in set(access_context.team_ids or [])
        if scope_level == MemoryScopeLevel.COMPANY.value:
            return bool(access_context.tenant_id) and scope_id == str(access_context.tenant_id)
        return False

    @staticmethod
    def _row_to_response(row: UserMemoryRow) -> MemoryResponse:
        return MemoryResponse(
            id=int(row.id),
            scope_level=str(row.scope_level),
            scope_id=str(row.scope_id),
            user_id=row.user_id,
            tenant_id=row.tenant_id,
            team_id=row.team_id,
            owner_user_id=row.owner_user_id,
            memory_kind=str(row.memory_kind),
            memory_type=str(row.memory_type or row.memory_kind),
            namespace=str(row.namespace or "default"),
            key=str(row.key),
            title=row.title,
            description=row.description,
            value=parse_value(row),
            source=row.source,
            write_policy=str(row.write_policy or "explicit"),
            tags=parse_tags(row),
            retrieval_targets=parse_retrieval_targets(row),
            priority=int(row.priority or 50),
            confidence=int(row.confidence or 100),
            confirmed=bool(row.confirmed),
            status=str(row.status or MemoryStatus.ACTIVE.value),
            access_count=int(row.access_count or 0),
            created_at=row.created_at.isoformat() if row.created_at else None,
            updated_at=row.updated_at.isoformat() if row.updated_at else None,
            last_accessed_at=row.last_accessed_at.isoformat() if row.last_accessed_at else None,
        )

    @staticmethod
    def _filter_local_rows(
        rows: List[UserMemoryRow],
        *,
        access_context: MemoryAccessContext,
        query: MemoryQuery,
    ) -> List[UserMemoryRow]:
        filtered = [row for row in rows if MemoryService._row_visible_to_access(row, access_context)]
        if query.scope_levels:
            allowed_scope_levels = {str(item) for item in query.scope_levels}
            filtered = [row for row in filtered if str(row.scope_level) in allowed_scope_levels]
        if query.scope_ids:
            allowed_scope_ids = {str(item) for item in query.scope_ids}
            filtered = [row for row in filtered if str(row.scope_id) in allowed_scope_ids]
        if query.memory_kinds:
            allowed_memory_kinds = {str(item) for item in query.memory_kinds}
            filtered = [row for row in filtered if str(row.memory_kind) in allowed_memory_kinds]
        if query.namespace:
            filtered = [row for row in filtered if str(row.namespace or "default") == str(query.namespace)]
        if not query.include_archived:
            filtered = [row for row in filtered if str(row.status or "") != MemoryStatus.ARCHIVED.value]
        if query.tag:
            filtered = [row for row in filtered if str(query.tag) in set(parse_tags(row))]
        if query.text_query:
            needle = str(query.text_query).strip().lower()
            filtered = [
                row
                for row in filtered
                if needle in str(row.key or "").lower()
                or needle in str(row.title or "").lower()
                or needle in str(row.description or "").lower()
                or needle in json.dumps(parse_value(row), ensure_ascii=False).lower()
            ]
        filtered.sort(
            key=lambda row: (
                int(row.priority or 0),
                row.updated_at or row.created_at or datetime.min,
            ),
            reverse=True,
        )
        offset = max(int(query.offset or 0), 0)
        limit = max(int(query.limit or 50), 0)
        if limit == 0:
            return []
        return filtered[offset: offset + limit]

    @classmethod
    def _local_lookup_record(
        cls,
        db: Any,
        *,
        access_context: MemoryAccessContext,
        memory_id: int,
    ) -> Optional[UserMemoryRow]:
        row = db.query(UserMemoryRow).filter(UserMemoryRow.id == memory_id).first()
        if row is None or not cls._row_visible_to_access(row, access_context):
            return None
        return row

    @staticmethod
    def _summarize_value(value: Any) -> str:
        if isinstance(value, dict):
            return "; ".join(f"{k}={v}" for k, v in value.items())
        if isinstance(value, list):
            return ", ".join(str(item) for item in value)
        return str(value)

    @classmethod
    def _local_runtime_context(
        cls,
        db: Any,
        *,
        access_context: MemoryAccessContext,
        query: RuntimeMemoryQuery,
    ) -> DurableMemoryPromptContext:
        rows = db.query(UserMemoryRow).all()
        visible_rows = cls._filter_local_rows(
            rows,
            access_context=access_context,
            query=MemoryQuery(limit=10_000),
        )
        limit = max(int(query.limit_per_bucket or 4), 1)
        ctx = DurableMemoryPromptContext()

        for row in visible_rows:
            item = DurableMemoryPromptItem(
                id=int(row.id),
                scope_level=str(row.scope_level),
                memory_kind=str(row.memory_kind),
                namespace=str(row.namespace or "default"),
                key=str(row.key),
                title=row.title,
                summary=cls._summarize_value(parse_value(row)),
                value=parse_value(row),
                tags=parse_tags(row),
                updated_at=row.updated_at.isoformat() if row.updated_at else None,
            )
            if row.scope_level == MemoryScopeLevel.USER.value:
                if query.include_preferences and row.memory_kind == MemoryKind.PREFERENCE.value:
                    if len(ctx.user_preferences) < limit:
                        ctx.user_preferences.append(item)
                elif (
                    query.include_user_context_memories
                    and row.memory_kind in USER_CONTEXT_MEMORY_KINDS
                    and len(ctx.user_context_memories) < limit
                ):
                    ctx.user_context_memories.append(item)
            elif (
                query.include_team_memories
                and row.scope_level == MemoryScopeLevel.TEAM.value
                and len(ctx.team_memories) < limit
            ):
                ctx.team_memories.append(item)
            elif (
                query.include_company_memories
                and row.scope_level == MemoryScopeLevel.COMPANY.value
                and len(ctx.company_memories) < limit
            ):
                ctx.company_memories.append(item)
        return ctx

    # =========================
    # 富 CRUD（agent runtime 调用）
    # =========================

    @classmethod
    def create_memory_record(
        cls,
        db: Any = None,
        *,
        access_context: MemoryAccessContext,
        data: MemoryCreate,
    ) -> MemoryResponse:
        if cls._should_use_local_db(db):
            payload = cls._normalize_local_create(access_context, data)
            row = UserMemoryRow(**payload)
            db.add(row)
            db.commit()
            db.refresh(row)
            _cache_invalidate_user(access_context.user_id)
            return cls._row_to_response(row)
        payload = _dump_model(data)
        resp = _request_json(
            "POST", "/internal/api/memories/records", access=access_context, json_body=payload
        )
        _cache_invalidate_user(access_context.user_id)
        if resp is None:
            # 404/204/empty body -> _request_json returns None; guard like the sibling
            # get/list/update/delete methods so the caller gets a catchable
            # MemoryServiceError instead of an opaque pydantic ValidationError (HTTP 500).
            raise MemoryServiceError("create/upsert memory returned no record (None response)")
        return MemoryResponse.model_validate(resp)

    @classmethod
    def upsert_memory_record(
        cls,
        db: Any = None,
        *,
        access_context: MemoryAccessContext,
        data: MemoryCreate,
    ) -> MemoryResponse:
        if cls._should_use_local_db(db):
            payload = cls._normalize_local_create(access_context, data)
            row = (
                db.query(UserMemoryRow)
                .filter(
                    UserMemoryRow.scope_level == payload["scope_level"],
                    UserMemoryRow.scope_id == payload["scope_id"],
                    UserMemoryRow.namespace == payload["namespace"],
                    UserMemoryRow.key == payload["key"],
                )
                .first()
            )
            if row is None:
                row = UserMemoryRow(**payload)
                db.add(row)
            else:
                for key, value in payload.items():
                    if key in {"created_at"}:
                        continue
                    setattr(row, key, value)
                row.updated_at = datetime.utcnow()
            db.commit()
            db.refresh(row)
            _cache_invalidate_user(access_context.user_id)
            return cls._row_to_response(row)
        payload = _dump_model(data)
        resp = _request_json(
            "POST",
            "/internal/api/memories/records/upsert",
            access=access_context,
            json_body=payload,
        )
        _cache_invalidate_user(access_context.user_id)
        if resp is None:
            # 404/204/empty body -> _request_json returns None; guard like the sibling
            # get/list/update/delete methods so the caller gets a catchable
            # MemoryServiceError instead of an opaque pydantic ValidationError (HTTP 500).
            raise MemoryServiceError("create/upsert memory returned no record (None response)")
        return MemoryResponse.model_validate(resp)

    @classmethod
    def get_memory_record(
        cls,
        db: Any = None,
        *,
        access_context: MemoryAccessContext,
        memory_id: int,
    ) -> Optional[MemoryResponse]:
        if cls._should_use_local_db(db):
            row = cls._local_lookup_record(
                db,
                access_context=access_context,
                memory_id=memory_id,
            )
            if row is None:
                return None
            row.access_count = int(row.access_count or 0) + 1
            row.last_accessed_at = datetime.utcnow()
            db.commit()
            db.refresh(row)
            return cls._row_to_response(row)
        resp = _request_json(
            "GET",
            f"/internal/api/memories/records/{memory_id}",
            access=access_context,
        )
        if resp is None:
            return None
        return MemoryResponse.model_validate(resp)

    @classmethod
    def list_memory_records(
        cls,
        db: Any = None,
        *,
        access_context: MemoryAccessContext,
        query: Optional[MemoryQuery] = None,
    ) -> MemoryListResponse:
        query = query or MemoryQuery()
        if cls._should_use_local_db(db):
            rows = db.query(UserMemoryRow).all()
            filtered_all = cls._filter_local_rows(
                rows,
                access_context=access_context,
                query=query.model_copy(update={"offset": 0, "limit": 10_000}),
            )
            total = len(filtered_all)
            offset = max(int(query.offset or 0), 0)
            limit = max(int(query.limit or 50), 0)
            paged_rows = filtered_all[offset: offset + limit] if limit else []
            memories = [cls._row_to_response(row) for row in paged_rows]
            return MemoryListResponse(memories=memories, items=memories, total=total)
        resp = _request_json(
            "POST",
            "/internal/api/memories/query",
            access=access_context,
            json_body=_dump_model(query),
        )
        if resp is None:
            return MemoryListResponse(memories=[], items=[], total=0)
        return MemoryListResponse.model_validate(resp)

    @classmethod
    def update_memory_record(
        cls,
        db: Any = None,
        *,
        access_context: MemoryAccessContext,
        memory_id: int,
        data: MemoryUpdate,
    ) -> Optional[MemoryResponse]:
        if cls._should_use_local_db(db):
            row = cls._local_lookup_record(
                db,
                access_context=access_context,
                memory_id=memory_id,
            )
            if row is None:
                return None
            payload = _dump_model(data, exclude_none=True)
            for key, value in payload.items():
                if key == "value":
                    row.value_json = json.dumps(value, ensure_ascii=False)
                elif key == "tags":
                    row.tags_json = json.dumps(list(value or []), ensure_ascii=False)
                elif key == "retrieval_targets":
                    row.retrieval_targets_json = json.dumps(list(value or []), ensure_ascii=False)
                elif hasattr(row, key):
                    setattr(row, key, value)
            row.updated_at = datetime.utcnow()
            db.commit()
            db.refresh(row)
            _cache_invalidate_user(access_context.user_id)
            return cls._row_to_response(row)
        payload = _dump_model(data, exclude_none=True)
        resp = _request_json(
            "PATCH",
            f"/internal/api/memories/records/{memory_id}",
            access=access_context,
            json_body=payload,
        )
        if resp is None:
            return None
        _cache_invalidate_user(access_context.user_id)
        if resp is None:
            # 404/204/empty body -> _request_json returns None; guard like the sibling
            # get/list/update/delete methods so the caller gets a catchable
            # MemoryServiceError instead of an opaque pydantic ValidationError (HTTP 500).
            raise MemoryServiceError("create/upsert memory returned no record (None response)")
        return MemoryResponse.model_validate(resp)

    @classmethod
    def delete_memory_record(
        cls,
        db: Any = None,
        *,
        access_context: MemoryAccessContext,
        memory_id: int,
    ) -> bool:
        if cls._should_use_local_db(db):
            row = cls._local_lookup_record(
                db,
                access_context=access_context,
                memory_id=memory_id,
            )
            if row is None:
                return False
            db.delete(row)
            db.commit()
            _cache_invalidate_user(access_context.user_id)
            return True
        resp = _request_json(
            "DELETE",
            f"/internal/api/memories/records/{memory_id}",
            access=access_context,
        )
        if resp is None:
            return False
        _cache_invalidate_user(access_context.user_id)
        return True

    @classmethod
    def build_runtime_context(
        cls,
        db: Any = None,
        *,
        access_context: MemoryAccessContext,
        query: Optional[RuntimeMemoryQuery] = None,
    ) -> DurableMemoryPromptContext:
        query = query or RuntimeMemoryQuery()
        cache_key = _runtime_context_cache_key(access_context, query)
        cached = _cache_get(cache_key)
        if cached is not None:
            return cached
        if cls._should_use_local_db(db):
            ctx = cls._local_runtime_context(
                db,
                access_context=access_context,
                query=query,
            )
            _cache_set(cache_key, ctx)
            return ctx
        try:
            resp = _request_json(
                "POST",
                "/internal/api/memories/runtime-context",
                access=access_context,
                json_body=_dump_model(query),
            )
        except MemoryServiceError as exc:
            logger.warning("[Memory] runtime-context fallback to empty: %s", exc)
            return DurableMemoryPromptContext()

        if resp is None:
            return DurableMemoryPromptContext()
        ctx = DurableMemoryPromptContext.model_validate(resp)
        _cache_set(cache_key, ctx)
        return ctx

    # =========================
    # 简化 user-scope 入口（前端 /api/memories 也能用）
    # =========================

    @classmethod
    def create_memory(cls, db: Any, user_id: str, data: MemoryCreate) -> MemoryResponse:
        access = MemoryAccessContext(user_id=user_id)
        if not data.scope_id:
            data = data.model_copy(
                update={"scope_level": MemoryScopeLevel.USER.value, "scope_id": user_id}
            )
        return cls.create_memory_record(db, access_context=access, data=data)

    @classmethod
    def get_memory(
        cls, db: Any, user_id: str, memory_id: int
    ) -> Optional[MemoryResponse]:
        return cls.get_memory_record(
            db,
            access_context=MemoryAccessContext(user_id=user_id), memory_id=memory_id
        )

    @classmethod
    def list_memories(
        cls,
        db: Any,
        user_id: str,
        memory_type: Optional[str] = None,
        offset: int = 0,
        limit: int = 50,
    ) -> MemoryListResponse:
        kinds: Optional[List[str]] = (
            [cls._map_memory_kind(memory_type)] if memory_type else None
        )
        return cls.list_memory_records(
            db,
            access_context=MemoryAccessContext(user_id=user_id),
            query=MemoryQuery(
                scope_levels=[MemoryScopeLevel.USER.value],
                scope_ids=[user_id],
                memory_kinds=kinds,
                offset=offset,
                limit=limit,
            ),
        )

    @classmethod
    def update_memory(
        cls,
        db: Any,
        user_id: str,
        memory_id: int,
        data: MemoryUpdate,
    ) -> Optional[MemoryResponse]:
        return cls.update_memory_record(
            db,
            access_context=MemoryAccessContext(user_id=user_id),
            memory_id=memory_id,
            data=data,
        )

    @classmethod
    def delete_memory(cls, db: Any, user_id: str, memory_id: int) -> bool:
        return cls.delete_memory_record(
            db,
            access_context=MemoryAccessContext(user_id=user_id),
            memory_id=memory_id,
        )

    @classmethod
    def upsert_memory(
        cls,
        db: Any,
        user_id: str,
        memory_type: str,
        key: str,
        value: Any,
        source: str = "agent",
    ) -> MemoryResponse:
        return cls.upsert_memory_record(
            db,
            access_context=MemoryAccessContext(user_id=user_id),
            data=MemoryCreate(
                scope_level=MemoryScopeLevel.USER.value,
                scope_id=user_id,
                memory_kind=cls._map_memory_kind(memory_type),
                memory_type=memory_type,
                key=key,
                value=value,
                source=source,
            ),
        )

    # 老 get_prompt_context —— 现在不直接支持，退化返回空
    @classmethod
    def get_prompt_context(cls, db: Any, user_id: str) -> MemoryPromptContext:
        try:
            lst = cls.list_memories(db, user_id, memory_type=None, offset=0, limit=100)
        except MemoryServiceError:
            return MemoryPromptContext()
        entities: List[Dict[str, Any]] = []
        preferences: List[Dict[str, Any]] = []
        for mem in lst.memories or lst.items or []:
            payload = {"key": mem.key, "value": mem.value, "source": mem.source}
            if mem.memory_type == "preference":
                preferences.append(payload)
            else:
                entities.append(payload)
        return MemoryPromptContext(entities=entities, preferences=preferences)


def _dump_model(model: Any, *, exclude_none: bool = False) -> Dict[str, Any]:
    if hasattr(model, "model_dump"):
        return model.model_dump(exclude_none=exclude_none)
    return dict(model)  # 兜底


# 保持旧的 DurableMemoryPromptItem 可被 import（给可能的 isinstance 检查用）
__all__ = [
    "MemoryService",
    "MemoryServiceError",
    "MemoryAccessError",
    "MemoryValidationError",
    "RuntimeMemoryQuery",
    "DurableMemoryPromptContext",
    "DurableMemoryPromptItem",
]
