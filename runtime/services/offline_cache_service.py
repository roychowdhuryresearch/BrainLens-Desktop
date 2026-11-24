"""
Offline Knowledge Cache - 离线知识缓存

当文档/知识库 MCP 不可用时降级使用本地缓存。
缓存最近 N 次搜索结果 + 高频文档快照。

使用方式::

    cache = get_offline_cache_service()
    cache.cache_search_result("错误码", results=[...])
    cache.cache_document("ns/slug", content="...")
    # 断网时
    cached = cache.get_cached_search("错误码")
    doc = cache.get_cached_document("ns/slug")
"""

import logging
import time
from collections import OrderedDict
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

_DEFAULT_MAX_SEARCH_CACHE = 200
_DEFAULT_MAX_DOC_CACHE = 100
_DEFAULT_TTL_SECONDS = 86400  # 24 小时


class OfflineCacheService:
    """离线知识缓存服务（LRU + TTL）。"""

    def __init__(
        self,
        max_search_entries: int = _DEFAULT_MAX_SEARCH_CACHE,
        max_doc_entries: int = _DEFAULT_MAX_DOC_CACHE,
        ttl_seconds: int = _DEFAULT_TTL_SECONDS,
    ) -> None:
        self._max_search = max_search_entries
        self._max_doc = max_doc_entries
        self._ttl = ttl_seconds
        # LRU: {query_key: (timestamp, results)}
        self._search_cache: OrderedDict[str, tuple] = OrderedDict()
        # LRU: {doc_key: (timestamp, content)}
        self._doc_cache: OrderedDict[str, tuple] = OrderedDict()

    def _is_fresh(self, timestamp: float) -> bool:
        return time.time() - timestamp < self._ttl

    # ------------------------------------------------------------------
    # Search cache
    # ------------------------------------------------------------------

    def cache_search_result(
        self, query: str, results: List[Dict[str, Any]],
    ) -> None:
        """缓存搜索结果。"""
        key = query.strip().lower()
        if not key:
            return
        self._search_cache[key] = (time.time(), list(results))
        self._search_cache.move_to_end(key)
        while len(self._search_cache) > self._max_search:
            self._search_cache.popitem(last=False)

    def get_cached_search(self, query: str) -> Optional[List[Dict[str, Any]]]:
        """获取缓存的搜索结果（TTL 内有效）。"""
        key = query.strip().lower()
        entry = self._search_cache.get(key)
        if entry is None:
            return None
        ts, results = entry
        if not self._is_fresh(ts):
            del self._search_cache[key]
            return None
        self._search_cache.move_to_end(key)
        return results

    # ------------------------------------------------------------------
    # Document cache
    # ------------------------------------------------------------------

    def cache_document(
        self, doc_key: str, content: str,
    ) -> None:
        """缓存文档内容。doc_key 格式如 'namespace/slug'。"""
        if not doc_key:
            return
        self._doc_cache[doc_key] = (time.time(), content)
        self._doc_cache.move_to_end(doc_key)
        while len(self._doc_cache) > self._max_doc:
            self._doc_cache.popitem(last=False)

    def get_cached_document(self, doc_key: str) -> Optional[str]:
        """获取缓存的文档内容。"""
        entry = self._doc_cache.get(doc_key)
        if entry is None:
            return None
        ts, content = entry
        if not self._is_fresh(ts):
            del self._doc_cache[doc_key]
            return None
        self._doc_cache.move_to_end(doc_key)
        return content

    # ------------------------------------------------------------------
    # Management
    # ------------------------------------------------------------------

    def clear_all(self) -> None:
        self._search_cache.clear()
        self._doc_cache.clear()

    def stats(self) -> Dict[str, Any]:
        return {
            "search_entries": len(self._search_cache),
            "doc_entries": len(self._doc_cache),
            "max_search": self._max_search,
            "max_doc": self._max_doc,
            "ttl_seconds": self._ttl,
        }


_offline_cache: Optional[OfflineCacheService] = None


def get_offline_cache_service() -> OfflineCacheService:
    global _offline_cache
    if _offline_cache is None:
        _offline_cache = OfflineCacheService()
    return _offline_cache
