"""Backend Memory HTTP Client (agent-side).

Agent 跑 runtime 时通过这个 client 访问 backend 的 `/internal/api/memories/*`。
替代原来 agent 本地 SQLite (`durable_memories`) + `MemoryService`。

特性：
- 单例 httpx.AsyncClient，全局复用连接池
- bearer token 鉴权（env var AGENT_BACKEND_TOKEN）
- 30s TTL in-memory cache（key: (user_id, target, limit_per_bucket)），抹平单 turn 内多次查询
- 每次请求带身份 header：X-User-Id / X-Tenant-Id / X-Team-Ids / X-Permissions
- httpx 超时严格（connect=5s, read=10s, write=5s）：backend 挂了也不拖 agent
- 所有公开方法 async；失败抛 BackendMemoryError，上层 runtime 可以兜底空上下文继续
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any, Dict, List, Optional

import httpx
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

_DEFAULT_BACKEND_URL = "http://127.0.0.1:8000"
_CACHE_TTL_SECONDS = 30.0


class BackendMemoryError(RuntimeError):
    """调 backend memory API 失败。上层应降级为空上下文继续，不应抛到用户。"""


# =========================
# 数据类（镜像 backend 响应 shape；避免跨服务 import）
# =========================


class MemoryPromptItem(BaseModel):
    id: int
    scope_level: str
    memory_kind: str
    key: str
    title: Optional[str] = None
    summary: Optional[str] = None
    value: Any = None
    tags: List[str] = Field(default_factory=list)


class DurableMemoryPromptContext(BaseModel):
    user_preferences: List[MemoryPromptItem] = Field(default_factory=list)
    user_context_memories: List[MemoryPromptItem] = Field(default_factory=list)
    team_memories: List[MemoryPromptItem] = Field(default_factory=list)
    company_memories: List[MemoryPromptItem] = Field(default_factory=list)

    def is_empty(self) -> bool:
        return not (
            self.user_preferences
            or self.user_context_memories
            or self.team_memories
            or self.company_memories
        )


class MemoryRecord(BaseModel):
    id: int
    scope_level: str
    scope_id: str
    user_id: Optional[str] = None
    tenant_id: Optional[str] = None
    team_id: Optional[str] = None
    owner_user_id: Optional[str] = None
    memory_kind: str
    memory_type: str
    namespace: str
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
    status: str = "active"
    access_count: int = 0
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class MemoryAccess(BaseModel):
    """用来转成 header 传给 backend。"""

    user_id: str
    tenant_id: Optional[str] = None
    team_ids: List[str] = Field(default_factory=list)
    permissions: List[str] = Field(default_factory=list)

    def to_headers(self) -> Dict[str, str]:
        headers: Dict[str, str] = {"X-User-Id": self.user_id}
        if self.tenant_id:
            headers["X-Tenant-Id"] = self.tenant_id
        if self.team_ids:
            headers["X-Team-Ids"] = ",".join(self.team_ids)
        if self.permissions:
            headers["X-Permissions"] = ",".join(self.permissions)
        return headers


# =========================
# Client
# =========================


def _backend_url() -> str:
    return (os.environ.get("BACKEND_INTERNAL_URL") or _DEFAULT_BACKEND_URL).rstrip("/")


def _auth_header() -> Dict[str, str]:
    token = os.environ.get("AGENT_BACKEND_TOKEN", "").strip()
    if not token:
        raise BackendMemoryError("Set AGENT_BACKEND_TOKEN to access the memory backend")
    return {"Authorization": f"Bearer {token}"}


class _RuntimeCache:
    """30s TTL，进程级单例；单个 turn 内查多次不重复打 backend。"""

    def __init__(self, ttl: float = _CACHE_TTL_SECONDS) -> None:
        self._ttl = ttl
        self._store: Dict[tuple, tuple[float, DurableMemoryPromptContext]] = {}
        self._lock = asyncio.Lock()

    async def get(self, key: tuple) -> Optional[DurableMemoryPromptContext]:
        async with self._lock:
            entry = self._store.get(key)
            if not entry:
                return None
            exp, ctx = entry
            if time.time() > exp:
                self._store.pop(key, None)
                return None
            return ctx

    async def set(self, key: tuple, value: DurableMemoryPromptContext) -> None:
        async with self._lock:
            self._store[key] = (time.time() + self._ttl, value)

    async def invalidate(self, user_id: str) -> None:
        """任何写入后，把涉及该 user 的 cache 清掉。"""
        async with self._lock:
            keys_to_drop = [k for k in self._store if k and k[0] == user_id]
            for k in keys_to_drop:
                self._store.pop(k, None)


class BackendMemoryClient:
    """单例 HTTP client。用 `get_client()` 拿实例。"""

    _instance: Optional["BackendMemoryClient"] = None

    def __init__(self) -> None:
        self._http = httpx.AsyncClient(
            base_url=_backend_url(),
            timeout=httpx.Timeout(connect=5.0, read=10.0, write=5.0, pool=5.0),
            limits=httpx.Limits(max_connections=50, max_keepalive_connections=20),
            trust_env=False,
        )
        self._cache = _RuntimeCache()

    async def close(self) -> None:
        try:
            await self._http.aclose()
        except Exception:
            pass

    # ----- context build -----

    async def get_runtime_context(
        self,
        access: MemoryAccess,
        *,
        target: str = "bootstrap",
        user_message: str = "",
        limit_per_bucket: int = 4,
        include_preferences: bool = True,
        include_user_context_memories: bool = True,
        include_team_memories: bool = True,
        include_company_memories: bool = True,
    ) -> DurableMemoryPromptContext:
        cache_key = (access.user_id, target, int(limit_per_bucket))
        cached = await self._cache.get(cache_key)
        if cached is not None:
            return cached

        body: Dict[str, Any] = {
            "user_message": user_message,
            "target": target,
            "include_preferences": include_preferences,
            "include_user_context_memories": include_user_context_memories,
            "include_team_memories": include_team_memories,
            "include_company_memories": include_company_memories,
            "limit_per_bucket": limit_per_bucket,
        }
        try:
            resp = await self._post_json("/internal/api/memories/runtime-context", access, body)
        except BackendMemoryError as exc:
            logger.warning(
                "[BackendMemory] runtime-context failed; returning empty context: %s", exc
            )
            return DurableMemoryPromptContext()

        ctx = DurableMemoryPromptContext.model_validate(resp)
        await self._cache.set(cache_key, ctx)
        return ctx

    # ----- CRUD -----

    async def create(self, access: MemoryAccess, payload: Dict[str, Any]) -> MemoryRecord:
        data = await self._post_json("/internal/api/memories/records", access, payload)
        await self._cache.invalidate(access.user_id)
        return MemoryRecord.model_validate(data)

    async def upsert(self, access: MemoryAccess, payload: Dict[str, Any]) -> MemoryRecord:
        data = await self._post_json(
            "/internal/api/memories/records/upsert", access, payload
        )
        await self._cache.invalidate(access.user_id)
        return MemoryRecord.model_validate(data)

    async def get(self, access: MemoryAccess, memory_id: int) -> Optional[MemoryRecord]:
        try:
            data = await self._get_json(
                f"/internal/api/memories/records/{memory_id}", access
            )
        except BackendMemoryError as exc:
            if "404" in str(exc):
                return None
            raise
        return MemoryRecord.model_validate(data)

    async def query(self, access: MemoryAccess, query: Dict[str, Any]) -> Dict[str, Any]:
        return await self._post_json("/internal/api/memories/query", access, query)

    async def update(
        self, access: MemoryAccess, memory_id: int, patch: Dict[str, Any]
    ) -> MemoryRecord:
        data = await self._request_json(
            "PATCH", f"/internal/api/memories/records/{memory_id}", access, json=patch
        )
        await self._cache.invalidate(access.user_id)
        return MemoryRecord.model_validate(data)

    async def delete(self, access: MemoryAccess, memory_id: int) -> bool:
        try:
            await self._request_json(
                "DELETE", f"/internal/api/memories/records/{memory_id}", access
            )
        except BackendMemoryError as exc:
            if "404" in str(exc):
                return False
            raise
        await self._cache.invalidate(access.user_id)
        return True

    # ----- low-level -----

    async def _post_json(
        self, path: str, access: MemoryAccess, body: Dict[str, Any]
    ) -> Any:
        return await self._request_json("POST", path, access, json=body)

    async def _get_json(self, path: str, access: MemoryAccess) -> Any:
        return await self._request_json("GET", path, access)

    async def _request_json(
        self,
        method: str,
        path: str,
        access: MemoryAccess,
        *,
        json: Optional[Dict[str, Any]] = None,
    ) -> Any:
        headers = {**access.to_headers(), **_auth_header()}
        try:
            resp = await self._http.request(method, path, headers=headers, json=json)
        except httpx.TimeoutException as exc:
            raise BackendMemoryError(f"timeout calling {method} {path}: {exc}") from exc
        except httpx.RequestError as exc:
            raise BackendMemoryError(f"network error calling {method} {path}: {exc}") from exc

        if resp.status_code >= 400:
            raise BackendMemoryError(
                f"{resp.status_code} calling {method} {path}: {resp.text[:200]}"
            )
        try:
            return resp.json()
        except Exception as exc:
            raise BackendMemoryError(f"invalid json from {method} {path}: {exc}") from exc


_instance_lock = asyncio.Lock()
_instance: Optional[BackendMemoryClient] = None


async def get_client() -> BackendMemoryClient:
    global _instance
    if _instance is None:
        async with _instance_lock:
            if _instance is None:
                _instance = BackendMemoryClient()
    return _instance


async def close_client() -> None:
    global _instance
    if _instance is not None:
        await _instance.close()
        _instance = None
